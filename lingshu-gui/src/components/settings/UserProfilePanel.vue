<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';
import Message from '@arco-design/web-vue/es/message';
import IconUser from '@arco-design/web-vue/es/icon/icon-user';
import IconSound from '@arco-design/web-vue/es/icon/icon-sound';
import { getFullUrl } from '../../utils/apiConfig';

interface UserProfile {
  userId: string;
  nickname: string;
  gender: string;
  age: number;
  bio: string;
  voiceprintEnabled: boolean;
  voiceprintThreshold: number;
  voiceprintSampleCount: number;
  hasVoiceprint: boolean;
}

const profile = ref<UserProfile>({
  userId: 'default_user',
  nickname: '',
  gender: '保密',
  age: 0,
  bio: '',
  voiceprintEnabled: false,
  voiceprintThreshold: 0.65,
  voiceprintSampleCount: 0,
  hasVoiceprint: false,
});

const loading = ref(false);

// 档案自动保存：修改后防抖提交，标题右侧给出轻提示
const saveState = ref<'idle' | 'saving' | 'saved'>('idle');
let saveStateTimer: ReturnType<typeof setTimeout> | null = null;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let suppressAutoSave = false;

// 录音 / 声纹录入状态
const isRecording = ref(false);
const recordMode = ref<'enroll' | 'verify'>('enroll');
const recordDuration = ref(0);
const recordAudioChunks = ref<Blob[]>([]);
const isEnrolling = ref(false);
const isVerifying = ref(false);
const verifyResult = ref<{ matched: boolean; score: number; message: string } | null>(null);

let mediaRecorder: MediaRecorder | null = null;
let recordTimer: number | null = null;

const genderOptions = [
  { label: '保密', value: '保密' },
  { label: '男', value: '男' },
  { label: '女', value: '女' },
  { label: '其他', value: '其他' },
];

onMounted(() => {
  void fetchUserProfile();
});

/** 回填服务端数据时不触发自动保存 */
async function applyProfile(data: UserProfile) {
  suppressAutoSave = true;
  profile.value = data;
  await nextTick();
  suppressAutoSave = false;
}

function markSaved() {
  saveState.value = 'saved';
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    saveState.value = 'idle';
  }, 2500);
}

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    void handleSaveProfile();
  }, 600);
}

watch(
  () => [profile.value.nickname, profile.value.gender, profile.value.age, profile.value.bio],
  () => {
    if (suppressAutoSave) return;
    scheduleAutoSave();
  },
);

async function fetchUserProfile() {
  loading.value = true;
  try {
    const res = await fetch(getFullUrl('/api/v1/user/profile'));
    if (!res.ok) throw new Error('获取用户资料失败');
    const data = await res.json();
    await applyProfile(data);
  } catch (err) {
    Message.error(err instanceof Error ? err.message : '加载用户信息失败');
  } finally {
    loading.value = false;
  }
}

async function handleSaveProfile() {
  saveState.value = 'saving';
  try {
    const res = await fetch(getFullUrl('/api/v1/user/profile'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nickname: profile.value.nickname,
        gender: profile.value.gender,
        age: profile.value.age,
        bio: profile.value.bio,
        voiceprintEnabled: profile.value.voiceprintEnabled,
        voiceprintThreshold: profile.value.voiceprintThreshold,
      }),
    });
    if (!res.ok) throw new Error('保存用户资料失败');
    const data = await res.json();
    await applyProfile(data);
    markSaved();
  } catch (err) {
    saveState.value = 'idle';
    Message.error(err instanceof Error ? err.message : '保存失败');
  }
}

let thresholdDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function handleThresholdChange() {
  if (thresholdDebounceTimer) {
    clearTimeout(thresholdDebounceTimer);
  }
  thresholdDebounceTimer = setTimeout(() => {
    handleSaveProfile();
  }, 400);
}

async function handleToggleVoiceprint(enabled: boolean) {
  if (enabled && !profile.value.hasVoiceprint) {
    Message.warning('请先录入主人声纹样本，才能开启主人声纹过滤');
    profile.value.voiceprintEnabled = false;
    return;
  }
  profile.value.voiceprintEnabled = enabled;
  await handleSaveProfile();
}

async function startRecording(mode: 'enroll' | 'verify') {
  recordMode.value = mode;
  verifyResult.value = null;
  recordAudioChunks.value = [];
  recordDuration.value = 0;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordAudioChunks.value.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const audioBlob = new Blob(recordAudioChunks.value, { type: 'audio/webm' });
      await processRecordedAudio(audioBlob);
    };

    mediaRecorder.start(250);
    isRecording.value = true;

    recordTimer = window.setInterval(() => {
      recordDuration.value += 1;
      if (recordDuration.value >= 10) {
        stopRecording();
      }
    }, 1000);
  } catch (err) {
    Message.error('无法访问麦克风，请检查录音权限');
  }
}

function stopRecording() {
  if (recordTimer) {
    clearInterval(recordTimer);
    recordTimer = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  isRecording.value = false;
}

async function blobToBase64(blob: Blob): Promise<string> {
  // Convert WebM/audio to 16kHz PCM or standard WAV arrayBuffer
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  // 导出单声道 16000Hz WAV
  const wavBytes = audioBufferToWav(audioBuffer, 16000);
  let binary = '';
  const bytes = new Uint8Array(wavBytes);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function audioBufferToWav(buffer: AudioBuffer, targetSampleRate = 16000): ArrayBuffer {
  const numChannels = 1;
  const channelData = buffer.getChannelData(0);

  // 降采样到 16kHz
  const sampleRateRatio = buffer.sampleRate / targetSampleRate;
  const newLength = Math.round(channelData.length / sampleRateRatio);
  const samples = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = Math.round(i * sampleRateRatio);
    samples[i] = channelData[srcIndex] || 0;
  }

  const dataLength = samples.length * 2;
  const bufferOut = new ArrayBuffer(44 + dataLength);
  const view = new DataView(bufferOut);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');

  // FMT sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Write PCM samples
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bufferOut;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

async function processRecordedAudio(blob: Blob) {
  if (recordDuration.value < 2) {
    Message.warning('录音时间太短（需至少 2 秒以上），请重试');
    return;
  }

  try {
    const base64Audio = await blobToBase64(blob);
    if (recordMode.value === 'enroll') {
      isEnrolling.value = true;
      const res = await fetch(getFullUrl('/api/v1/user/voiceprint/enroll'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: base64Audio, append: profile.value.hasVoiceprint }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '声纹录入失败');
      Message.success(data.message || '主人声纹录入成功！');
      await fetchUserProfile();
    } else {
      isVerifying.value = true;
      const res = await fetch(getFullUrl('/api/v1/user/voiceprint/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: base64Audio, threshold: profile.value.voiceprintThreshold }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || '声纹比对失败');
      verifyResult.value = {
        matched: data.matched,
        score: Math.round(data.score * 100),
        message: data.message,
      };
    }
  } catch (err) {
    Message.error(err instanceof Error ? err.message : '处理录音失败');
  } finally {
    isEnrolling.value = false;
    isVerifying.value = false;
  }
}

async function handleClearVoiceprint() {
  try {
    const res = await fetch(getFullUrl('/api/v1/user/voiceprint/clear'), { method: 'POST' });
    if (!res.ok) throw new Error('清除失败');
    Message.success('已清空声纹特征');
    await fetchUserProfile();
  } catch (err) {
    Message.error(err instanceof Error ? err.message : '清除声纹失败');
  }
}
</script>

<template>
  <div class="user-profile-panel">
    <div class="my-grid">
      <!-- 卡片 1: 用户档案 -->
      <section class="my-card">
        <header class="my-card-header">
          <div class="my-card-title">
            <IconUser class="card-icon" />
            <span>用户档案</span>
            <span v-if="saveState === 'saving'" class="save-hint is-saving">保存中…</span>
            <span v-else-if="saveState === 'saved'" class="save-hint">已自动保存</span>
          </div>
          <span class="my-card-desc">让智能体更懂你：称呼、背景与偏好，修改后自动保存</span>
        </header>

        <div class="my-card-body">
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">你的昵称 / 称呼</span>
              <span class="sub-text">智能体在对话中对你的专属称呼</span>
            </div>
            <div class="row-action">
              <a-input
                v-model="profile.nickname"
                placeholder="例如：主人、小明"
                :style="{ width: '140px' }"
                size="small"
              />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">性别</span>
              <span class="sub-text">用于对话风格与共情视角参考</span>
            </div>
            <div class="row-action">
              <a-select
                v-model="profile.gender"
                :options="genderOptions"
                :style="{ width: '140px' }"
                size="small"
              />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">年龄</span>
              <span class="sub-text">填写 0 为保密</span>
            </div>
            <div class="row-action">
              <a-input-number
                v-model="profile.age"
                :min="0"
                :max="150"
                :style="{ width: '140px' }"
                size="small"
              />
            </div>
          </div>

          <div class="setting-row is-column">
            <div class="row-label">
              <span class="main-text">个人介绍与偏好</span>
              <span class="sub-text">你可以告诉智能体你的性格、生活习惯、雷点或喜好，帮助她更懂你</span>
            </div>
            <a-textarea
              v-model="profile.bio"
              placeholder="例如：平时喜欢安静，偶尔会熬夜写代码；不喜欢被说教，喜欢幽默温柔的语气..."
              :auto-size="{ minRows: 3, maxRows: 8 }"
            />
          </div>
        </div>
      </section>

      <!-- 卡片 2: 专属声纹 -->
      <section class="my-card">
        <header class="my-card-header">
          <div class="my-card-title">
            <IconSound class="card-icon" />
            <span>专属声纹</span>
          </div>
          <span class="my-card-desc">录入主人声音，实时通话只听你的</span>
        </header>

        <div class="my-card-body">
          <!-- 行 1: 主人声纹录入状态与操作 -->
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">主人声纹样本</span>
              <span class="sub-text">
                {{ profile.hasVoiceprint
                  ? `已录入主人声纹特征（已融合 ${profile.voiceprintSampleCount} 次录音样本）`
                  : '尚未录入。录制 3~5 秒说话语音即可提取你的专属声学特征' }}
              </span>
            </div>
            <div class="row-action" style="display: flex; align-items: center; gap: 8px;">
              <a-tooltip :content="profile.hasVoiceprint ? '追加 / 重新录入声纹' : '开始录入声纹'">
                <a-button
                  v-if="!isRecording"
                  :type="profile.hasVoiceprint ? 'secondary' : 'primary'"
                  shape="circle"
                  size="small"
                  :loading="isEnrolling"
                  @click="startRecording('enroll')"
                >
                  <template #icon>
                    <span class="material-symbols-outlined icon-btn-glyph">mic</span>
                  </template>
                </a-button>
              </a-tooltip>

              <a-tooltip v-if="isRecording" :content="`停止录音 (${recordDuration}s)`">
                <a-button
                  type="primary"
                  status="danger"
                  shape="circle"
                  size="small"
                  @click="stopRecording"
                >
                  <template #icon>
                    <span class="material-symbols-outlined icon-btn-glyph">stop</span>
                  </template>
                </a-button>
              </a-tooltip>

              <a-tooltip v-if="profile.hasVoiceprint && !isRecording" content="清除声纹">
                <a-button
                  type="text"
                  status="danger"
                  shape="circle"
                  size="small"
                  @click="handleClearVoiceprint"
                >
                  <template #icon>
                    <span class="material-symbols-outlined icon-btn-glyph">delete_outline</span>
                  </template>
                </a-button>
              </a-tooltip>
            </div>
          </div>

          <!-- 录音提示栏（仅录音时展开） -->
          <div v-if="isRecording" class="recording-tip-bar">
            <span class="pulsing-dot"></span>
            <span>正在录音中... 请自然说话 3 秒以上，然后点击停止录音。</span>
          </div>

          <!-- 行 2: “只听主人的话”声纹过滤开关 -->
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">“只听主人的话”声纹过滤</span>
              <span class="sub-text">实时通话时，仅放行主人的说话，自动拦截旁人插话或电视背景杂音</span>
            </div>
            <div class="row-action">
              <a-switch
                :model-value="profile.voiceprintEnabled"
                :disabled="!profile.hasVoiceprint"
                @change="(val) => handleToggleVoiceprint(Boolean(val))"
              />
            </div>
          </div>

          <!-- 行 3: 比对严格度滑块 -->
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">声纹比对严格度 (相似度阈值)</span>
              <span class="sub-text">
                默认 0.65。越靠近 0.8 越严格（防误触更好，但声音沙哑可能偶被拦截）；越靠近 0.5 越宽松。
              </span>
            </div>
            <div class="row-action" style="display: flex; align-items: center; gap: 12px;">
              <a-slider
                v-model="profile.voiceprintThreshold"
                :min="0.4"
                :max="0.9"
                :step="0.01"
                :style="{ width: '160px' }"
                @change="handleThresholdChange"
              />
              <span class="slider-val">{{ (profile.voiceprintThreshold * 100).toFixed(0) }}%</span>
            </div>
          </div>

          <!-- 行 4: 声纹测试比对（已录入时展示） -->
          <div v-if="profile.hasVoiceprint" class="setting-row">
            <div class="row-label">
              <span class="main-text">声纹识别测试</span>
              <span class="sub-text">
                {{ verifyResult
                  ? `${verifyResult.message}（相似度匹配得分：${verifyResult.score}%，门限 ${(profile.voiceprintThreshold * 100).toFixed(0)}%）`
                  : '说一句话，测试系统是否能准确识别出你的声音并判定匹配得分' }}
              </span>
            </div>
            <div class="row-action">
              <a-tooltip v-if="!isRecording" content="试音比对测试">
                <a-button
                  shape="circle"
                  size="small"
                  :loading="isVerifying"
                  @click="startRecording('verify')"
                >
                  <template #icon>
                    <span class="material-symbols-outlined icon-btn-glyph">record_voice_over</span>
                  </template>
                </a-button>
              </a-tooltip>
              <a-tooltip v-else-if="recordMode === 'verify'" :content="`完成试音 (${recordDuration}s)`">
                <a-button
                  type="primary"
                  status="danger"
                  shape="circle"
                  size="small"
                  @click="stopRecording"
                >
                  <template #icon>
                    <span class="material-symbols-outlined icon-btn-glyph">stop</span>
                  </template>
                </a-button>
              </a-tooltip>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.user-profile-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
}

/* 宽屏双列等高，窄屏自动堆叠 */
.my-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(460px, 1fr));
  gap: 16px;
}

.my-card {
  display: flex;
  flex-direction: column;
  background-color: var(--bg-input);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.my-card-header {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 14px 20px 12px;
  border-bottom: 1px solid var(--border-color);
}

.my-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--text-primary);
}

.card-icon {
  font-size: 16px;
  color: var(--color-primary);
}

.my-card-desc {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.my-card-body {
  flex: 1;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-color);
}

.my-card-body .setting-row:last-child {
  border-bottom: none;
}

.setting-row.is-column {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
}

.row-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 58%;
}

.setting-row.is-column .row-label {
  max-width: none;
}

.main-text {
  font-size: var(--font-size-md);
  color: var(--text-primary);
}

.sub-text {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  line-height: 1.4;
}

.row-action {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

/* 自动保存状态提示 */
.save-hint {
  margin-left: auto;
  font-size: var(--font-size-sm);
  color: var(--color-primary);
  animation: save-hint-in 0.2s ease;
}

.save-hint.is-saving {
  color: var(--text-tertiary);
}

@keyframes save-hint-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: none; }
}

/* 录音动态提示条 */
.recording-tip-bar {
  margin: 4px 20px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-danger, #e65100) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-danger, #e65100) 30%, transparent);
  font-size: 12px;
  color: var(--text-primary);
}

.pulsing-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-danger, #e65100);
  animation: pulse 1s infinite alternate;
}

@keyframes pulse {
  0% { transform: scale(0.8); opacity: 0.5; }
  100% { transform: scale(1.3); opacity: 1; }
}

.slider-val {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-primary);
  min-width: 36px;
}

.icon-btn-glyph {
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
