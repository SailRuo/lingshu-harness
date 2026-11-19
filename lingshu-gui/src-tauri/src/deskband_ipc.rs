use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

static IS_IPC_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct DeskbandIpcAction {
    pub action: String,
    pub payload: Option<serde_json::Value>,
}

#[cfg(windows)]
pub fn start_deskband_ipc_server(app: AppHandle) {
    if IS_IPC_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
        use windows::Win32::System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
            PIPE_TYPE_BYTE, PIPE_WAIT,
        };

        let pipe_name = r"\\.\pipe\lingshu_deskband";
        let wide_pipe: Vec<u16> = OsStr::new(pipe_name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        loop {
            unsafe {
                let handle = CreateNamedPipeW(
                    windows::core::PCWSTR(wide_pipe.as_ptr()),
                    FILE_FLAGS_AND_ATTRIBUTES(0x00000003), // PIPE_ACCESS_DUPLEX
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                    255,
                    4096,
                    4096,
                    0,
                    None,
                );

                if handle == INVALID_HANDLE_VALUE {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    continue;
                }

                let connected = ConnectNamedPipe(handle, None);
                if connected.is_ok() || windows::core::Error::from_win32().code().0 == -2147024861 {
                    let mut buffer = [0u8; 1024];
                    let mut bytes_read = 0u32;
                    let success = windows::Win32::Storage::FileSystem::ReadFile(
                        handle,
                        Some(&mut buffer),
                        Some(&mut bytes_read),
                        None,
                    );

                    if success.is_ok() && bytes_read > 0 {
                        let text = String::from_utf8_lossy(&buffer[..bytes_read as usize]);
                        for line in text.lines() {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                continue;
                            }
                            if let Ok(action_obj) = serde_json::from_str::<DeskbandIpcAction>(trimmed) {
                                match action_obj.action.as_str() {
                                    "hangup" => {
                                        let _ = app.emit_to("main", "voice-call:hangup", ());
                                        let _ = app.emit("voice-call:hangup", ());
                                    }
                                    "toggle-mute" => {
                                        let _ = app.emit_to("main", "voice-call:toggle-mute", ());
                                        let _ = app.emit("voice-call:toggle-mute", ());
                                    }
                                    "toggle-screen-share" => {
                                        let _ = app.emit_to("main", "voice-call:toggle-screen-share", ());
                                        let _ = app.emit("voice-call:toggle-screen-share", ());
                                    }
                                    "focus-main" => {
                                        if let Some(main_win) = app.get_webview_window("main") {
                                            let _ = main_win.show();
                                            let _ = main_win.set_focus();
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    let _ = DisconnectNamedPipe(handle);
                }
                let _ = CloseHandle(handle);
            }
        }
    });
}

#[cfg(not(windows))]
pub fn start_deskband_ipc_server(_app: AppHandle) {}

#[tauri::command]
pub fn register_deskband() -> Result<String, String> {
    #[cfg(windows)]
    {
        let exe_dir = std::env::current_exe().map_err(|e| e.to_string())?
            .parent().ok_or_else(|| "Failed to get exe directory".to_string())?
            .to_path_buf();
        
        let dll_candidates = [
            exe_dir.join("lingshu_deskband.dll"),
            exe_dir.join("..").join("lingshu_deskband.dll"),
            std::path::PathBuf::from(r"E:\Project\LingShu-Agent\lingshu-gui\src-tauri\deskband\target\release\lingshu_deskband.dll"),
            std::path::PathBuf::from(r"E:\Project\LingShu-Agent\lingshu-gui\src-tauri\deskband\target\debug\lingshu_deskband.dll"),
            std::path::PathBuf::from(r"E:\Project\LingShu-Agent\lingshu-gui\src-tauri\target\debug\lingshu_deskband.dll"),
            std::path::PathBuf::from(r"E:\Project\LingShu-Agent\lingshu-gui\src-tauri\target\release\lingshu_deskband.dll"),
        ];

        let mut found_dll = None;
        for c in &dll_candidates {
            if c.exists() {
                found_dll = Some(c.clone());
                break;
            }
        }

        let dll_path = found_dll.ok_or_else(|| "未找到 lingshu_deskband.dll，请先编译 DeskBand 组件".to_string())?;

        let status = std::process::Command::new("regsvr32.exe")
            .arg("/s")
            .arg(&dll_path)
            .status()
            .map_err(|e| format!("执行 regsvr32 失败: {}", e))?;

        if status.success() {
            Ok(format!("DeskBand 注册成功: {}", dll_path.display()))
        } else {
            Err("regsvr32 注册返回非 0 状态码".to_string())
        }
    }

    #[cfg(not(windows))]
    {
        Err("DeskBand 仅支持 Windows 系统".to_string())
    }
}

#[tauri::command]
pub fn unregister_deskband() -> Result<String, String> {
    #[cfg(windows)]
    {
        let clsid_str = "{B96752FD-3652-4FD4-BA3B-60EB0C6E96E2}";
        use windows::Win32::System::Registry::{RegDeleteTreeW, HKEY_CURRENT_USER};
        use windows::core::PCWSTR;
        let key_path = format!("Software\\Classes\\CLSID\\{}\0", clsid_str);
        let wide_key: Vec<u16> = key_path.encode_utf16().collect();
        unsafe {
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(wide_key.as_ptr()));
        }
        Ok("DeskBand 反注册成功".to_string())
    }

    #[cfg(not(windows))]
    {
        Err("DeskBand 仅支持 Windows 系统".to_string())
    }
}
