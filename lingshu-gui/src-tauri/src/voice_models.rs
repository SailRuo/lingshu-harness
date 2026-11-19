use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU8, Ordering},
        OnceLock,
    },
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PreparePhase {
    Idle = 0,
    Ready = 1,
    Missing = 2,
}

static PREPARE_PHASE: AtomicU8 = AtomicU8::new(PreparePhase::Idle as u8);
static ACTIVE_VAD_MODEL: OnceLock<PathBuf> = OnceLock::new();

/// 编译期嵌入 VAD 模型（约 2.2MB），运行时解压到应用缓存目录供 Sherpa-ONNX 读取。
const VAD_MODEL_BYTES: &[u8] = include_bytes!("../resources/vad/silero_vad.onnx");
const VAD_MODEL_FILE_NAME: &str = "silero_vad.onnx";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAsrStatus {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f32>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VoiceAsrStatusEvent {
    AsrStatus {
        state: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        progress: Option<f32>,
    },
}

pub struct VoiceModelPaths {
    pub vad_model: PathBuf,
}

static MISSING_STATUS_MESSAGE: OnceLock<String> = OnceLock::new();

pub fn current_status() -> VoiceAsrStatus {
    match PreparePhase::from(PREPARE_PHASE.load(Ordering::Relaxed)) {
        PreparePhase::Ready => VoiceAsrStatus {
            state: "ready",
            message: Some("端侧 VAD 已就绪（ASR 由服务端流式识别）".into()),
            progress: Some(1.0),
        },
        PreparePhase::Missing => VoiceAsrStatus {
            state: "error",
            message: Some(
                MISSING_STATUS_MESSAGE
                    .get()
                    .cloned()
                    .unwrap_or_else(|| "语音模型缺失".into()),
            ),
            progress: None,
        },
        PreparePhase::Idle => VoiceAsrStatus {
            state: "unavailable",
            message: Some("正在检查本地语音模型…".into()),
            progress: None,
        },
    }
}

pub fn is_ready() -> bool {
    PreparePhase::from(PREPARE_PHASE.load(Ordering::Relaxed)) == PreparePhase::Ready
}

pub fn resolve_model_paths(app: &AppHandle) -> Result<VoiceModelPaths, String> {
    if !is_ready() {
        return Err(
            MISSING_STATUS_MESSAGE
                .get()
                .cloned()
                .unwrap_or_else(|| current_status().message.unwrap_or_else(|| "端侧 ASR 不可用".into())),
        );
    }

    let vad_model = active_vad_model_path(app).ok_or_else(|| missing_models_message())?;
    if !vad_model.is_file() {
        return Err(missing_models_message());
    }

    Ok(VoiceModelPaths { vad_model })
}

/// 启动时将编译期嵌入的 VAD 模型解压到应用缓存目录。
pub fn spawn_prepare_models(app: AppHandle) {
    if is_ready() {
        emit_status(&app, current_status());
        return;
    }

    match materialize_embedded_vad_model(&app) {
        Ok(vad_model) => {
            let _ = ACTIVE_VAD_MODEL.set(vad_model);
            set_phase(PreparePhase::Ready);
            emit_status(&app, current_status());
        }
        Err(message) => {
            let _ = MISSING_STATUS_MESSAGE.set(message.clone());
            set_phase(PreparePhase::Missing);
            emit_status(
                &app,
                VoiceAsrStatus {
                    state: "error",
                    message: Some(message),
                    progress: None,
                },
            );
        }
    }
}

impl PreparePhase {
    fn from(value: u8) -> Self {
        match value {
            1 => Self::Ready,
            2 => Self::Missing,
            _ => Self::Idle,
        }
    }
}

fn set_phase(phase: PreparePhase) {
    PREPARE_PHASE.store(phase as u8, Ordering::Relaxed);
}

fn embedded_vad_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法解析应用缓存目录: {error}"))?;
    Ok(cache_dir.join("vad").join(VAD_MODEL_FILE_NAME))
}

fn cached_vad_is_valid(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(meta) => meta.is_file() && meta.len() == VAD_MODEL_BYTES.len() as u64,
        Err(_) => false,
    }
}

fn materialize_embedded_vad_model(app: &AppHandle) -> Result<PathBuf, String> {
    if VAD_MODEL_BYTES.is_empty() {
        return Err("内置 VAD 模型为空，请重新打包应用。".into());
    }

    let target = embedded_vad_cache_path(app)?;
    if cached_vad_is_valid(&target) {
        return Ok(target);
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 VAD 缓存目录 {}: {error}", parent.display()))?;
    }

    let temp_target = target.with_extension("onnx.tmp");
    {
        let mut file = fs::File::create(&temp_target).map_err(|error| {
            format!(
                "无法写入 VAD 缓存文件 {}: {error}",
                temp_target.display()
            )
        })?;
        file.write_all(VAD_MODEL_BYTES).map_err(|error| {
            format!(
                "无法写入 VAD 缓存文件 {}: {error}",
                temp_target.display()
            )
        })?;
    }

    fs::rename(&temp_target, &target).map_err(|error| {
        format!(
            "无法完成 VAD 缓存文件 {}: {error}",
            target.display()
        )
    })?;

    Ok(target)
}

fn resolve_vad_model_path(app: &AppHandle) -> Option<PathBuf> {
    materialize_embedded_vad_model(app).ok()
}

fn active_vad_model_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = ACTIVE_VAD_MODEL.get() {
        if path.is_file() {
            return Some(path.clone());
        }
    }
    resolve_vad_model_path(app)
}

fn missing_models_message() -> String {
    "内置 VAD 模型不可用，请重新打包应用。".into()
}

pub fn emit_status(app: &AppHandle, status: VoiceAsrStatus) {
    let _ = app.emit(
        super::voice_engine::EVENT_NAME,
        VoiceAsrStatusEvent::AsrStatus {
            state: status.state,
            message: status.message,
            progress: status.progress,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::{VAD_MODEL_BYTES, VAD_MODEL_FILE_NAME};

    #[test]
    fn embedded_vad_model_is_non_empty() {
        assert!(!VAD_MODEL_BYTES.is_empty());
        assert!(VAD_MODEL_BYTES.len() > 1_000_000);
    }

    #[test]
    fn embedded_vad_model_file_name_is_stable() {
        assert_eq!(VAD_MODEL_FILE_NAME, "silero_vad.onnx");
    }
}
