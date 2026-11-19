//! macOS 系统语音识别（Speech 框架）。
//!
//! 前端 getUserMedia 采集 16kHz PCM16 后通过 Tauri 命令送入 Rust，
//! 这里用 SFSpeechAudioBufferRecognitionRequest 做流式识别，partial/final
//! 结果通过 `voice-engine-event` 事件回传前端（与 WS 服务端事件形状一致）。
//! 语句切分沿用前端 JS VAD：vad_end → flush → endAudio → 收 final。

use std::sync::{atomic::AtomicU64, Mutex};
#[cfg(target_os = "macos")]
use std::sync::{
    atomic::Ordering,
    mpsc, MutexGuard,
};
#[cfg(target_os = "macos")]
use std::time::Duration;

use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter, State};

#[cfg(target_os = "macos")]
use {
    block2::RcBlock,
    objc2::{rc::Retained, AnyThread},
    objc2_avf_audio::{AVAudioFormat, AVAudioPCMBuffer},
    objc2_foundation::{NSError, NSLocale, NSString},
    objc2_speech::{
        SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognizer,
        SFSpeechRecognizerAuthorizationStatus, SFSpeechRecognitionTask, SFSpeechRecognitionResult,
    },
    crate::voice_engine::EVENT_NAME,
};

const SAMPLE_RATE: f64 = 16_000.0;
// 设置页可主动弹授权弹窗，等用户点系统对话框需要给足时间。
#[cfg(target_os = "macos")]
const AUTH_TIMEOUT: Duration = Duration::from_secs(60);

static UTTERANCE_SEQ: AtomicU64 = AtomicU64::new(0);

/// 语言选项（设置页的 自动/中文/英文）→ Speech 框架的 locale id。
fn resolve_locale_id(language: Option<&str>) -> &'static str {
    match language.unwrap_or("auto") {
        "en" => "en-US",
        // auto/zh 默认中文普通话；英文用户可在设置里明确切到英文。
        _ => "zh-CN",
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppleSpeechStatus {
    /// 平台支持且该 locale 的识别器可用。
    pub available: bool,
    pub authorized: bool,
    /// notDetermined / denied / restricted / authorized
    pub authorization: String,
    /// 系统是否装了设备端语音包（装了才能离线；没装走 Apple 服务器识别）。
    pub on_device: bool,
    pub locale: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[cfg(target_os = "macos")]
struct AppleSpeechEngine {
    app: AppHandle,
    recognizer: Retained<SFSpeechRecognizer>,
    format: Retained<AVAudioFormat>,
    request: Option<Retained<SFSpeechAudioBufferRecognitionRequest>>,
    task: Option<Retained<SFSpeechRecognitionTask>>,
    /// 当前 request 已 endAudio，下一帧音频需要新开一条 utterance。
    request_ended: bool,
    utterance_id: String,
}

// SAFETY: 所有 ObjC 对象的访问都经 Mutex 串行化，Speech 框架 API 本身可跨线程
// 使用（SFSpeechRecognizer / SFSpeechAudioBufferRecognitionRequest 文档线程安全）；
// 结果回调只持有 AppHandle 与 String，不触碰引擎内部状态。
#[cfg(target_os = "macos")]
unsafe impl Send for AppleSpeechEngine {}
#[cfg(target_os = "macos")]
unsafe impl Sync for AppleSpeechEngine {}

#[cfg(not(target_os = "macos"))]
struct AppleSpeechEngine;

pub struct AppleSpeechState(Mutex<Option<AppleSpeechEngine>>);

impl Default for AppleSpeechState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[cfg(target_os = "macos")]
fn lock_state<'a>(
    state: &'a State<'_, AppleSpeechState>,
) -> Result<MutexGuard<'a, Option<AppleSpeechEngine>>, String> {
    state.0.lock().map_err(|_| "Apple speech lock poisoned".to_string())
}

#[cfg(target_os = "macos")]
fn authorization_label(status: SFSpeechRecognizerAuthorizationStatus) -> &'static str {
    if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
        "authorized"
    } else if status == SFSpeechRecognizerAuthorizationStatus::Denied {
        "denied"
    } else if status == SFSpeechRecognizerAuthorizationStatus::Restricted {
        "restricted"
    } else {
        "notDetermined"
    }
}

#[cfg(target_os = "macos")]
fn denial_message() -> String {
    "系统语音识别权限被拒绝，请到 系统设置 → 隐私与安全性 → 语音识别 中允许灵枢".to_string()
}

/// 查询系统语音识别状态，供设置面板与就绪判定使用。
#[cfg(target_os = "macos")]
fn status_impl(language: Option<&str>) -> AppleSpeechStatus {
    let locale_id = resolve_locale_id(language);
    let auth = unsafe { SFSpeechRecognizer::authorizationStatus() };
    let authorized = auth == SFSpeechRecognizerAuthorizationStatus::Authorized;

    let locale = NSLocale::initWithLocaleIdentifier(
        NSLocale::alloc(),
        &NSString::from_str(locale_id),
    );
    let recognizer = unsafe {
        SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale)
    };

    let mut message: Option<String> = None;
    let (available, on_device) = match recognizer {
        None => {
            message = Some("此系统不支持所选语言的语音识别".to_string());
            (false, false)
        }
        Some(recognizer) => {
            let recognizer_available = unsafe { recognizer.isAvailable() };
            let on_device = unsafe { recognizer.supportsOnDeviceRecognition() };
            if !recognizer_available {
                message = Some("系统语音识别服务暂不可用（可能需要网络）".to_string());
            }
            (recognizer_available, on_device)
        }
    };

    if authorized && available && !on_device && message.is_none() {
        message = Some(
            "未检测到设备端语音包，将走 Apple 服务器识别（需联网，单段约 1 分钟上限）".to_string(),
        );
    }

    AppleSpeechStatus {
        available,
        authorized,
        authorization: authorization_label(auth).to_string(),
        on_device,
        locale: locale_id.to_string(),
        message,
    }
}

#[cfg(not(target_os = "macos"))]
fn status_impl(_language: Option<&str>) -> AppleSpeechStatus {
    AppleSpeechStatus {
        available: false,
        authorized: false,
        authorization: "denied".to_string(),
        on_device: false,
        locale: "zh-CN".to_string(),
        message: Some("macOS 系统识别仅支持 macOS".to_string()),
    }
}

/// 等待语音识别授权（未决定时弹系统弹窗并阻塞等待用户选择）。
#[cfg(target_os = "macos")]
fn ensure_authorized() -> Result<(), String> {
    let status = unsafe { SFSpeechRecognizer::authorizationStatus() };
    if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
        return Ok(());
    }
    if status == SFSpeechRecognizerAuthorizationStatus::Denied
        || status == SFSpeechRecognizerAuthorizationStatus::Restricted
    {
        return Err(denial_message());
    }

    let (tx, rx) = mpsc::channel();
    let handler = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
        let _ = tx.send(status);
    });
    unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };

    match rx.recv_timeout(AUTH_TIMEOUT) {
        Ok(status) if status == SFSpeechRecognizerAuthorizationStatus::Authorized => Ok(()),
        Ok(_) => Err(denial_message()),
        Err(_) => Err("等待系统语音识别授权超时，请重试".to_string()),
    }
}

/// 为一条新语句创建识别请求，结果通过 voice-engine-event 事件回传。
#[cfg(target_os = "macos")]
fn start_utterance(
    app: &AppHandle,
    recognizer: &SFSpeechRecognizer,
    utterance_id: String,
) -> Result<
    (
        Retained<SFSpeechAudioBufferRecognitionRequest>,
        Retained<SFSpeechRecognitionTask>,
    ),
    String,
> {
    let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
    unsafe {
        request.setShouldReportPartialResults(true);
        // macOS 13+：让系统补标点，中文断句体验更好。
        request.setAddsPunctuation(true);
    }

    let app_for_handler = app.clone();
    let id_for_handler = utterance_id.clone();
    let handler = RcBlock::new(
        move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
            if !error.is_null() {
                let detail = unsafe { (*error).localizedDescription().to_string() };
                let _ = app_for_handler.emit(
                    EVENT_NAME,
                    serde_json::json!({
                        "type": "error",
                        "detail": format!("系统语音识别出错：{detail}"),
                    }),
                );
                return;
            }
            if result.is_null() {
                return;
            }
            let result = unsafe { &*result };
            let (text, is_final) = unsafe {
                let text = result
                    .bestTranscription()
                    .formattedString()
                    .to_string()
                    .trim()
                    .to_string();
                (text, result.isFinal())
            };
            let event_type = if is_final {
                "asr_final"
            } else {
                "asr_partial"
            };
            let _ = app_for_handler.emit(
                EVENT_NAME,
                serde_json::json!({
                    "type": event_type,
                    "text": text,
                    "utteranceId": id_for_handler,
                    "transport": "apple_speech",
                    "asrModel": "apple-speech",
                }),
            );
        },
    );

    let task = unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };
    Ok((request, task))
}

#[cfg(target_os = "macos")]
fn push_pcm_impl(
    state: &State<'_, AppleSpeechState>,
    samples: Vec<i16>,
) -> Result<(), String> {
    if samples.is_empty() {
        return Ok(());
    }
    let mut engine = lock_state(state)?;
    let engine = engine
        .as_mut()
        .ok_or_else(|| "Apple speech session has not been started".to_string())?;

    // 上一条语句已 flush（endAudio），新的一帧音频自动开新请求。
    if engine.request_ended || engine.request.is_none() {
        let utterance_id = format!("apple-{}", UTTERANCE_SEQ.fetch_add(1, Ordering::Relaxed) + 1);
        let (request, task) =
            start_utterance(&engine.app, &engine.recognizer, utterance_id.clone())?;
        engine.request = Some(request);
        engine.task = Some(task);
        engine.request_ended = false;
        engine.utterance_id = utterance_id;
    }

    let request = engine.request.as_ref().expect("request recreated above");
    let waveform: Vec<f32> = samples.into_iter().map(|s| s as f32 / 32_768.0).collect();
    let frames = waveform.len() as u32;

    let buffer = unsafe {
        AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
            AVAudioPCMBuffer::alloc(),
            &engine.format,
            frames,
        )
    }
    .ok_or_else(|| "Failed to allocate PCM buffer".to_string())?;
    unsafe {
        let channels = buffer.floatChannelData();
        let channel0 = channels.read().as_ptr();
        std::ptr::copy_nonoverlapping(waveform.as_ptr(), channel0, frames as usize);
        buffer.setFrameLength(frames);
        request.appendAudioPCMBuffer(&buffer);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn push_pcm_impl(_state: &State<'_, AppleSpeechState>, _samples: Vec<i16>) -> Result<(), String> {
    Err("macOS 系统识别仅支持 macOS".to_string())
}

#[cfg(target_os = "macos")]
fn flush_impl(state: &State<'_, AppleSpeechState>) -> Result<(), String> {
    let mut engine = lock_state(state)?;
    let engine = engine
        .as_mut()
        .ok_or_else(|| "Apple speech session has not been started".to_string())?;
    if let Some(request) = engine.request.as_ref() {
        unsafe { request.endAudio() };
    }
    engine.request_ended = true;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn flush_impl(_state: &State<'_, AppleSpeechState>) -> Result<(), String> {
    Err("macOS 系统识别仅支持 macOS".to_string())
}

#[cfg(target_os = "macos")]
fn start_session_impl(
    app: AppHandle,
    state: State<'_, AppleSpeechState>,
    language: Option<String>,
) -> Result<(), String> {
    // 授权已由命令入口的 ensure_authorized_off_main().await 完成
    let locale_id = resolve_locale_id(language.as_deref());
    let locale = NSLocale::initWithLocaleIdentifier(
        NSLocale::alloc(),
        &NSString::from_str(locale_id),
    );
    let recognizer = unsafe {
        SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale)
    }
    .ok_or_else(|| "此系统不支持所选语言的语音识别".to_string())?;
    if !unsafe { recognizer.isAvailable() } {
        return Err("系统语音识别服务暂不可用（可能需要网络）".to_string());
    }

    let format = unsafe {
        AVAudioFormat::initStandardFormatWithSampleRate_channels(
            AVAudioFormat::alloc(),
            SAMPLE_RATE,
            1,
        )
    }
    .ok_or_else(|| "Failed to create audio format".to_string())?;

    let mut engine = lock_state(&state)?;
    *engine = Some(AppleSpeechEngine {
        app: app.clone(),
        recognizer,
        format,
        request: None,
        task: None,
        request_ended: false,
        utterance_id: String::new(),
    });
    app.emit(EVENT_NAME, serde_json::json!({ "type": "ready" }))
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn start_session_impl(
    _app: AppHandle,
    _state: State<'_, AppleSpeechState>,
    _language: Option<String>,
) -> Result<(), String> {
    Err("macOS 系统识别仅支持 macOS".to_string())
}

#[cfg(target_os = "macos")]
fn stop_session_impl(state: State<'_, AppleSpeechState>) -> Result<(), String> {
    let mut engine = lock_state(&state)?;
    if let Some(session) = engine.take() {
        if let Some(task) = session.task.as_ref() {
            unsafe { task.cancel() };
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn stop_session_impl(_state: State<'_, AppleSpeechState>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn apple_speech_status(language: Option<String>) -> AppleSpeechStatus {
    status_impl(language.as_deref())
}

/// start_session / request_authorization 都可能阻塞等待系统授权弹窗。
/// Tauri 同步命令跑在主线程，而系统授权弹窗恰恰要靠主线程 runloop 才能弹出，
/// 在主线程里等回调会死锁被看门狗杀掉——所以这两个命令必须是 async，
/// 阻塞段丢进 spawn_blocking，给 runloop 留出弹窗的机会。
#[cfg(target_os = "macos")]
async fn ensure_authorized_off_main() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(ensure_authorized)
        .await
        .map_err(|e| format!("授权任务异常退出: {e}"))?
}

#[cfg(not(target_os = "macos"))]
async fn ensure_authorized_off_main() -> Result<(), String> {
    Err("macOS 系统识别仅支持 macOS".to_string())
}

#[tauri::command]
pub async fn apple_speech_start_session(
    app: AppHandle,
    state: State<'_, AppleSpeechState>,
    language: Option<String>,
) -> Result<(), String> {
    ensure_authorized_off_main().await?;
    start_session_impl(app, state, language)
}

#[tauri::command]
pub fn apple_speech_push_pcm(
    state: State<'_, AppleSpeechState>,
    samples: Vec<i16>,
) -> Result<(), String> {
    push_pcm_impl(&state, samples)
}

#[tauri::command]
pub fn apple_speech_flush(state: State<'_, AppleSpeechState>) -> Result<(), String> {
    flush_impl(&state)
}

#[tauri::command]
pub fn apple_speech_stop_session(state: State<'_, AppleSpeechState>) -> Result<(), String> {
    stop_session_impl(state)
}

/// 设置页主动请求授权：未决定时弹系统弹窗并等待用户选择，
/// 返回请求后的最新状态（前端拿它直接刷新面板）。
#[tauri::command]
pub async fn apple_speech_request_authorization() -> AppleSpeechStatus {
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(|| match ensure_authorized() {
            Ok(()) => status_impl(None),
            Err(message) => {
                let mut status = status_impl(None);
                status.message = Some(message);
                status
            }
        })
        .await
        .unwrap_or_else(|_| status_impl(None));
    }
    #[cfg(not(target_os = "macos"))]
    status_impl(None)
}
