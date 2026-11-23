//! Node `path` semantics (posix and win32 flavours) over plain strings.
//!
//! The TS code can swap in `path.posix` / `path.win32` while discovering data
//! roots for another platform, so `std::path` (host-flavoured only) is not
//! enough. Everything here works on `&str` / `String`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathFlavor {
    Posix,
    Win32,
}

impl PathFlavor {
    /// Flavour of the machine we are running on.
    pub fn host() -> PathFlavor {
        if cfg!(windows) {
            PathFlavor::Win32
        } else {
            PathFlavor::Posix
        }
    }

    pub fn sep(self) -> char {
        match self {
            PathFlavor::Posix => '/',
            PathFlavor::Win32 => '\\',
        }
    }

    pub fn delimiter(self) -> char {
        match self {
            PathFlavor::Posix => ':',
            PathFlavor::Win32 => ';',
        }
    }

    fn is_sep(self, c: char) -> bool {
        match self {
            PathFlavor::Posix => c == '/',
            PathFlavor::Win32 => c == '/' || c == '\\',
        }
    }

    /// Node's `normalizeString`.
    fn normalize_string(self, path: &str, allow_above_root: bool) -> String {
        let sep = self.sep();
        let mut res: Vec<&str> = Vec::new();
        // Parts are compared as segments; leading ".." entries are kept as-is.
        for seg in path.split(|c| self.is_sep(c)) {
            match seg {
                "" | "." => {}
                ".." => {
                    if let Some(last) = res.last() {
                        if *last != ".." {
                            res.pop();
                            continue;
                        }
                    }
                    if allow_above_root {
                        res.push("..");
                    }
                }
                other => res.push(other),
            }
        }
        res.join(&sep.to_string())
    }

    /// (device, is_absolute, root_end) of a win32 path; for posix device is "".
    fn root_info(self, p: &str) -> (String, bool, usize) {
        match self {
            PathFlavor::Posix => {
                if p.starts_with('/') {
                    (String::new(), true, 1)
                } else {
                    (String::new(), false, 0)
                }
            }
            PathFlavor::Win32 => {
                let chars: Vec<char> = p.chars().collect();
                let n = chars.len();
                if n == 0 {
                    return (String::new(), false, 0);
                }
                let is_sep = |c: char| c == '/' || c == '\\';
                let mut root_end = 0usize;
                let mut device = String::new();
                let mut absolute = false;
                if is_sep(chars[0]) {
                    absolute = true;
                    root_end = 1;
                    if n > 1 && is_sep(chars[1]) {
                        // UNC: \\server\share
                        let mut j = 2;
                        let mut last = j;
                        while j < n && !is_sep(chars[j]) {
                            j += 1;
                        }
                        if j < n && j != last {
                            let first_part: String = chars[last..j].iter().collect();
                            last = j;
                            while j < n && is_sep(chars[j]) {
                                j += 1;
                            }
                            if j < n && j != last {
                                last = j;
                                while j < n && !is_sep(chars[j]) {
                                    j += 1;
                                }
                                if j == n {
                                    device = format!(
                                        "\\\\{}\\{}",
                                        first_part,
                                        chars[last..].iter().collect::<String>()
                                    );
                                    root_end = j;
                                } else if j != last {
                                    device = format!(
                                        "\\\\{}\\{}",
                                        first_part,
                                        chars[last..j].iter().collect::<String>()
                                    );
                                    root_end = j;
                                }
                            }
                        }
                    }
                } else if n > 1 && chars[0].is_ascii_alphabetic() && chars[1] == ':' {
                    device = chars[0..2].iter().collect();
                    root_end = 2;
                    if n > 2 && is_sep(chars[2]) {
                        absolute = true;
                        root_end = 3;
                    }
                }
                (device, absolute, root_end)
            }
        }
    }

    pub fn is_absolute(self, p: &str) -> bool {
        match self {
            PathFlavor::Posix => p.starts_with('/'),
            PathFlavor::Win32 => {
                let c: Vec<char> = p.chars().take(3).collect();
                if c.is_empty() {
                    return false;
                }
                if c[0] == '/' || c[0] == '\\' {
                    return true;
                }
                c.len() > 2 && c[0].is_ascii_alphabetic() && c[1] == ':' && (c[2] == '/' || c[2] == '\\')
            }
        }
    }

    pub fn normalize(self, p: &str) -> String {
        if p.is_empty() {
            return ".".to_string();
        }
        let sep = self.sep();
        let (device, absolute, root_end) = self.root_info(p);
        let rest: String = if self == PathFlavor::Posix {
            p.chars().skip(root_end).collect()
        } else {
            p.chars().skip(root_end).collect()
        };
        let mut tail = self.normalize_string(&rest, !absolute);
        if tail.is_empty() && !absolute {
            tail = ".".to_string();
        }
        if !tail.is_empty() && p.chars().last().map_or(false, |c| self.is_sep(c)) {
            tail.push(sep);
        }
        match self {
            PathFlavor::Posix => {
                if absolute {
                    format!("/{}", tail)
                } else {
                    tail
                }
            }
            PathFlavor::Win32 => {
                if device.is_empty() {
                    if absolute {
                        format!("\\{}", tail)
                    } else {
                        tail
                    }
                } else if absolute {
                    format!("{}\\{}", device, tail)
                } else {
                    format!("{}{}", device, tail)
                }
            }
        }
    }

    pub fn join<S: AsRef<str>>(self, parts: &[S]) -> String {
        let mut joined = String::new();
        for p in parts {
            let p = p.as_ref();
            if p.is_empty() {
                continue;
            }
            if joined.is_empty() {
                joined.push_str(p);
            } else {
                joined.push(self.sep());
                joined.push_str(p);
            }
        }
        if joined.is_empty() {
            return ".".to_string();
        }
        if self == PathFlavor::Win32 {
            // Avoid turning a lone `\\server` join into a UNC path by accident:
            // node collapses leading separators unless the first part is UNC.
            let first = parts.iter().map(|s| s.as_ref()).find(|s| !s.is_empty()).unwrap_or("");
            let fc: Vec<char> = first.chars().collect();
            let mut needs_replace = true;
            let mut slash_count = 0;
            if !fc.is_empty() && (fc[0] == '/' || fc[0] == '\\') {
                slash_count += 1;
                let first_len = fc.len();
                if first_len > 1 && (fc[1] == '/' || fc[1] == '\\') {
                    slash_count += 1;
                    if first_len > 2 {
                        if fc[2] == '/' || fc[2] == '\\' {
                            slash_count += 1;
                        } else {
                            needs_replace = false;
                        }
                    }
                }
            }
            if needs_replace {
                let jc: Vec<char> = joined.chars().collect();
                let mut idx = 0;
                while idx < jc.len() && (jc[idx] == '/' || jc[idx] == '\\') {
                    idx += 1;
                }
                if idx >= 2 {
                    joined = format!("\\{}", jc[idx..].iter().collect::<String>());
                }
                let _ = slash_count;
            }
        }
        self.normalize(&joined)
    }

    pub fn resolve<S: AsRef<str>>(self, parts: &[S]) -> String {
        match self {
            PathFlavor::Posix => {
                let mut resolved = String::new();
                let mut absolute = false;
                let mut i = parts.len() as isize - 1;
                while i >= -1 && !absolute {
                    let path: String = if i >= 0 {
                        parts[i as usize].as_ref().to_string()
                    } else {
                        host_cwd(self)
                    };
                    i -= 1;
                    if path.is_empty() {
                        continue;
                    }
                    resolved = format!("{}/{}", path, resolved);
                    absolute = path.starts_with('/');
                }
                let tail = self.normalize_string(&resolved, !absolute);
                if absolute {
                    format!("/{}", tail)
                } else if tail.is_empty() {
                    ".".to_string()
                } else {
                    tail
                }
            }
            PathFlavor::Win32 => {
                let mut resolved_device = String::new();
                let mut resolved_tail = String::new();
                let mut resolved_abs = false;
                let mut i = parts.len() as isize - 1;
                while i >= -1 {
                    let path: String = if i >= 0 {
                        parts[i as usize].as_ref().to_string()
                    } else if resolved_device.is_empty() {
                        host_cwd(self)
                    } else {
                        // drive-relative with no env: assume the drive root
                        format!("{}\\", resolved_device)
                    };
                    i -= 1;
                    if path.is_empty() {
                        continue;
                    }
                    let (device, absolute, root_end) = self.root_info(&path);
                    if !device.is_empty()
                        && !resolved_device.is_empty()
                        && device.to_lowercase() != resolved_device.to_lowercase()
                    {
                        continue;
                    }
                    if resolved_device.is_empty() && !device.is_empty() {
                        resolved_device = device;
                    }
                    if !resolved_abs {
                        let rest: String = path.chars().skip(root_end).collect();
                        resolved_tail = format!("{}\\{}", rest, resolved_tail);
                        resolved_abs = absolute;
                    }
                    if resolved_abs && !resolved_device.is_empty() {
                        break;
                    }
                }
                let tail = self.normalize_string(&resolved_tail, !resolved_abs);
                if resolved_abs {
                    format!("{}\\{}", resolved_device, tail)
                } else {
                    let r = format!("{}{}", resolved_device, tail);
                    if r.is_empty() {
                        ".".to_string()
                    } else {
                        r
                    }
                }
            }
        }
    }

    pub fn dirname(self, p: &str) -> String {
        if p.is_empty() {
            return ".".to_string();
        }
        let chars: Vec<char> = p.chars().collect();
        let len = chars.len();
        let (_, _, root_end) = self.root_info(p);
        // For posix, the root is "/" (root_end 1); win32 may be 0..=n.
        let has_root = root_end > 0;
        let offset = root_end.min(len);
        let mut end: Option<usize> = None;
        let mut matched = true;
        let mut i = len as isize - 1;
        while i >= offset as isize {
            let c = chars[i as usize];
            if self.is_sep(c) {
                if !matched {
                    end = Some(i as usize);
                    break;
                }
            } else {
                matched = false;
            }
            i -= 1;
        }
        match end {
            None => {
                if has_root {
                    chars[..offset].iter().collect()
                } else {
                    ".".to_string()
                }
            }
            Some(e) => {
                if self == PathFlavor::Posix && has_root && e == 0 {
                    "/".to_string()
                } else if e < offset {
                    chars[..offset].iter().collect()
                } else {
                    chars[..e].iter().collect()
                }
            }
        }
    }

    pub fn basename(self, p: &str) -> String {
        self.basename_ext(p, None)
    }

    pub fn basename_ext(self, p: &str, ext: Option<&str>) -> String {
        let chars: Vec<char> = p.chars().collect();
        let mut start = 0usize;
        if self == PathFlavor::Win32
            && chars.len() >= 2
            && chars[0].is_ascii_alphabetic()
            && chars[1] == ':'
        {
            start = 2;
        }
        let mut end = chars.len();
        while end > start && self.is_sep(chars[end - 1]) {
            end -= 1;
        }
        let mut s = start;
        for k in (start..end).rev() {
            if self.is_sep(chars[k]) {
                s = k + 1;
                break;
            }
        }
        let name: String = chars[s..end].iter().collect();
        if let Some(e) = ext {
            if !e.is_empty() && name != e && name.ends_with(e) {
                return name[..name.len() - e.len()].to_string();
            }
        }
        name
    }

    pub fn extname(self, p: &str) -> String {
        let base = self.basename(p);
        match base.rfind('.') {
            None | Some(0) => String::new(),
            Some(i) => {
                if base == ".." {
                    String::new()
                } else {
                    base[i..].to_string()
                }
            }
        }
    }

    pub fn relative(self, from: &str, to: &str) -> String {
        if from == to {
            return String::new();
        }
        let f = self.resolve(&[from]);
        let t = self.resolve(&[to]);
        let eq = |a: &str, b: &str| {
            if self == PathFlavor::Win32 {
                a.to_lowercase() == b.to_lowercase()
            } else {
                a == b
            }
        };
        if eq(&f, &t) {
            return String::new();
        }
        let segs = |s: &str| -> Vec<String> {
            s.split(|c| self.is_sep(c))
                .filter(|x| !x.is_empty())
                .map(|x| x.to_string())
                .collect()
        };
        let fs = segs(&f);
        let ts = segs(&t);
        if self == PathFlavor::Win32 {
            // Different drive / UNC share: no relative path exists.
            let fd = fs.first().map(|s| s.to_lowercase());
            let td = ts.first().map(|s| s.to_lowercase());
            if fd != td {
                return t;
            }
        }
        let mut common = 0;
        while common < fs.len() && common < ts.len() && eq(&fs[common], &ts[common]) {
            common += 1;
        }
        let mut out: Vec<String> = Vec::new();
        for _ in common..fs.len() {
            out.push("..".to_string());
        }
        for s in &ts[common..] {
            out.push(s.clone());
        }
        out.join(&self.sep().to_string())
    }
}

fn host_cwd(flavor: PathFlavor) -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    if cwd.is_empty() {
        return match flavor {
            PathFlavor::Posix => "/".to_string(),
            PathFlavor::Win32 => "C:\\".to_string(),
        };
    }
    let host = PathFlavor::host();
    if host == flavor {
        // strip verbatim prefix if any
        return cwd.strip_prefix("\\\\?\\").map(|s| s.to_string()).unwrap_or(cwd);
    }
    match flavor {
        PathFlavor::Posix => "/".to_string(),
        PathFlavor::Win32 => "C:\\".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use PathFlavor::*;

    #[test]
    fn join_posix() {
        assert_eq!(Posix.join(&["/home/u", ".config", "x"]), "/home/u/.config/x");
        assert_eq!(Posix.join(&["a", "..", "b"]), "b");
        assert_eq!(Posix.join(&["", ""]), ".");
        assert_eq!(Posix.join(&["/a/", "b/"]), "/a/b/");
    }

    #[test]
    fn join_win32() {
        assert_eq!(Win32.join(&["C:\\Users\\u", "AppData", "Local"]), "C:\\Users\\u\\AppData\\Local");
        assert_eq!(Win32.join(&["C:/Users/u", "x"]), "C:\\Users\\u\\x");
        assert_eq!(Win32.join(&["\\\\srv\\share", "a"]), "\\\\srv\\share\\a");
    }

    #[test]
    fn dirname_basename() {
        assert_eq!(Posix.dirname("/a/b/c.txt"), "/a/b");
        assert_eq!(Posix.dirname("/a"), "/");
        assert_eq!(Posix.dirname("a"), ".");
        assert_eq!(Win32.dirname("C:\\a\\b"), "C:\\a");
        assert_eq!(Win32.dirname("C:\\a"), "C:\\");
        assert_eq!(Posix.basename("/a/b/c.txt"), "c.txt");
        assert_eq!(Posix.basename_ext("/a/b/c.txt", Some(".txt")), "c");
        assert_eq!(Posix.extname("/a/b/c.tar.gz"), ".gz");
        assert_eq!(Posix.extname("/a/.bashrc"), "");
    }

    #[test]
    fn resolve_relative() {
        assert_eq!(Posix.resolve(&["/a/b", "../c"]), "/a/c");
        assert_eq!(Posix.relative("/a/b", "/a/c/d"), "../c/d");
        assert_eq!(Win32.resolve(&["C:\\a\\b", "..\\c"]), "C:\\a\\c");
        assert_eq!(Win32.relative("C:\\a\\b", "C:\\A\\b\\x"), "x");
    }
}
