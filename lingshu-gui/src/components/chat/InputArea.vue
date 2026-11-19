<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue';
import IconFaceSmileFill from '@arco-design/web-vue/es/icon/icon-face-smile-fill';
import IconFolder from '@arco-design/web-vue/es/icon/icon-folder';
import IconScissor from '@arco-design/web-vue/es/icon/icon-scissor';
import IconVoice from '@arco-design/web-vue/es/icon/icon-voice';
import IconDown from '@arco-design/web-vue/es/icon/icon-down';

import IconClose from '@arco-design/web-vue/es/icon/icon-close';
import IconFile from '@arco-design/web-vue/es/icon/icon-file';
import EmojiPicker from '../emoji/EmojiPicker.vue';
import {
  extractPlainTextFromEditor,
  ensureEditorSelection,
  insertHtmlAtCaret,
  placeCaretAtEnd,
  plainTextToEditorHtml,
  renderEmojiInsertHtml,
} from '../emoji/inputEditor';
import { preloadEmojiAssets } from '../emoji/render';
import { useVoiceChat } from '../../composables/useVoiceChat';
import { VOICE_HINT } from '../../composables/voiceConnectionCopy';
import { useTts } from '../../composables/useTts';
const emit = defineEmits<{
  send: [content: string, attachments: any[]];
  'update:mode': [mode: 'auto' | 'task' | 'chat'];
}>();

const props = defineProps<{
  sessionId?: string | number | null;
  mode?: 'auto' | 'task' | 'chat';
  /** 未开通 Pro / 会员到期：只读，保留历史但禁止发消息。 */
  locked?: boolean;
  lockedHint?: string;
}>();

const inputText = ref('');
const inputHeight = ref(180);
const isResizing = ref(false);
const startY = ref(0);
const startHeight = ref(0);

// 表情面板状态与插入逻辑
const isEmojiPickerVisible = ref(false);
let syncingFromEditor = false;

function focusEditor(moveCursorToEnd = false) {
  nextTick(() => {
    const editor = editorRef.value;
    if (!editor) return;
    editor.focus();
    if (moveCursorToEnd) {
      placeCaretAtEnd(editor);
    }
  });
}

function syncEditorFromText(text: string, moveCursorToEnd = false) {
  const editor = editorRef.value;
  if (!editor) return;
  syncingFromEditor = true;
  editor.innerHTML = plainTextToEditorHtml(text);
  syncingFromEditor = false;
  if (moveCursorToEnd) {
    placeCaretAtEnd(editor);
  }
}

function handleEditorInput() {
  const editor = editorRef.value;
  if (!editor || syncingFromEditor) return;
  syncingFromEditor = true;
  inputText.value = extractPlainTextFromEditor(editor);
  syncingFromEditor = false;
  if (isCallActive.value && !callDraftPreview.value) {
    callInputBase = inputText.value;
  }
}

function handleEmojiSelect(emoji: { name: string; code: string }) {
  const editor = editorRef.value;
  if (!editor) {
    inputText.value += emoji.code;
    syncEditorFromText(inputText.value, true);
    isEmojiPickerVisible.value = false;
    return;
  }

  ensureEditorSelection(editor);
  const inserted = insertHtmlAtCaret(renderEmojiInsertHtml(emoji.code));
  if (!inserted) {
    inputText.value += emoji.code;
    syncEditorFromText(inputText.value, true);
  } else {
    syncingFromEditor = true;
    inputText.value = extractPlainTextFromEditor(editor);
    syncingFromEditor = false;
  }

  isEmojiPickerVisible.value = false;
}

// 附件列表
const attachments = ref<{
  id: string;
  type: 'image' | 'file';
  url: string; // 预览地址
  file: File;
  name: string;
  size: number;
}[]>([]);

const fileInputRef = ref<HTMLInputElement | null>(null);
const editorRef = ref<HTMLDivElement | null>(null);
const inputContainerRef = ref<HTMLElement | null>(null);
const { stop: stopTts } = useTts();
const {
  asrReady,
  asrMessage,
  isPushToTalkActive,
  isCallActive,
  micReady,
  liveTranscript,
  callDraftPreview,
  setPushToTalkTranscriptHandler,
  startHoldRecording,
  finishHoldRecording,
  prewarmVoiceCapture,
} = useVoiceChat();
const isVoiceButtonPressed = ref(false);
const holdViaKeyboard = ref(false);
const voiceHoldState = ref<{ canceling: boolean; elapsedS: number } | null>(null);
const voiceHoldFeedback = ref<{ message: string; tone: 'info' | 'warn' } | null>(null);
const voiceHoldIndicatorStyle = ref<Record<string, string>>({});
let isComposing = false;
let holdPointerId: number | null = null;
let holdStartY = 0;
let holdStartedAt = 0;
let holdTimer: number | null = null;
let holdDraftBeforeStart = '';
let holdRecognizedText = '';
let callInputBase = '';
let voiceHoldFinishing = false;
let voiceHoldFeedbackTimer: number | null = null;
let altHoldArmingTimer: number | null = null;
let altShortcutPending = false;
let altKeyPhysicallyDown = false;
const HOLD_CANCEL_DISTANCE = 72;
const MIN_HOLD_MS_FOR_RECOGNITION = 350;
const ALT_HOLD_TRIGGER_MS = 500;
const VOICE_HINT_VALUES = new Set<string>(Object.values(VOICE_HINT));

function isStreamingRecognizedText(text: string) {
  const clean = text.trim();
  if (!clean) return false;
  return !VOICE_HINT_VALUES.has(clean);
}




function handleSend() {
  if (props.locked) return;
  const text = inputText.value.trim();
  if (!text && attachments.value.length === 0) return;
  
  // 发送文本和附件副本，并清空当前状态
  emit('send', text, [...attachments.value]);
  inputText.value = '';
  syncEditorFromText('');
  if (isCallActive.value) {
    callInputBase = '';
  }
  attachments.value = [];
  focusEditor(true);
}

function composeVoiceDraft(base: string, recognized: string) {
  const cleanBase = base.trimEnd();
  const cleanRecognized = recognized.trim();
  if (!cleanRecognized) return cleanBase;
  return cleanBase ? `${cleanBase}\n${cleanRecognized}` : cleanRecognized;
}

function applyHoldDraftPreview(text: string) {
  holdRecognizedText = text.trim();
  inputText.value = composeVoiceDraft(holdDraftBeforeStart, holdRecognizedText);
  const isFocused = document.activeElement === editorRef.value;
  syncEditorFromText(inputText.value, isFocused);
  if (isFocused) {
    focusEditor(true);
  }
}

function resetHoldDraftPreview(restoreBase: boolean) {
  if (restoreBase) {
    inputText.value = holdDraftBeforeStart;
    syncEditorFromText(inputText.value, true);
  }
  holdDraftBeforeStart = '';
  holdRecognizedText = '';
}

function applyCallDraftPreview(text: string) {
  const clean = text.trim();
  inputText.value = clean
    ? composeVoiceDraft(callInputBase, clean)
    : callInputBase;
  const isFocused = document.activeElement === editorRef.value;
  syncEditorFromText(inputText.value, isFocused);
  if (isFocused) {
    focusEditor(true);
  }
}

function resetCallDraftPreview(restoreBase: boolean) {
  if (restoreBase) {
    inputText.value = callInputBase;
    const isFocused = document.activeElement === editorRef.value;
    syncEditorFromText(inputText.value, isFocused);
  }
}




// 处理粘贴事件
function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        addFile(file);
        return;
      }
    }
  }
}

async function handleFileSelect(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files) return;
  for (let i = 0; i < files.length; i++) {
    addFile(files[i]);
  }
  if (fileInputRef.value) fileInputRef.value.value = '';
  focusEditor();
}

function addFile(file: File) {
  const isImage = file.type.startsWith('image/');
  
  const id = Math.random().toString(36).substring(2, 9);
  
  if (isImage) {
    const url = URL.createObjectURL(file);
    attachments.value.push({
      id,
      type: 'image',
      url,
      file,
      name: file.name,
      size: file.size
    });
  } else {
    attachments.value.push({
      id,
      type: 'file',
      url: '',
      file,
      name: file.name,
      size: file.size
    });
  }
  focusEditor();
}

function removeAttachment(id: string) {
  const idx = attachments.value.findIndex(a => a.id === id);
  if (idx !== -1) {
    const item = attachments.value[idx];
    if (item.url) URL.revokeObjectURL(item.url);
    attachments.value.splice(idx, 1);
  }
  focusEditor();
}

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function handleKeydown(e: KeyboardEvent) {
  if (props.locked) return;
  if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
    e.preventDefault();
    handleSend();
  }
}

function handleCompositionStart() {
  isComposing = true;
}

function handleCompositionEnd() {
  isComposing = false;
}

function startResize(e: MouseEvent) {
  isResizing.value = true;
  startY.value = e.clientY;
  startHeight.value = inputHeight.value;
  document.addEventListener('mousemove', handleResize);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = 'row-resize';
}

function handleResize(e: MouseEvent) {
  if (!isResizing.value) return;
  const deltaY = startY.value - e.clientY;
  const newHeight = startHeight.value + deltaY;
  
  // 优化拉伸限制：
  // 1. 最小高度 120px
  // 2. 最大高度限制在 300px，或者不超过屏幕高度的 40% (取较小值)
  const maxHeight = Math.min(300, window.innerHeight * 0.4);
  inputHeight.value = Math.min(maxHeight, Math.max(120, newHeight));
}

function stopResize() {
  isResizing.value = false;
  document.removeEventListener('mousemove', handleResize);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
}

function clearVoiceHoldFeedbackTimer() {
  if (voiceHoldFeedbackTimer !== null) {
    window.clearTimeout(voiceHoldFeedbackTimer);
    voiceHoldFeedbackTimer = null;
  }
}

function showVoiceHoldFeedback(message: string, tone: 'info' | 'warn' = 'info') {
  clearVoiceHoldFeedbackTimer();
  voiceHoldFeedback.value = { message, tone };
  updateVoiceHoldIndicatorPosition();
  voiceHoldFeedbackTimer = window.setTimeout(() => {
    voiceHoldFeedback.value = null;
    voiceHoldFeedbackTimer = null;
  }, 1600);
}

function clearVoiceHoldFeedback() {
  clearVoiceHoldFeedbackTimer();
  voiceHoldFeedback.value = null;
}

function clearHoldTimer() {
  if (holdTimer !== null) {
    window.clearInterval(holdTimer);
    holdTimer = null;
  }
}

function clearAltHoldArming() {
  if (altHoldArmingTimer !== null) {
    window.clearTimeout(altHoldArmingTimer);
    altHoldArmingTimer = null;
  }
  altShortcutPending = false;
}

function updateVoiceHoldIndicatorPosition() {
  const container = inputContainerRef.value;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  voiceHoldIndicatorStyle.value = {
    left: `${Math.round(rect.left + rect.width / 2)}px`,
    top: `${Math.max(72, Math.round(window.scrollY + 72))}px`,
  };
}

function canStartVoiceHold() {
  return asrReady.value
    && !isCallActive.value
    && !isVoiceButtonPressed.value
    && !voiceHoldState.value
    && !altShortcutPending;
}

async function abortVoiceHoldStart(restoreDraft: boolean) {
  clearHoldTimer();
  voiceHoldState.value = null;
  isVoiceButtonPressed.value = false;
  holdViaKeyboard.value = false;
  holdPointerId = null;
  resetHoldDraftPreview(restoreDraft);
}

async function beginVoiceHold(options: { viaKeyboard: boolean; pointerEvent?: PointerEvent }) {
  if (!canStartVoiceHold()) return false;

  clearAltHoldArming();
  clearVoiceHoldFeedback();
  stopTts();
  isVoiceButtonPressed.value = true;
  holdViaKeyboard.value = options.viaKeyboard;
  holdDraftBeforeStart = inputText.value;
  holdRecognizedText = '';

  if (options.pointerEvent) {
    holdPointerId = options.pointerEvent.pointerId;
    holdStartY = options.pointerEvent.clientY;
    (options.pointerEvent.currentTarget as HTMLElement | null)?.setPointerCapture?.(
      options.pointerEvent.pointerId,
    );
  } else {
    holdPointerId = null;
    holdStartY = 0;
  }

  prewarmVoiceCapture();
  holdStartedAt = Date.now();
  voiceHoldState.value = { canceling: false, elapsedS: 0 };
  updateVoiceHoldIndicatorPosition();
  clearHoldTimer();
  holdTimer = window.setInterval(() => {
    if (!voiceHoldState.value) return;
    voiceHoldState.value = {
      ...voiceHoldState.value,
      elapsedS: (Date.now() - holdStartedAt) / 1000,
    };
  }, 80);

  try {
    await startHoldRecording();
    if (!isPushToTalkActive.value) {
      await abortVoiceHoldStart(false);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[InputArea] Hold recording start failed:', error);
    await abortVoiceHoldStart(true);
    return false;
  }
}

async function completeVoiceHold(options: {
  canceled?: boolean;
  autoSend?: boolean;
  pointerEvent?: PointerEvent;
}) {
  if (!isVoiceButtonPressed.value || voiceHoldFinishing) return;
  if (options.pointerEvent && holdPointerId !== options.pointerEvent.pointerId) return;

  voiceHoldFinishing = true;
  const holdDurationMs = Date.now() - holdStartedAt;
  const viaKeyboard = holdViaKeyboard.value;

  const canceled = options.canceled === true
    || (!viaKeyboard && voiceHoldState.value?.canceling === true);

  isVoiceButtonPressed.value = false;
  clearHoldTimer();
  voiceHoldState.value = null;
  holdViaKeyboard.value = false;

  if (options.pointerEvent) {
    (options.pointerEvent.currentTarget as HTMLElement | null)?.releasePointerCapture?.(
      options.pointerEvent.pointerId,
    );
  }
  holdPointerId = null;

  try {
    const result = await finishHoldRecording(canceled);

    if (canceled) {
      resetHoldDraftPreview(true);
      return;
    }

    if (result?.text) {
      applyHoldDraftPreview(result.text);
    } else if (isStreamingRecognizedText(inputText.value)) {
      // 保留按住期间已写入输入框的 partial 文本
    } else {
      resetHoldDraftPreview(true);
      if (holdDurationMs < MIN_HOLD_MS_FOR_RECOGNITION) {
        showVoiceHoldFeedback('按住稍久一点');
      } else {
        showVoiceHoldFeedback('未识别到文字', 'warn');
      }
      return;
    }

    resetHoldDraftPreview(false);
    await nextTick();

    if (options.autoSend) {
      handleSend();
      return;
    }
    focusEditor();
  } finally {
    voiceHoldFinishing = false;
  }
}

async function handleVoicePressStart(event: PointerEvent) {
  if (event.button !== 0) return;
  stopTts();
  await beginVoiceHold({ viaKeyboard: false, pointerEvent: event });
}

function handleVoicePressMove(event: PointerEvent) {
  if (!voiceHoldState.value || holdPointerId !== event.pointerId) return;
  const canceling = holdStartY - event.clientY > HOLD_CANCEL_DISTANCE;
  if (voiceHoldState.value.canceling === canceling) return;
  voiceHoldState.value = {
    ...voiceHoldState.value,
    canceling,
  };
}

async function handleVoicePressEnd(event?: PointerEvent, forceCancel = false) {
  await completeVoiceHold({
    canceled: forceCancel,
    autoSend: false,
    pointerEvent: event,
  });
}

function isAltHoldShortcutKey(event: KeyboardEvent) {
  return event.key === 'Alt' && !event.ctrlKey && !event.metaKey && !event.repeat;
}

function isAltHoldShortcutRelease(event: KeyboardEvent) {
  return event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight';
}

function handleVoiceShortcutKeydown(event: KeyboardEvent) {
  if (altShortcutPending && !isVoiceButtonPressed.value && !isAltHoldShortcutKey(event)) {
    clearAltHoldArming();
  }

  if (holdViaKeyboard.value && isVoiceButtonPressed.value) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void completeVoiceHold({ canceled: true });
      return;
    }
    if (event.key !== 'Alt' && !event.repeat) {
      void completeVoiceHold({ canceled: true });
      return;
    }
  }

  if (!isAltHoldShortcutKey(event)) return;
  prewarmVoiceCapture();
  stopTts();
  if (!canStartVoiceHold() || isComposing || altShortcutPending) return;

  altKeyPhysicallyDown = true;
  clearAltHoldArming();
  altShortcutPending = true;
  altHoldArmingTimer = window.setTimeout(() => {
    altHoldArmingTimer = null;
    if (!altShortcutPending || !altKeyPhysicallyDown) {
      clearAltHoldArming();
      return;
    }
    altShortcutPending = false;
    void beginVoiceHold({ viaKeyboard: true });
  }, ALT_HOLD_TRIGGER_MS);
}

function handleVoiceShortcutKeyup(event: KeyboardEvent) {
  if (!isAltHoldShortcutRelease(event)) return;

  altKeyPhysicallyDown = false;

  if (altShortcutPending && !isVoiceButtonPressed.value) {
    clearAltHoldArming();
    return;
  }

  if (!isVoiceButtonPressed.value || voiceHoldFinishing) return;
  if (!holdViaKeyboard.value) return;
  event.preventDefault();
  void completeVoiceHold({ autoSend: true });
}

function handleVoiceShortcutBlur() {
  altKeyPhysicallyDown = false;
  if (altShortcutPending && !isVoiceButtonPressed.value) {
    clearAltHoldArming();
    return;
  }
  if (!holdViaKeyboard.value || !isVoiceButtonPressed.value) return;
  void completeVoiceHold({ canceled: true });
}

onMounted(() => {
  // Load the voice worklet before the first press; the mic itself stays closed.
  prewarmVoiceCapture();
  // Preload emoji images in background to avoid first-open picker flicker.
  void preloadEmojiAssets();
  window.addEventListener('resize', updateVoiceHoldIndicatorPosition);
  window.addEventListener('keydown', handleVoiceShortcutKeydown, true);
  window.addEventListener('keyup', handleVoiceShortcutKeyup, true);
  window.addEventListener('blur', handleVoiceShortcutBlur);
  setPushToTalkTranscriptHandler((text) => {
    if (!isStreamingRecognizedText(text)) return;
    applyHoldDraftPreview(text);
  });
});

watch(liveTranscript, (text) => {
  if (!voiceHoldState.value || !isStreamingRecognizedText(text)) return;
  applyHoldDraftPreview(text);
});

watch(isCallActive, (active) => {
  if (active) {
    callInputBase = inputText.value;
    return;
  }
  resetCallDraftPreview(true);
  callInputBase = '';
});

watch(callDraftPreview, (preview) => {
  if (!isCallActive.value) return;
  if (!isStreamingRecognizedText(preview)) {
    resetCallDraftPreview(true);
    return;
  }
  applyCallDraftPreview(preview);
});

onUnmounted(() => {
  stopResize();
  window.removeEventListener('resize', updateVoiceHoldIndicatorPosition);
  window.removeEventListener('keydown', handleVoiceShortcutKeydown, true);
  window.removeEventListener('keyup', handleVoiceShortcutKeyup, true);
  window.removeEventListener('blur', handleVoiceShortcutBlur);
  setPushToTalkTranscriptHandler(null);
  clearHoldTimer();
  clearAltHoldArming();
  resetHoldDraftPreview(true);
  clearVoiceHoldFeedback();
  void finishHoldRecording(true);
});
</script>

<template>
  <div v-if="attachments.length > 0" class="attachments-strip">
    <div class="attachments-preview">
      <div
        v-for="item in attachments"
        :key="item.id"
        class="attachment-item"
        :class="item.type"
      >
        <div class="delete-overlay" @click="removeAttachment(item.id)">
          <IconClose size="12" />
        </div>

        <img v-if="item.type === 'image'" :src="item.url" class="preview-img" />
        <div v-else class="file-card">
          <div class="file-icon">
            <IconFile :size="24" />
          </div>
          <div class="file-info">
            <div class="file-name text-ellipsis">{{ item.name }}</div>
            <div class="file-size">{{ formatSize(item.size) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <footer
    ref="inputContainerRef"
    class="input-container"
    :style="{ height: inputHeight + 'px' }"
  >
    <teleport to="body">
      <transition name="voice-hold-fade">
        <div
          v-if="voiceHoldState || voiceHoldFeedback"
          class="voice-hold-indicator"
          :class="{
            canceling: voiceHoldState?.canceling,
            feedback: !voiceHoldState && !!voiceHoldFeedback,
            warn: voiceHoldFeedback?.tone === 'warn',
          }"
          :style="voiceHoldIndicatorStyle"
        >
          <template v-if="voiceHoldState">
            <span class="voice-hold-label">
              {{
                voiceHoldState.canceling
                  ? '松开取消'
                  : (!micReady
                    ? '正在打开麦克风…'
                    : (holdViaKeyboard
                      ? '正在听 · 松开 Alt 发送 · Esc 取消'
                      : '上滑松开取消'))
              }}
            </span>
            <span class="voice-hold-timer">{{ voiceHoldState.elapsedS.toFixed(1) }}s</span>
          </template>
          <span v-else-if="voiceHoldFeedback" class="voice-hold-label">
            {{ voiceHoldFeedback.message }}
          </span>
        </div>
      </transition>
    </teleport>

    <div class="input-card" :class="{ 'is-locked': props.locked }">
      <!-- Resize Handle -->
      <div class="resize-handle" @mousedown="startResize"></div>
      
      <div class="input-body">
        <div
          ref="editorRef"
          class="text-input"
          :contenteditable="props.locked ? 'false' : 'true'"
          role="textbox"
          :aria-disabled="props.locked ? 'true' : 'false'"
          aria-multiline="true"
          :data-placeholder="props.locked ? (props.lockedHint || '开通会员后可继续对话') : '输入消息...'"
          @input="handleEditorInput"
          @keydown="handleKeydown"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
          @paste="handlePaste"
        />
      </div>
      
      <div class="input-footer">
        <div class="toolbar">
          <a-popover
            v-model:popup-visible="isEmojiPickerVisible"
            trigger="click"
            position="tl"
            :content-style="{ padding: 0, border: 'none', background: 'transparent' }"
          >
            <button class="tool-btn" title="表情">
              <IconFaceSmileFill :size="18" />
            </button>
            <template #content>
              <EmojiPicker @emoji-click="handleEmojiSelect" />
            </template>
          </a-popover>
          <button class="tool-btn" title="文件" @click="fileInputRef?.click()">
            <IconFolder :size="18" />
          </button>
          <div class="tool-group">
            <button class="tool-btn" title="截图">
              <IconScissor :size="18" />
            </button>
            <IconDown :size="10" class="down-arrow" />
          </div>
          <button
            class="tool-btn voice-btn"
            :class="{
              recording: isPushToTalkActive || isVoiceButtonPressed,
              canceling: voiceHoldState?.canceling,
              disabled: !asrReady
            }"
            :disabled="!asrReady"
            :title="asrReady
              ? (voiceHoldState?.canceling
                ? '松开取消'
                : (isPushToTalkActive
                  ? (holdViaKeyboard ? '松开 Alt 发送' : '松开填入输入框')
                  : '按住说话（上滑取消）· 长按 Alt 0.5s 说话并发送'))
              : asrMessage"
            @pointerenter="prewarmVoiceCapture"
            @focus="prewarmVoiceCapture"
            @pointerdown.prevent="handleVoicePressStart"
            @pointermove.prevent="handleVoicePressMove"
            @pointerup.prevent="handleVoicePressEnd"
            @pointercancel.prevent="(event) => handleVoicePressEnd(event, true)"
          >
            <IconVoice :size="18" />
          </button>

        </div>
        
        <button
          class="send-btn"
          :disabled="props.locked || (!inputText.trim() && attachments.length === 0)"
          @click="handleSend"
        >
          发送
        </button>
      </div>
      
      <input 
        ref="fileInputRef"
        type="file" 
        multiple 
        style="display: none" 
        @change="handleFileSelect"
      />
    </div>
  </footer>
</template>

<style scoped>
.input-container {
  padding: 0 8px 8px;
  background-color: transparent;
  flex-shrink: 0;
  position: relative;
  /* 删掉 transition，它是卡顿的元凶 */
}

.voice-hold-indicator {
  position: fixed;
  transform: translateX(-50%);
  z-index: 20;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(18, 18, 20, 0.86);
  color: #fff;
  box-shadow: 0 18px 34px rgba(0, 0, 0, 0.22);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.voice-hold-indicator.canceling {
  background: color-mix(in srgb, var(--color-danger, #f53f3f) 84%, rgba(18, 18, 20, 0.92));
}

.voice-hold-indicator.feedback.warn {
  background: color-mix(in srgb, var(--color-warning, #ff7d00) 72%, rgba(18, 18, 20, 0.92));
}

.voice-hold-label,
.voice-hold-timer {
  font-size: 12px;
  line-height: 1;
}

.voice-hold-timer {
  opacity: 0.82;
  font-variant-numeric: tabular-nums;
}

.voice-hold-fade-enter-active,
.voice-hold-fade-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease,
    filter 0.18s ease;
}

.voice-hold-fade-enter-from,
.voice-hold-fade-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px);
  filter: blur(4px);
}

.attachments-strip {
  padding: 0 16px 8px;
  flex-shrink: 0;
}

.input-card {
  height: 100%; /* 让卡片充满已设置高度的容器 */
  background-color: transparent; /* 既然要透明，那就彻底透明 */
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  transition: border-color var(--transition-fast);
  box-shadow: var(--shadow-sm);
  position: relative;
}

/* Pro 到期 / 未开通：只读态，保留历史但禁用输入与工具栏 */
.input-card.is-locked {
  border-color: var(--border-color);
  background-color: var(--bg-hover);
}

.input-card.is-locked .toolbar,
.input-card.is-locked .resize-handle,
.input-card.is-locked .send-btn {
  pointer-events: none;
  opacity: 0.45;
}

.input-card.is-locked .text-input {
  cursor: not-allowed;
}

.resize-handle {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  height: 8px;
  cursor: row-resize;
  z-index: 10;
}

.resize-handle:hover::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 50%;
  transform: translateX(-50%);
  width: 40px;
  height: 2px;
  background-color: var(--color-primary);
  border-radius: 1px;
  opacity: 0.5;
}

.input-card:focus-within {
  border-color: var(--border-color-dark);
}

.input-body {
  flex: 1;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}



.attachments-preview {
  display: flex;
  flex-wrap: nowrap;
  gap: 12px;
  overflow-x: auto;
}

/* 隐藏附件区域的默认滚动条，使用极细样式 */
.attachments-preview::-webkit-scrollbar {
  height: 4px;
}
.attachments-preview::-webkit-scrollbar-thumb {
  background: var(--text-placeholder);
  border-radius: 2px;
}

.attachment-item {
  position: relative;
  background: var(--bg-hover);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  flex-shrink: 0;
  transition: all 0.2s;
}

.attachment-item.image {
  width: 80px;
  height: 80px;
}

.attachment-item.file {
  width: 180px;
  height: 60px;
}

.preview-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.file-card {
  display: flex;
  align-items: center;
  padding: 8px;
  gap: 8px;
  height: 100%;
}

.file-icon {
  width: 36px;
  height: 36px;
  background: var(--bg-chat-window);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-size: 13px;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.file-size {
  font-size: 11px;
  color: var(--text-tertiary);
}

.delete-overlay {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  background: rgba(0, 0, 0, 0.4);
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 5;
}

.attachment-item:hover .delete-overlay {
  opacity: 1;
}

.text-input {
  flex: 1 1 auto;
  align-self: stretch;
  width: 100%;
  min-width: 0;
  border: none;
  font-size: var(--font-size-base);
  line-height: 1.5;
  color: var(--text-primary);
  font-family: inherit;
  outline: none;
  background: transparent;
  min-height: 40px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  -webkit-user-select: text;
  display: block;
}

.text-input:empty::before {
  content: attr(data-placeholder);
  color: var(--text-tertiary);
  pointer-events: none;
}

.text-input :deep(.input-emoji) {
  vertical-align: -0.22em;
}

.input-footer {
  height: 40px;
  padding: 0 12px 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px; /* 16px -> 8px，更紧凑 */
}

.mode-toggle {
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.mode-toggle:hover {
  border-color: var(--color-primary);
  color: var(--text-primary);
}

.mode-toggle.active {
  border-color: var(--color-primary);
  background: var(--color-primary-light);
  color: var(--color-primary);
}

.tool-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  background: none;
  border: none;
  padding: 6px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.tool-btn:hover {
  color: var(--text-primary);
  background-color: var(--bg-hover);
  border-radius: var(--radius-sm);
}

.voice-btn {
  padding: 6px;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast),
    transform 0.15s ease;
}

.voice-btn.recording {
  color: var(--color-danger, #f53f3f);
  background-color: rgba(245, 63, 63, 0.12);
}

.voice-btn.canceling {
  color: #fff;
  background-color: var(--color-danger, #f53f3f);
}

.voice-btn:active {
  transform: scale(0.96);
}

.tool-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.down-arrow {
  color: var(--text-placeholder);
}

.send-btn {
  height: 28px;
  padding: 0 16px;
  border-radius: var(--radius-sm);
  background-color: var(--bg-hover);
  color: var(--color-primary);
  font-size: 13px;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.send-btn:hover:not(:disabled) {
  background-color: var(--color-primary-hover);
}

.send-btn:not(:disabled) {
  background-color: var(--color-primary);
  color: #FFFFFF;
}



.send-btn:disabled {
  color: var(--text-tertiary);
  opacity: 1;
  cursor: not-allowed;
}
</style>
