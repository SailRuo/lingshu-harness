fn main() {
    let vad_model = std::path::Path::new("resources/vad/silero_vad.onnx");
    if !vad_model.is_file() {
        panic!(
            "Missing VAD model for compile-time embed: {}. Run `npm run sync:vad` in lingshu-gui.",
            vad_model.display()
        );
    }

    tauri_build::build();

    // tauri dev 以裸二进制运行（无 .app bundle），macOS TCC 读不到打包时的
    // Info.plist，首次申请语音识别/麦克风权限会直接 abort（隐私违规）。
    // 把 Info-dev.plist 嵌进 __TEXT,__info_plist 段；打包仍走 tauri.conf.json
    // 引用的 Info.plist，不受影响。
    if cfg!(target_os = "macos") {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let plist = std::path::Path::new(&manifest_dir).join("Info-dev.plist");
        if plist.is_file() {
            println!(
                "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
                plist.display()
            );
        }
    }
}
