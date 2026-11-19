use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
mod backend;
mod voice_engine;
mod voice_models;
mod os_version;
mod deskband_ipc;
mod apple_speech;

#[tauri::command]
fn get_os_dock_capability() -> os_version::OsDockCapability {
    os_version::check_os_dock_capability()
}

#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
#[cfg(windows)]
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{HTCAPTION, WM_NCHITTEST};

#[cfg(windows)]
unsafe fn disable_window_border(hwnd: HWND) {
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};
    use windows::core::s;
    if let Ok(dwmapi) = LoadLibraryA(s!("dwmapi.dll")) {
        type FnDwmSetWindowAttribute = unsafe extern "system" fn(
            hwnd: HWND,
            dw_attribute: u32,
            pv_attribute: *const std::ffi::c_void,
            cb_attribute: u32,
        ) -> windows::Win32::Foundation::HRESULT;

        if let Some(proc) = GetProcAddress(dwmapi, s!("DwmSetWindowAttribute")) {
            let func: FnDwmSetWindowAttribute = std::mem::transmute(proc);
            // DWMWA_BORDER_COLOR = 34
            // DWMWA_COLOR_NONE = 0xFFFFFFFE (彻底关闭 Windows 11 DWM 默认渲染的蓝色/强调色边框线)
            let color_none: u32 = 0xFFFFFFFE;
            let _ = func(
                hwnd,
                34,
                &color_none as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

#[cfg(windows)]
unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> LRESULT {
    if msg == WM_NCHITTEST {
        let x = (lparam.0 & 0xFFFF) as i16 as i32;
        let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as i32;

        let mut rect = RECT::default();
        if windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect).is_ok() {
            // 获取窗口 DPI 缩放比例
            let dpi = windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd);
            let scale_factor = dpi as f32 / 96.0;

            // 标题栏高度 28px
            let titlebar_height = (28.0 * scale_factor) as i32;
            // 窗口控制按钮区域约 132px
            let controls_width = (132.0 * scale_factor) as i32;

            // 检查鼠标是否在标题栏区域
            if y >= rect.top && y < rect.top + titlebar_height {
                // 排除右侧的窗口控制按钮区域
                if x < rect.right - controls_width {
                    return LRESULT(HTCAPTION as isize);
                }
            }
        }
    }

    DefSubclassProc(hwnd, msg, wparam, lparam)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct TaskbarInfo {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub tray_x: i32,
    pub tray_y: i32,
    pub tray_width: i32,
    pub slot_x: i32,
    pub slot_y: i32,
}

#[tauri::command]
fn get_taskbar_dock_info(_app: tauri::AppHandle) -> Result<TaskbarInfo, String> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, FindWindowExW, GetWindowRect};
        use windows::Win32::Foundation::RECT;
        use windows::core::PCWSTR;

        let h_taskbar = FindWindowW(windows::core::w!("Shell_TrayWnd"), PCWSTR::null())
            .map_err(|e| e.to_string())?;
        
        let mut tb_rect = RECT::default();
        let _ = GetWindowRect(h_taskbar, &mut tb_rect);

        let h_tray = FindWindowExW(h_taskbar, windows::Win32::Foundation::HWND::default(), windows::core::w!("TrayNotifyWnd"), PCWSTR::null())
            .unwrap_or_default();
        
        let mut tray_rect = RECT::default();
        if h_tray != windows::Win32::Foundation::HWND::default() {
            let _ = GetWindowRect(h_tray, &mut tray_rect);
        } else {
            tray_rect = RECT { left: tb_rect.right - 200, top: tb_rect.top, right: tb_rect.right, bottom: tb_rect.bottom };
        }

        let dpi = windows::Win32::UI::HiDpi::GetDpiForWindow(h_taskbar);
        let factor = if dpi > 0 { dpi as f32 / 96.0 } else { 1.0 };

        let tb_x = (tb_rect.left as f32 / factor) as i32;
        let tb_y = (tb_rect.top as f32 / factor) as i32;
        let tb_w = ((tb_rect.right - tb_rect.left) as f32 / factor) as i32;
        let tb_h = ((tb_rect.bottom - tb_rect.top) as f32 / factor) as i32;
        let tray_x = (tray_rect.left as f32 / factor) as i32;
        let tray_w = ((tray_rect.right - tray_rect.left) as f32 / factor) as i32;
        let slot_x = tray_x - 290 - 8;

        Ok(TaskbarInfo {
            x: tb_x,
            y: tb_y,
            width: tb_w,
            height: tb_h,
            tray_x,
            tray_y: (tray_rect.top as f32 / factor) as i32,
            tray_width: tray_w,
            slot_x: if slot_x > 0 { slot_x } else { tb_w - 300 },
            slot_y: tb_y + ((tb_h - 36) / 2),
        })
    }

    #[cfg(not(windows))]
    {
        Err("Only supported on Windows".to_string())
    }
}

#[tauri::command]
fn island_toggle_mute(app: tauri::AppHandle, muted: Option<bool>) {
    let _ = app.emit_to("main", "voice-call:toggle-mute", serde_json::json!({ "muted": muted }));
}

#[tauri::command]
fn island_toggle_screen_share(app: tauri::AppHandle, screen_sharing: Option<bool>) {
    let _ = app.emit_to("main", "voice-call:toggle-screen-share", serde_json::json!({ "screenSharing": screen_sharing }));
}

#[tauri::command]
fn close_voice_call_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("voice-call") {
        let _ = window.hide();
        let _ = window.destroy();
    }
}

#[tauri::command]
fn hangup_voice_call(app: tauri::AppHandle) {
    let _ = app.emit_to("main", "voice-call:hangup", ());
    let _ = app.emit("voice-call:hangup", ());
    if let Some(window) = app.get_webview_window("voice-call") {
        let _ = window.hide();
        let _ = window.destroy();
    }
}

/// 捕获屏幕截图，返回 base64 格式的 JPEG 图片
#[tauri::command]
async fn capture_screen() -> Result<String, String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        capture_screen_impl()
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err("屏幕截图功能仅在 Windows 和 macOS 上支持".to_string())
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn capture_screen_impl() -> Result<String, String> {
    use base64::prelude::*;
    use std::io::Cursor;
    
    // 使用 screenshots-rs 库进行屏幕截图
    let ctx = screenshots::Screen::all().map_err(|e| format!("获取屏幕信息失败: {}", e))?;
    if ctx.is_empty() {
        return Err("未检测到屏幕".to_string());
    }
    
    let screen = &ctx[0];
    let image_data = screen.capture().map_err(|e| format!("屏幕截图失败: {}", e))?;
    
    let width = image_data.width();
    let height = image_data.height();
    let rgba_bytes = Vec::<u8>::from(image_data);
    
    let img = image::RgbaImage::from_raw(width, height, rgba_bytes)
        .ok_or_else(|| "图片构建失败".to_string())?;
    let dyn_img = image::DynamicImage::ImageRgba8(img);
    
    let mut jpeg_bytes = Vec::new();
    let mut cursor = Cursor::new(&mut jpeg_bytes);
    dyn_img.write_to(&mut cursor, image::ImageFormat::Jpeg)
        .map_err(|e| format!("JPEG 编码失败: {}", e))?;
    
    let base64 = BASE64_STANDARD.encode(&jpeg_bytes);
    Ok(format!("data:image/jpeg;base64,{}", base64))
}

/// 探测本机出口物理网卡的 IPv4 地址。
///
/// 1. 环境变量 `LINGSHU_HOST_IP` / `HOST_IP`；
/// 2. Windows：按默认路由表（RouteMetric）取物理网卡 IP，过滤回环 / Clash 代理段 / `.1` 虚拟网关；
/// 3. 通用：UDP `connect` 收集候选，再按虚拟网关与网段优先级打分。
/// 探测失败时回退到 `127.0.0.1`。
#[tauri::command]
fn get_lan_ip() -> String {
    detect_lan_ip()
}

fn detect_lan_ip() -> String {
    for key in ["LINGSHU_HOST_IP", "HOST_IP"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }

    #[cfg(windows)]
    if let Some(ip) = detect_lan_ip_via_windows_route() {
        return ip;
    }

    let mut candidates: Vec<String> = Vec::new();
    for target in ["223.5.5.5:53", "114.114.114.114:53", "8.8.8.8:80"] {
        if let Some(ip) = probe_outbound_ipv4(target) {
            if !candidates.iter().any(|existing| existing == &ip) {
                candidates.push(ip);
            }
        }
    }

    if candidates.is_empty() {
        return "127.0.0.1".to_string();
    }

    candidates.sort_by_key(|ip| lan_ip_score(ip));
    candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

/// Windows：用默认路由表找最优先物理网卡 IP。
#[cfg(windows)]
fn detect_lan_ip_via_windows_route() -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let ip = line.trim();
        if ip.is_empty() {
            continue;
        }
        // 排除回环、Clash 等代理段、以及以 .1 结尾的虚拟网关（WSL/VMware/Docker 等）
        if ip.starts_with("127.") || ip.starts_with("198.18.") || ip.ends_with(".1") {
            continue;
        }
        return Some(ip.to_string());
    }
    None
}

fn probe_outbound_ipv4(target: &str) -> Option<String> {
    use std::net::{IpAddr, UdpSocket};

    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect(target).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(v4) => {
            let ip = v4.to_string();
            if ip.starts_with("127.") || ip.starts_with("198.18.") || ip.starts_with("169.254.") {
                None
            } else {
                Some(ip)
            }
        }
        IpAddr::V6(_) => None,
    }
}

/// 分数越低越优先，逻辑对齐 `backend/utils/ssl.py::get_ip_score`。
fn lan_ip_score(ip_str: &str) -> (u8, u8) {
    if ip_str.starts_with("127.") || ip_str.starts_with("198.18.") {
        return (9, 0);
    }

    let is_virtual_gateway = ip_str.ends_with(".1");
    let parts: Vec<u8> = ip_str
        .split('.')
        .filter_map(|p| p.parse::<u8>().ok())
        .collect();

    let pri = if parts.len() == 4 {
        if parts[0] == 192 || parts[0] == 10 {
            1
        } else if parts[0] == 172 && (16..=31).contains(&parts[1]) {
            2
        } else {
            3
        }
    } else {
        3
    };

    (if is_virtual_gateway { 1 } else { 0 }, pri)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(voice_engine::VoiceEngineState::default())
        .manage(apple_speech::AppleSpeechState::default())
        .manage(backend::BackendState::default())
        .setup(|app| {
            // 创建托盘菜单
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            // 构建托盘
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            #[cfg(windows)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(hwnd_raw) = window.hwnd() {
                        let hwnd = windows::Win32::Foundation::HWND(hwnd_raw.0 as _);
                        unsafe {
                            let _ = SetWindowSubclass(
                                hwnd,
                                Some(wnd_proc),
                                1, // subclass id
                                0, // ref data
                            );
                            disable_window_border(hwnd);
                        }
                    }
                }
            }

            backend::ensure_started(app.handle().clone());
            deskband_ipc::start_deskband_ipc_server(app.handle().clone());
            voice_models::spawn_prepare_models(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { .. } => {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            quit_app,
            close_voice_call_window,
            hangup_voice_call,
            island_toggle_mute,
            island_toggle_screen_share,
            get_taskbar_dock_info,
            get_lan_ip,
            get_os_dock_capability,
            deskband_ipc::register_deskband,
            deskband_ipc::unregister_deskband,
            capture_screen,
            voice_engine::voice_get_status,
            voice_engine::voice_init,
            voice_engine::voice_start_session,
            voice_engine::voice_push_pcm,
            voice_engine::voice_flush,
            voice_engine::voice_stop_session,
            apple_speech::apple_speech_status,
            apple_speech::apple_speech_start_session,
            apple_speech::apple_speech_push_pcm,
            apple_speech::apple_speech_flush,
            apple_speech::apple_speech_stop_session,
            apple_speech::apple_speech_request_authorization
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            backend::shutdown(app_handle);
        }
    });
}
