#[cfg(windows)]
use windows::Win32::System::SystemInformation::OSVERSIONINFOEXW;
#[cfg(windows)]
use windows::core::HRESULT;

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct OsDockCapability {
    pub is_windows: bool,
    pub is_windows_10: bool,
    pub is_windows_11: bool,
    pub build_number: u32,
    pub supports_deskband: bool,
    pub recommendation: String,
}

#[cfg(windows)]
pub fn get_windows_version_info() -> (u32, u32, u32) {
    type RtlGetVersionFn = unsafe extern "system" fn(*mut OSVERSIONINFOEXW) -> HRESULT;
    unsafe {
        if let Ok(ntdll) = windows::Win32::System::LibraryLoader::GetModuleHandleW(windows::core::w!("ntdll.dll")) {
            if let Some(proc) = windows::Win32::System::LibraryLoader::GetProcAddress(ntdll, windows::core::s!("RtlGetVersion")) {
                let rtl_get_version: RtlGetVersionFn = std::mem::transmute(proc);
                let mut os_info: OSVERSIONINFOEXW = std::mem::zeroed();
                os_info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOEXW>() as u32;
                if rtl_get_version(&mut os_info).is_ok() {
                    return (os_info.dwMajorVersion, os_info.dwMinorVersion, os_info.dwBuildNumber);
                }
            }
        }
    }
    (10, 0, 0)
}

pub fn check_os_dock_capability() -> OsDockCapability {
    #[cfg(windows)]
    {
        let (major, _minor, build) = get_windows_version_info();
        let is_win10 = major == 10 && build >= 10240 && build < 22000;
        let is_win11 = (major == 10 && build >= 22000) || major > 10;
        let supports_deskband = is_win10;
        let recommendation = if supports_deskband {
            "windows_10_deskband".to_string()
        } else {
            "topmost_island".to_string()
        };

        OsDockCapability {
            is_windows: true,
            is_windows_10: is_win10,
            is_windows_11: is_win11,
            build_number: build,
            supports_deskband,
            recommendation,
        }
    }

    #[cfg(not(windows))]
    {
        OsDockCapability {
            is_windows: false,
            is_windows_10: false,
            is_windows_11: false,
            build_number: 0,
            supports_deskband: false,
            recommendation: "topmost_island".to_string(),
        }
    }
}
