use std::{
    collections::VecDeque,
    sync::{Mutex, MutexGuard},
    time::Instant,
};

use serde::Serialize;
use sherpa_onnx::{
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};
use tauri::{AppHandle, Emitter, State};

use crate::voice_models::{self, VoiceModelPaths};

pub const EVENT_NAME: &str = "voice-engine-event";
const SAMPLE_RATE: i32 = 16000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionMode {
    Hold,
    Call,
}

impl SessionMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "hold" | "push" => Ok(Self::Hold),
            "call" => Ok(Self::Call),
            other => Err(format!("Unsupported voice session mode: {other}")),
        }
    }
}

#[derive(Debug)]
struct VoiceSession {
    utterance_seq: u64,
    speech_active: bool,
    utterance_started_at: Option<Instant>,
}

impl VoiceSession {
    fn new() -> Self {
        Self {
            utterance_seq: 0,
            speech_active: false,
            utterance_started_at: None,
        }
    }

    fn next_utterance_id(&mut self) -> String {
        self.utterance_seq += 1;
        format!("tauri-local-{}", self.utterance_seq)
    }
}

struct VoiceEngine {
    vad: VoiceActivityDetector,
    session: Option<VoiceSession>,
    pre_speech_buffer: VecDeque<f32>,
    speech_start_pre_speech: Option<(Vec<f32>, usize)>,
    total_samples_accepted: usize,
}

impl VoiceEngine {
    fn new(model_paths: VoiceModelPaths) -> Result<Self, String> {
        let vad_config = VadModelConfig {
            silero_vad: SileroVadModelConfig {
                model: Some(model_paths.vad_model.to_string_lossy().into_owned()),
                threshold: 0.4,
                min_silence_duration: 0.6,
                min_speech_duration: 0.15,
                window_size: 512,
                max_speech_duration: 20.0,
            },
            sample_rate: SAMPLE_RATE,
            num_threads: 1,
            provider: Some("cpu".into()),
            debug: false,
            ..Default::default()
        };

        let vad = VoiceActivityDetector::create(&vad_config, 30.0)
            .ok_or_else(|| "Failed to create Sherpa-ONNX voice activity detector".to_string())?;

        Ok(Self {
            vad,
            session: None,
            pre_speech_buffer: VecDeque::with_capacity(8000),
            speech_start_pre_speech: None,
            total_samples_accepted: 0,
        })
    }

    fn start_session(&mut self, _mode: SessionMode) {
        self.vad.clear();
        self.vad.reset();
        self.pre_speech_buffer.clear();
        self.speech_start_pre_speech = None;
        self.total_samples_accepted = 0;
        self.session = Some(VoiceSession::new());
    }

    fn stop_session(&mut self) {
        self.vad.clear();
        self.vad.reset();
        self.pre_speech_buffer.clear();
        self.speech_start_pre_speech = None;
        self.total_samples_accepted = 0;
        self.session = None;
    }

    fn push_pcm(&mut self, app: &AppHandle, samples: Vec<i16>) -> Result<(), String> {
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| "Voice session has not been started".to_string())?;

        if samples.is_empty() {
            return Ok(());
        }

        let waveform: Vec<f32> = samples
            .into_iter()
            .map(|s| s as f32 / 32768.0)
            .collect();

        // If speech is not currently active, keep a rolling buffer of the last 500ms (8000 samples)
        const PRE_SPEECH_PAD_SAMPLES: usize = 8000;
        if !session.speech_active {
            for &sample in &waveform {
                self.pre_speech_buffer.push_back(sample);
                if self.pre_speech_buffer.len() > PRE_SPEECH_PAD_SAMPLES {
                    self.pre_speech_buffer.pop_front();
                }
            }
        }

        self.total_samples_accepted += waveform.len();

        self.vad.accept_waveform(&waveform);

        if self.vad.detected() && !session.speech_active {
            session.speech_active = true;
            session.utterance_started_at = Some(Instant::now());
            // Clone the current pre-speech buffer as our starting audio padding
            let pre_speech_samples: Vec<f32> = self.pre_speech_buffer.iter().copied().collect();
            self.speech_start_pre_speech = Some((pre_speech_samples, self.total_samples_accepted));
            self.pre_speech_buffer.clear();

            emit_event(
                app,
                VoiceEvent::VadStart {
                    utterance_id: Some(session.next_utterance_id()),
                },
            )?;
        }

        self.drain_segments(app)
    }

    fn flush(&mut self, app: &AppHandle) -> Result<(), String> {
        if self.session.is_none() {
            return Ok(());
        }
        self.vad.flush();
        self.drain_segments(app)?;
        self.stop_session();
        emit_event(app, VoiceEvent::Closed)
    }

    fn drain_segments(&mut self, app: &AppHandle) -> Result<(), String> {
        while self.vad.front().is_some() {
            let utterance_id = self
                .session
                .as_ref()
                .map(|s| format!("tauri-local-{}", s.utterance_seq))
                .filter(|v| !v.is_empty());

            emit_event(
                app,
                VoiceEvent::VadEnd {
                    utterance_id: utterance_id.clone(),
                },
            )?;

            self.vad.pop();
            self.speech_start_pre_speech = None;

            if let Some(session) = self.session.as_mut() {
                session.speech_active = false;
                session.utterance_started_at = None;
            }
        }

        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "type")]
enum VoiceEvent {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "vad_start")]
    VadStart {
        #[serde(rename = "utteranceId", skip_serializing_if = "Option::is_none")]
        utterance_id: Option<String>,
    },
    #[serde(rename = "vad_end")]
    VadEnd {
        #[serde(rename = "utteranceId", skip_serializing_if = "Option::is_none")]
        utterance_id: Option<String>,
    },
    #[serde(rename = "closed")]
    Closed,
}

fn emit_event(app: &AppHandle, event: VoiceEvent) -> Result<(), String> {
    app.emit(EVENT_NAME, event)
        .map_err(|e| e.to_string())
}

pub struct VoiceEngineState(Mutex<Option<VoiceEngine>>);

impl Default for VoiceEngineState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn lock_engine<'a>(
    state: &'a State<'_, VoiceEngineState>,
) -> Result<MutexGuard<'a, Option<VoiceEngine>>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Voice engine lock poisoned".to_string())
}

#[tauri::command]
pub fn voice_get_status() -> voice_models::VoiceAsrStatus {
    voice_models::current_status()
}

#[tauri::command]
pub fn voice_init(app: AppHandle, state: State<'_, VoiceEngineState>) -> Result<(), String> {
    if !voice_models::is_ready() {
        return Err(voice_models::current_status()
            .message
            .unwrap_or_else(|| "端侧 VAD 暂不可用".into()));
    }
    let mut engine = lock_engine(&state)?;
    if engine.is_none() {
        let model_paths = voice_models::resolve_model_paths(&app)?;
        *engine = Some(VoiceEngine::new(model_paths)?);
    }
    Ok(())
}

#[tauri::command]
pub fn voice_start_session(
    app: AppHandle,
    state: State<'_, VoiceEngineState>,
    mode: String,
    punctuate: Option<bool>,
) -> Result<(), String> {
    let parsed_mode = SessionMode::parse(&mode)?;
    let _ = punctuate; // punctuation now handled by backend ASR
    let mut engine = lock_engine(&state)?;
    let engine = engine
        .as_mut()
        .ok_or_else(|| "Voice engine is not initialized".to_string())?;
    engine.start_session(parsed_mode);
    emit_event(&app, VoiceEvent::Ready)
}

#[tauri::command]
pub fn voice_push_pcm(
    app: AppHandle,
    state: State<'_, VoiceEngineState>,
    samples: Vec<i16>,
) -> Result<(), String> {
    let mut engine = lock_engine(&state)?;
    let engine = engine
        .as_mut()
        .ok_or_else(|| "Voice engine is not initialized".to_string())?;
    engine.push_pcm(&app, samples)
}

#[tauri::command]
pub fn voice_flush(app: AppHandle, state: State<'_, VoiceEngineState>) -> Result<(), String> {
    let mut engine = lock_engine(&state)?;
    let engine = engine
        .as_mut()
        .ok_or_else(|| "Voice engine is not initialized".to_string())?;
    engine.flush(&app)
}

#[tauri::command]
pub fn voice_stop_session(
    app: AppHandle,
    state: State<'_, VoiceEngineState>,
) -> Result<(), String> {
    let mut engine = lock_engine(&state)?;
    if let Some(engine) = engine.as_mut() {
        engine.stop_session();
    }
    emit_event(&app, VoiceEvent::Closed)
}
