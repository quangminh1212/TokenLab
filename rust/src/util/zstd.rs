//! Zstandard frame scanning + multi-frame decompression (port of util.ts).

use anyhow::{anyhow, Result};
use std::io::Read;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ZstdFrameRange {
    pub start: usize,
    pub end: usize,
}

const ZSTD_MAGIC: u32 = 0xfd2f_b528;

/// Find complete frames in a possibly concatenated Zstandard stream.
pub fn scan_zstd_frames(buffer: &[u8]) -> Result<Vec<ZstdFrameRange>> {
    let mut frames = Vec::new();
    let mut offset = 0usize;
    let len = buffer.len();

    while offset < len {
        let start = offset;
        if len - offset < 4 {
            break;
        }
        let magic = u32::from_le_bytes([
            buffer[offset],
            buffer[offset + 1],
            buffer[offset + 2],
            buffer[offset + 3],
        ]);
        if magic != ZSTD_MAGIC {
            return Err(anyhow!("Invalid Zstandard frame at byte {}", offset));
        }
        offset += 4;
        if offset == len {
            break;
        }

        let descriptor = buffer[offset];
        offset += 1;
        if descriptor & 0x18 != 0 {
            return Err(anyhow!("Invalid Zstandard frame header at byte {}", offset - 1));
        }
        let content_size_flag = descriptor >> 6;
        let single_segment = descriptor & 0x20 != 0;
        let has_checksum = descriptor & 0x04 != 0;
        let dictionary_flag = descriptor & 0x03;
        let dictionary_bytes = if dictionary_flag == 3 { 4 } else { dictionary_flag as usize };
        let content_size_bytes = if content_size_flag == 0 {
            if single_segment {
                1
            } else {
                0
            }
        } else {
            1usize << content_size_flag
        };
        let frame_header_bytes = (if single_segment { 0 } else { 1 }) + dictionary_bytes + content_size_bytes;
        if len - offset < frame_header_bytes {
            break;
        }
        offset += frame_header_bytes;

        let mut complete = false;
        while !complete {
            if len - offset < 3 {
                return Ok(frames);
            }
            let block_header = buffer[offset] as u32
                | (buffer[offset + 1] as u32) << 8
                | (buffer[offset + 2] as u32) << 16;
            offset += 3;
            let is_last = block_header & 1 != 0;
            let block_type = (block_header >> 1) & 0x03;
            let block_size = (block_header >> 3) as usize;
            if block_type == 0x03 {
                return Err(anyhow!("Invalid Zstandard block at byte {}", offset - 3));
            }
            let payload = if block_type == 0x01 { 1 } else { block_size };
            if len - offset < payload {
                return Ok(frames);
            }
            offset += payload;
            complete = is_last;
        }

        if has_checksum {
            if len - offset < 4 {
                return Ok(frames);
            }
            offset += 4;
        }
        frames.push(ZstdFrameRange { start, end: offset });
    }

    Ok(frames)
}

/// Decompress every complete frame (one output buffer per frame).
pub fn decompress_zstd_frames(buffer: &[u8]) -> Result<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    for ZstdFrameRange { start, end } in scan_zstd_frames(buffer)? {
        let mut decoder = ruzstd::decoding::StreamingDecoder::new(&buffer[start..end])
            .map_err(|e| anyhow!("zstd: {e}"))?;
        let mut v = Vec::new();
        decoder.read_to_end(&mut v).map_err(|e| anyhow!("zstd: {e}"))?;
        out.push(v);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_magic() {
        assert!(scan_zstd_frames(&[1, 2, 3, 4, 5]).is_err());
    }

    #[test]
    fn scans_raw_block_frame() {
        // magic, descriptor (single segment, 1-byte content size), size, raw last block "hi"
        let mut f = vec![0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x02];
        let hdr: u32 = 1 | (0 << 1) | (2 << 3);
        f.extend_from_slice(&hdr.to_le_bytes()[..3]);
        f.extend_from_slice(b"hi");
        let frames = scan_zstd_frames(&f).unwrap();
        assert_eq!(frames, vec![ZstdFrameRange { start: 0, end: f.len() }]);
        let out = decompress_zstd_frames(&f).unwrap();
        assert_eq!(out, vec![b"hi".to_vec()]);
    }
}
