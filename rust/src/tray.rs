//! Port of `src/tray.ts`.
//!
//! System tray icon while serve is running.
//! Windows: in-process native Win32 notification icon (`Shell_NotifyIconW`) on a
//! dedicated small-stack thread that blocks in `GetMessageW` (zero idle CPU, no
//! child process). Other platforms: no-op (returns `None`).

use crate::autostart::icon_search_dirs;
use crate::util::env_nonempty;
use chrono::{SecondsFormat, Utc};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Handle returned by [`start_tray`]; `stop()` is idempotent.
#[derive(Clone)]
pub struct TrayHandle {
    stop_fn: Arc<dyn Fn() + Send + Sync>,
}

impl TrayHandle {
    pub fn stop(&self) {
        (self.stop_fn)();
    }
}

pub struct TrayOptions {
    pub url: String,
    pub title: Option<String>,
    pub tooltip: Option<String>,
    pub on_quit: Arc<dyn Fn() + Send + Sync>,
}

// ---------------------------------------------------------------------------
// logging to %LOCALAPPDATA%\tokenlab\tray.txt

fn log_dir() -> PathBuf {
    let base = env_nonempty("LOCALAPPDATA")
        .or_else(|| env_nonempty("APPDATA"))
        .unwrap_or_else(crate::util::cwd_string);
    Path::new(&base).join("tokenlab")
}

fn log(message: &str) {
    use std::io::Write;
    let line = format!(
        "[{}] {}",
        Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        message
    );
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("tray.txt"))
        .and_then(|mut f| f.write_all(format!("{line}\r\n").as_bytes()));
}

fn log_error(message: &str) {
    log(&format!("[ERROR] {message}"));
}

// ---------------------------------------------------------------------------
// pure helpers (platform independent, unit-tested)

/// Truncate to at most `max` UTF-16 code units without splitting a surrogate pair.
#[allow(dead_code)]
fn utf16_truncated(s: &str, max: usize) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::with_capacity(max.min(s.len()));
    let mut buf = [0u16; 2];
    for ch in s.chars() {
        let enc = ch.encode_utf16(&mut buf);
        if out.len() + enc.len() > max {
            break;
        }
        out.extend_from_slice(enc);
    }
    out
}

/// Pick the ICO directory entry best matching `target` pixels: the smallest image
/// that is at least `target` wide, else the largest. Returns `(offset, size)`.
#[allow(dead_code)]
fn pick_ico_entry(data: &[u8], target: u32) -> Option<(usize, usize)> {
    if data.len() < 6 || data[0] != 0 || data[1] != 0 || data[2] != 1 || data[3] != 0 {
        return None;
    }
    let count = u16::from_le_bytes([data[4], data[5]]) as usize;
    let mut best: Option<(u32, usize, usize)> = None; // (width, offset, size)
    for i in 0..count {
        let e = data.get(6 + i * 16..6 + i * 16 + 16)?;
        let w = if e[0] == 0 { 256 } else { e[0] as u32 };
        let size = u32::from_le_bytes([e[8], e[9], e[10], e[11]]) as usize;
        let off = u32::from_le_bytes([e[12], e[13], e[14], e[15]]) as usize;
        if size == 0 || off.checked_add(size)? > data.len() {
            continue;
        }
        let better = match best {
            None => true,
            Some((bw, _, _)) => {
                if bw >= target {
                    w >= target && w < bw
                } else {
                    w > bw
                }
            }
        };
        if better {
            best = Some((w, off, size));
        }
    }
    best.map(|(_, o, s)| (o, s))
}

#[cfg(windows)]
fn resolve_icon_bytes() -> Vec<u8> {
    for dir in icon_search_dirs() {
        if let Ok(b) = std::fs::read(dir.join("favicon.ico")) {
            if pick_ico_entry(&b, 16).is_some() {
                return b;
            }
        }
    }
    include_bytes!("../../web/public/assets/favicon.ico").to_vec()
}

// ---------------------------------------------------------------------------
// Windows implementation

#[cfg(windows)]
mod win {
    use super::*;
    use crate::util::open_browser;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
    use std::sync::Mutex;

    const WM_NULL: u32 = 0x0000;
    const WM_DESTROY: u32 = 0x0002;
    const WM_CLOSE: u32 = 0x0010;
    const WM_COMMAND: u32 = 0x0111;
    const WM_LBUTTONUP: u32 = 0x0202;
    const WM_RBUTTONUP: u32 = 0x0205;
    const WM_TRAYICON: u32 = 0x8000 + 1;
    const ID_OPEN: usize = 1;
    const ID_QUIT: usize = 2;
    const NIM_ADD: u32 = 0;
    const NIM_DELETE: u32 = 2;
    const NIF_MESSAGE: u32 = 1;
    const NIF_ICON: u32 = 2;
    const NIF_TIP: u32 = 4;
    const NIF_INFO: u32 = 0x10;
    const NIIF_INFO: u32 = 1;
    const MF_STRING: u32 = 0;
    const MF_SEPARATOR: u32 = 0x800;
    const TPM_RIGHTBUTTON: u32 = 0x2;
    const TPM_BOTTOMALIGN: u32 = 0x20;
    const SM_CXSMICON: i32 = 49;
    const IDI_APPLICATION: usize = 32512;
    const TRAY_UID: u32 = 1;

    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct Msg {
        hwnd: usize,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        pt: Point,
    }

    type WndProc = unsafe extern "system" fn(usize, u32, usize, isize) -> isize;

    #[repr(C)]
    struct WndClassW {
        style: u32,
        wnd_proc: WndProc,
        cls_extra: i32,
        wnd_extra: i32,
        instance: usize,
        icon: usize,
        cursor: usize,
        background: usize,
        menu_name: *const u16,
        class_name: *const u16,
    }

    #[repr(C)]
    struct NotifyIconDataW {
        cb_size: u32,
        hwnd: usize,
        uid: u32,
        flags: u32,
        callback_message: u32,
        icon: usize,
        tip: [u16; 128],
        state: u32,
        state_mask: u32,
        info: [u16; 256],
        timeout_or_version: u32,
        info_title: [u16; 64],
        info_flags: u32,
        guid_item: [u8; 16],
        balloon_icon: usize,
    }

    #[link(name = "user32")]
    extern "system" {
        fn RegisterClassW(wc: *const WndClassW) -> u16;
        fn CreateWindowExW(
            ex_style: u32,
            class_name: *const u16,
            window_name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            w: i32,
            h: i32,
            parent: usize,
            menu: usize,
            instance: usize,
            param: *const c_void,
        ) -> usize;
        fn DefWindowProcW(hwnd: usize, msg: u32, wp: usize, lp: isize) -> isize;
        fn GetMessageW(msg: *mut Msg, hwnd: usize, min: u32, max: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> isize;
        fn PostMessageW(hwnd: usize, msg: u32, wp: usize, lp: isize) -> i32;
        fn PostQuitMessage(code: i32);
        fn DestroyWindow(hwnd: usize) -> i32;
        fn RegisterWindowMessageW(s: *const u16) -> u32;
        fn CreatePopupMenu() -> usize;
        fn AppendMenuW(menu: usize, flags: u32, id: usize, text: *const u16) -> i32;
        fn TrackPopupMenu(
            menu: usize,
            flags: u32,
            x: i32,
            y: i32,
            reserved: i32,
            hwnd: usize,
            rect: *const c_void,
        ) -> i32;
        fn DestroyMenu(menu: usize) -> i32;
        fn GetCursorPos(pt: *mut Point) -> i32;
        fn SetForegroundWindow(hwnd: usize) -> i32;
        fn GetSystemMetrics(index: i32) -> i32;
        fn LoadIconW(instance: usize, name: usize) -> usize;
        fn CreateIconFromResourceEx(
            bits: *const u8,
            size: u32,
            is_icon: i32,
            version: u32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> usize;
        fn DestroyIcon(icon: usize) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn Shell_NotifyIconW(message: u32, data: *const NotifyIconDataW) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> usize;
    }

    struct Shared {
        url: String,
        title: String,
        tooltip: String,
        on_quit: Arc<dyn Fn() + Send + Sync>,
        hwnd: AtomicUsize,
        hicon: AtomicUsize,
        taskbar_msg: AtomicU32,
        stopped: AtomicBool,
    }

    static SHARED: Mutex<Option<Arc<Shared>>> = Mutex::new(None);

    fn shared() -> Option<Arc<Shared>> {
        SHARED.lock().ok().and_then(|g| g.clone())
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn make_data(sh: &Shared, hwnd: usize) -> NotifyIconDataW {
        // SAFETY: plain-old-data struct, all-zero is a valid value.
        let mut d: NotifyIconDataW = unsafe { std::mem::zeroed() };
        d.cb_size = std::mem::size_of::<NotifyIconDataW>() as u32;
        d.hwnd = hwnd;
        d.uid = TRAY_UID;
        d.flags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        d.callback_message = WM_TRAYICON;
        d.icon = sh.hicon.load(Ordering::SeqCst);
        let tip = utf16_truncated(&sh.tooltip, 63);
        d.tip[..tip.len()].copy_from_slice(&tip);
        d
    }

    fn add_icon(sh: &Shared, hwnd: usize, balloon: bool) -> bool {
        let mut d = make_data(sh, hwnd);
        if balloon {
            d.flags |= NIF_INFO;
            let text = utf16_truncated(
                "TokenLab is running. Click the tray icon to open the dashboard.",
                255,
            );
            d.info[..text.len()].copy_from_slice(&text);
            let title = utf16_truncated(&sh.title, 63);
            d.info_title[..title.len()].copy_from_slice(&title);
            d.info_flags = NIIF_INFO;
            d.timeout_or_version = 5000;
        }
        // SAFETY: d is fully initialised and outlives the call.
        unsafe { Shell_NotifyIconW(NIM_ADD, &d) != 0 }
    }

    fn delete_icon(sh: &Shared) {
        let hwnd = sh.hwnd.load(Ordering::SeqCst);
        if hwnd == 0 {
            return;
        }
        // SAFETY: plain-old-data struct, all-zero is a valid value.
        let mut d: NotifyIconDataW = unsafe { std::mem::zeroed() };
        d.cb_size = std::mem::size_of::<NotifyIconDataW>() as u32;
        d.hwnd = hwnd;
        d.uid = TRAY_UID;
        unsafe {
            Shell_NotifyIconW(NIM_DELETE, &d);
        }
    }

    fn load_icon() -> usize {
        let bytes = resolve_icon_bytes();
        // SAFETY: FFI; the slice is valid for the call.
        unsafe {
            let cx = GetSystemMetrics(SM_CXSMICON).max(16);
            if let Some((off, size)) = pick_ico_entry(&bytes, cx as u32) {
                let h = CreateIconFromResourceEx(
                    bytes[off..].as_ptr(),
                    size as u32,
                    1,
                    0x0003_0000,
                    cx,
                    cx,
                    0,
                );
                if h != 0 {
                    return h;
                }
            }
            LoadIconW(0, IDI_APPLICATION)
        }
    }

    unsafe fn show_menu(hwnd: usize) {
        let menu = CreatePopupMenu();
        if menu == 0 {
            return;
        }
        AppendMenuW(menu, MF_STRING, ID_OPEN, wide("Open Dashboard").as_ptr());
        AppendMenuW(menu, MF_SEPARATOR, 0, std::ptr::null());
        AppendMenuW(menu, MF_STRING, ID_QUIT, wide("Quit").as_ptr());
        let mut pt = Point { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        // Required so the menu dismisses when the user clicks elsewhere.
        SetForegroundWindow(hwnd);
        TrackPopupMenu(
            menu,
            TPM_RIGHTBUTTON | TPM_BOTTOMALIGN,
            pt.x,
            pt.y,
            0,
            hwnd,
            std::ptr::null(),
        );
        PostMessageW(hwnd, WM_NULL, 0, 0);
        DestroyMenu(menu);
    }

    unsafe extern "system" fn wnd_proc(hwnd: usize, msg: u32, wp: usize, lp: isize) -> isize {
        let sh = match shared() {
            Some(s) => s,
            None => return DefWindowProcW(hwnd, msg, wp, lp),
        };
        match msg {
            WM_TRAYICON => {
                match (lp as u32) & 0xFFFF {
                    WM_LBUTTONUP => open_browser(&sh.url),
                    WM_RBUTTONUP => show_menu(hwnd),
                    _ => {}
                }
                0
            }
            WM_COMMAND => {
                match wp & 0xFFFF {
                    ID_OPEN => open_browser(&sh.url),
                    ID_QUIT => {
                        log("Tray quit");
                        delete_icon(&sh);
                        sh.stopped.store(true, Ordering::SeqCst);
                        (sh.on_quit)();
                        DestroyWindow(hwnd);
                    }
                    _ => {}
                }
                0
            }
            WM_CLOSE => {
                DestroyWindow(hwnd);
                0
            }
            WM_DESTROY => {
                delete_icon(&sh);
                PostQuitMessage(0);
                0
            }
            m if m != 0 && m == sh.taskbar_msg.load(Ordering::SeqCst) => {
                // Explorer restarted: re-add the icon.
                if !sh.stopped.load(Ordering::SeqCst) {
                    let ok = add_icon(&sh, hwnd, false);
                    log(&format!("TaskbarCreated: icon re-added ok={ok}"));
                }
                0
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }

    fn run_thread(sh: Arc<Shared>, ready: std::sync::mpsc::Sender<bool>) {
        unsafe {
            let hinst = GetModuleHandleW(std::ptr::null());
            let class = wide("TokenLabTrayWindow");
            let wc = WndClassW {
                style: 0,
                wnd_proc,
                cls_extra: 0,
                wnd_extra: 0,
                instance: hinst,
                icon: 0,
                cursor: 0,
                background: 0,
                menu_name: std::ptr::null(),
                class_name: class.as_ptr(),
            };
            RegisterClassW(&wc);
            sh.taskbar_msg.store(
                RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()),
                Ordering::SeqCst,
            );
            // Ordinary (never shown) top-level window: message-only windows do not
            // receive the TaskbarCreated broadcast.
            let title = wide(&sh.title);
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                hinst,
                std::ptr::null(),
            );
            if hwnd == 0 {
                log_error("CreateWindowExW failed for tray window");
                let _ = ready.send(false);
                return;
            }
            sh.hwnd.store(hwnd, Ordering::SeqCst);
            let hicon = load_icon();
            sh.hicon.store(hicon, Ordering::SeqCst);
            if !add_icon(&sh, hwnd, true) {
                log_error("Shell_NotifyIconW(NIM_ADD) failed");
            } else {
                log("tray-visible");
            }
            let _ = ready.send(true);

            let mut msg: Msg = std::mem::zeroed();
            while GetMessageW(&mut msg, 0, 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if hicon != 0 {
                DestroyIcon(hicon);
            }
            sh.hwnd.store(0, Ordering::SeqCst);
        }
        log("Tray thread exited");
    }

    pub fn start(opts: TrayOptions, title: String, tooltip: String) -> Option<TrayHandle> {
        let sh = Arc::new(Shared {
            url: opts.url,
            title,
            tooltip,
            on_quit: opts.on_quit,
            hwnd: AtomicUsize::new(0),
            hicon: AtomicUsize::new(0),
            taskbar_msg: AtomicU32::new(0),
            stopped: AtomicBool::new(false),
        });
        if let Ok(mut g) = SHARED.lock() {
            *g = Some(sh.clone());
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let th = sh.clone();
        let spawned = std::thread::Builder::new()
            .name("tokenlab-tray".into())
            .stack_size(256 * 1024)
            .spawn(move || run_thread(th, tx));
        if let Err(e) = spawned {
            log_error(&format!("Failed to spawn tray thread: {e}"));
            return None;
        }
        match rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(true) => {}
            _ => return None,
        }
        let st = sh.clone();
        Some(TrayHandle {
            stop_fn: Arc::new(move || {
                if st.stopped.swap(true, Ordering::SeqCst) {
                    return;
                }
                // Remove the icon synchronously (process may exit right after),
                // then let the tray thread tear its window down.
                delete_icon(&st);
                let hwnd = st.hwnd.load(Ordering::SeqCst);
                if hwnd != 0 {
                    unsafe {
                        PostMessageW(hwnd, WM_CLOSE, 0, 0);
                    }
                }
            }),
        })
    }
}

pub async fn start_tray(opts: TrayOptions) -> Option<TrayHandle> {
    log("startTray called");
    if !cfg!(windows) {
        log("Tray disabled: not Windows");
        return None;
    }
    if std::env::var("TOKENLAB_NO_TRAY").as_deref() == Ok("1") {
        log("Tray disabled: TOKENLAB_NO_TRAY=1");
        return None;
    }

    let title = opts
        .title
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "TokenLab".to_string());
    let tooltip = opts
        .tooltip
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "TokenLab \u{2014} click to open dashboard".to_string());

    #[cfg(windows)]
    {
        win::start(opts, title, tooltip)
    }
    #[cfg(not(windows))]
    {
        let _ = (opts, title, tooltip);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltip_truncates_on_utf16_boundary() {
        let s = "a".repeat(70);
        assert_eq!(utf16_truncated(&s, 63).len(), 63);
        // 62 units + a surrogate pair (2 units) would exceed 63: pair dropped whole.
        let s = format!("{}\u{1F600}", "a".repeat(62));
        assert_eq!(utf16_truncated(&s, 63).len(), 62);
        assert_eq!(utf16_truncated("TokenLab \u{2014} x", 63).len(), 12);
    }

    fn ico(entries: &[(u8, usize, usize)], total: usize) -> Vec<u8> {
        let mut d = vec![0, 0, 1, 0, entries.len() as u8, 0];
        for (w, off, size) in entries {
            d.extend_from_slice(&[*w, *w, 0, 0, 1, 0, 32, 0]);
            d.extend_from_slice(&(*size as u32).to_le_bytes());
            d.extend_from_slice(&(*off as u32).to_le_bytes());
        }
        d.resize(total, 0);
        d
    }

    #[test]
    fn ico_entry_selection() {
        let d = ico(&[(16, 100, 10), (32, 110, 10), (0, 120, 10)], 200);
        assert_eq!(pick_ico_entry(&d, 16), Some((100, 10)));
        assert_eq!(pick_ico_entry(&d, 20), Some((110, 10)));
        assert_eq!(pick_ico_entry(&d, 300), Some((120, 10)));
        // out-of-range entry skipped
        let d = ico(&[(16, 500, 10), (32, 110, 10)], 200);
        assert_eq!(pick_ico_entry(&d, 16), Some((110, 10)));
        assert_eq!(pick_ico_entry(b"nope", 16), None);
    }
}
