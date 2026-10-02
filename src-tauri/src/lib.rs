use serde::Serialize;
use std::fs;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::webview::{DownloadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

// ---------------------------------------------------------------
// Explorer (file browsing)
// ---------------------------------------------------------------

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

#[tauri::command]
fn home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "C:\\".into())
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    let mut out = Vec::new();
    let rd = fs::read_dir(&path).map_err(|e| e.to_string())?;
    for item in rd.flatten() {
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(Entry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: item.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified,
        });
    }
    // folders first, then name (case-insensitive)
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
fn parent_dir(path: String) -> Option<String> {
    Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
fn list_drives() -> Vec<String> {
    #[cfg(windows)]
    {
        (b'A'..=b'Z')
            .map(|c| format!("{}:\\", c as char))
            .filter(|d| Path::new(d).exists())
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec!["/".into()]
    }
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open::that(path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------
// Web panes (child webviews placed over the main window)
// ---------------------------------------------------------------

/// Download folder: `behavior.downloadDir` from config.json, else the OS Downloads folder.
fn download_dir(app: &AppHandle) -> Option<PathBuf> {
    let custom = config_file(app)
        .ok()
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v["behavior"]["downloadDir"].as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    custom.or_else(|| app.path().download_dir().ok())
}

/// `name (1).ext`, `name (2).ext`, ... until the path is free.
fn unique_path(dir: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|c| !c.exists())
        .unwrap()
}

// ---------------------------------------------------------------
// Downloads awaiting the user's decision (save to Downloads / choose a folder / cancel)
// ---------------------------------------------------------------

static DL_COUNTER: AtomicU64 = AtomicU64::new(1);

struct Dl {
    name: String,
    url: String,
    /// ("downloads" | "folder" | "cancel", target dir for "folder")
    choice: Option<(String, Option<String>)>,
    finished: Option<bool>,
}

fn downloads() -> &'static Mutex<HashMap<String, Dl>> {
    static M: OnceLock<Mutex<HashMap<String, Dl>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to)?;
    fs::remove_file(from)
}

/// Called once both the file is fully downloaded and the choice is known (or the download failed).
fn finalize(app: &AppHandle, key: &str, d: Dl) {
    let temp = PathBuf::from(key);
    let report = |state: &str, path: Option<String>, success: bool| {
        let _ = app.emit("download", serde_json::json!({
            "state": state, "id": key, "name": d.name, "path": path, "success": success,
        }));
    };
    let cleanup = || {
        if let Some(dir) = temp.parent() {
            let _ = fs::remove_dir_all(dir);
        }
    };
    if d.finished != Some(true) {
        cleanup();
        report("failed", None, false);
        return;
    }
    let target_dir = match &d.choice {
        Some((c, _)) if c == "cancel" => {
            cleanup();
            report("cancelled", None, false);
            return;
        }
        Some((c, Some(dir))) if c == "folder" => Some(PathBuf::from(dir)),
        _ => download_dir(app),
    };
    let result = target_dir
        .ok_or_else(|| "no download folder".to_string())
        .and_then(|dir| {
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let dest = unique_path(&dir, std::ffi::OsStr::new(&d.name));
            move_file(&temp, &dest).map_err(|e| e.to_string())?;
            Ok(dest)
        });
    cleanup();
    match result {
        Ok(dest) => report("finished", Some(dest.to_string_lossy().into_owned()), true),
        Err(_) => report("failed", None, false),
    }
}

#[tauri::command]
fn download_decide(app: AppHandle, id: String, choice: String, dir: Option<String>) {
    let ready = {
        let mut map = downloads().lock().unwrap();
        match map.get_mut(&id) {
            Some(d) => {
                if d.choice.is_some() {
                    None // already decided
                } else {
                    d.choice = Some((choice, dir));
                    if d.finished.is_some() { map.remove(&id) } else { None }
                }
            }
            None => None,
        }
    };
    if let Some(d) = ready {
        finalize(&app, &id, d);
    }
}

#[tauri::command]
fn default_download_dir(app: AppHandle) -> String {
    download_dir(&app).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

// async: creating a webview from a sync command deadlocks on Windows.
#[tauri::command]
async fn web_open(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let window = app.get_window("main").ok_or("main window not found")?;
    let parsed = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let handle = app.clone();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed)).on_download(move |wv, event| {
        match event {
            // The file is first downloaded to a temp folder (keeps cookies/session intact) while the
            // UI asks where to put it; `download_decide` / Finished then move it into place.
            DownloadEvent::Requested { url, destination } => {
                let name = destination
                    .file_name()
                    .map(|n| n.to_os_string())
                    .unwrap_or_else(|| "download".into());
                let n = DL_COUNTER.fetch_add(1, Ordering::Relaxed);
                let dir = std::env::temp_dir().join("unibrowse-dl").join(format!("{}-{n}", std::process::id()));
                let _ = fs::create_dir_all(&dir);
                let temp = dir.join(&name);
                *destination = temp.clone();
                let id = temp.to_string_lossy().into_owned();
                let name = name.to_string_lossy().into_owned();
                downloads().lock().unwrap().insert(
                    id.clone(),
                    Dl { name: name.clone(), url: url.to_string(), choice: None, finished: None },
                );
                let _ = handle.emit("download", serde_json::json!({
                    "state": "requested",
                    "id": id,
                    "name": name,
                    "label": wv.label(),
                    "url": url.to_string(),
                }));
            }
            DownloadEvent::Finished { url, path, success } => {
                let key = {
                    let map = downloads().lock().unwrap();
                    path.as_ref()
                        .map(|p| p.to_string_lossy().into_owned())
                        .filter(|k| map.contains_key(k))
                        .or_else(|| map.iter().find(|(_, d)| d.url == url.to_string()).map(|(k, _)| k.clone()))
                };
                if let Some(key) = key {
                    let ready = {
                        let mut map = downloads().lock().unwrap();
                        match map.get_mut(&key) {
                            Some(d) => {
                                d.finished = Some(success);
                                // failed downloads are reported right away; otherwise wait for the user's choice
                                if d.choice.is_some() || !success { map.remove(&key) } else { None }
                            }
                            None => None,
                        }
                    };
                    if let Some(d) = ready {
                        finalize(&handle, &key, d);
                    }
                }
            }
            _ => {}
        }
        true
    });
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn web_bounds(app: AppHandle, label: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn web_visible(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        if visible {
            wv.show().map_err(|e| e.to_string())?;
        } else {
            wv.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn web_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let parsed = url.parse().map_err(|e| format!("invalid url: {e}"))?;
        wv.navigate(parsed).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// action: "back" | "forward" | "reload"
#[tauri::command]
fn web_action(app: AppHandle, label: String, action: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        let js = match action.as_str() {
            "back" => "history.back()",
            "forward" => "history.forward()",
            "reload" => "location.reload()",
            _ => return Err("unknown action".into()),
        };
        wv.eval(js).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn web_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------
// Embedding other apps' windows (Windows only)
// ---------------------------------------------------------------

#[derive(Serialize)]
pub struct WinInfo {
    hwnd: isize,
    title: String,
}

#[cfg(windows)]
mod embed {
    use super::WinInfo;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = &mut *(lparam.0 as *mut Vec<WinInfo>);
        if IsWindowVisible(hwnd).as_bool() && GetWindow(hwnd, GW_OWNER).is_err() {
            let len = GetWindowTextLengthW(hwnd);
            if len > 0 {
                let mut buf = vec![0u16; len as usize + 1];
                let n = GetWindowTextW(hwnd, &mut buf);
                let title = String::from_utf16_lossy(&buf[..n as usize]);
                if !title.trim().is_empty() {
                    list.push(WinInfo {
                        hwnd: hwnd.0 as isize,
                        title,
                    });
                }
            }
        }
        BOOL(1)
    }

    pub fn list_windows(own: isize) -> Vec<WinInfo> {
        let mut list: Vec<WinInfo> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut _ as isize));
        }
        list.retain(|w| w.hwnd != own);
        list
    }

    pub fn embed(child: isize, parent: isize, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
        unsafe {
            let child = HWND(child as *mut _);
            let parent = HWND(parent as *mut _);
            let style = GetWindowLongPtrW(child, GWL_STYLE);
            let new_style = (style & !(WS_CAPTION.0 as isize | WS_THICKFRAME.0 as isize))
                | WS_CHILD.0 as isize;
            SetWindowLongPtrW(child, GWL_STYLE, new_style);
            SetParent(child, parent).map_err(|e| e.to_string())?;
            SetWindowPos(child, HWND_TOP, x, y, w, h, SWP_SHOWWINDOW | SWP_FRAMECHANGED)
                .map_err(|e| e.to_string())
        }
    }

    pub fn set_bounds(child: isize, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
        unsafe {
            SetWindowPos(HWND(child as *mut _), HWND_TOP, x, y, w, h, SWP_NOACTIVATE)
                .map_err(|e| e.to_string())
        }
    }

    pub fn show(child: isize, visible: bool) {
        unsafe {
            let _ = ShowWindow(HWND(child as *mut _), if visible { SW_SHOW } else { SW_HIDE });
        }
    }

    /// Give the window back to the desktop with a normal frame.
    pub fn release(child: isize) -> Result<(), String> {
        unsafe {
            let child = HWND(child as *mut _);
            let style = GetWindowLongPtrW(child, GWL_STYLE);
            let new_style = (style & !(WS_CHILD.0 as isize))
                | WS_CAPTION.0 as isize
                | WS_THICKFRAME.0 as isize;
            SetWindowLongPtrW(child, GWL_STYLE, new_style);
            SetParent(child, HWND::default()).map_err(|e| e.to_string())?;
            SetWindowPos(
                child,
                HWND_TOP,
                100,
                100,
                900,
                600,
                SWP_SHOWWINDOW | SWP_FRAMECHANGED,
            )
            .map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
fn list_windows(app: AppHandle) -> Vec<WinInfo> {
    #[cfg(windows)]
    {
        let own = app
            .get_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize)
            .unwrap_or(0);
        embed::list_windows(own)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Vec::new()
    }
}

#[tauri::command]
fn embed_window(app: AppHandle, hwnd: isize, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let parent = app
            .get_window("main")
            .ok_or("main window not found")?
            .hwnd()
            .map_err(|e| e.to_string())?
            .0 as isize;
        embed::embed(hwnd, parent, x, y, w, h)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, hwnd, x, y, w, h);
        Err("window embedding is only supported on Windows".into())
    }
}

#[tauri::command]
fn embed_bounds(hwnd: isize, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    #[cfg(windows)]
    {
        embed::set_bounds(hwnd, x, y, w.max(1), h.max(1))
    }
    #[cfg(not(windows))]
    {
        let _ = (hwnd, x, y, w, h);
        Ok(())
    }
}

#[tauri::command]
fn embed_visible(hwnd: isize, visible: bool) {
    #[cfg(windows)]
    embed::show(hwnd, visible);
    #[cfg(not(windows))]
    let _ = (hwnd, visible);
}

#[tauri::command]
fn embed_release(hwnd: isize) -> Result<(), String> {
    #[cfg(windows)]
    {
        embed::release(hwnd)
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        Ok(())
    }
}

// ---------------------------------------------------------------
// Config (JSON file in the app config dir)
// ---------------------------------------------------------------

fn config_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
fn config_path(app: AppHandle) -> Result<String, String> {
    Ok(config_file(&app)?.to_string_lossy().into_owned())
}

/// Returns the raw JSON text, or None when no config has been saved yet.
#[tauri::command]
fn config_load(app: AppHandle) -> Result<Option<String>, String> {
    let f = config_file(&app)?;
    match fs::read_to_string(&f) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn config_save(app: AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    fs::write(config_file(&app)?, json).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            home_dir,
            config_path,
            download_decide,
            default_download_dir,
            config_load,
            config_save,
            list_dir,
            parent_dir,
            list_drives,
            open_path,
            web_open,
            web_bounds,
            web_visible,
            web_navigate,
            web_action,
            web_close,
            list_windows,
            embed_window,
            embed_bounds,
            embed_visible,
            embed_release,
        ])
        .run(tauri::generate_context!())
        .expect("error while running UniBrowse");
}
