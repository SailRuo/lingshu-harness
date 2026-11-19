<script setup lang="ts">
import { ref, nextTick, watch, onMounted, onUnmounted, computed } from 'vue';
import { Modal } from '@arco-design/web-vue';
import IconClose from '@arco-design/web-vue/es/icon/icon-close';
import IconCheck from '@arco-design/web-vue/es/icon/icon-check';
import IconDelete from '@arco-design/web-vue/es/icon/icon-delete';
import IconZoomIn from '@arco-design/web-vue/es/icon/icon-zoom-in';
import IconZoomOut from '@arco-design/web-vue/es/icon/icon-zoom-out';
import IconRotateRight from '@arco-design/web-vue/es/icon/icon-rotate-right';
import IconRotateLeft from '@arco-design/web-vue/es/icon/icon-rotate-left';
import IconOriginalSize from '@arco-design/web-vue/es/icon/icon-original-size';
import IconDownload from '@arco-design/web-vue/es/icon/icon-download';
import type { AnyMessage, ImageMessage, TextMessage, SystemMessage } from '../../types/message';
import type { UnifiedChatEvent } from '../../types/chat-events';
import { useTts } from '../../composables/useTts';
import { useChatStore } from '../../stores/chat';
import { useSettingsStore } from '../../stores/settings';
import {
  buildCompanionDialogueDisplayItems,
  buildCompanionLiveText,
  buildTimelineItems,
  hasProcessTimelineEvents,
  isCompanionChatTimeline,
  shouldShowCompanionWorkingHint,
  timelineItemsForBubble,
} from '../../utils/messageTimeline.js';
import { stripEmbeddedImageMarkup, stripEmotionTags } from '../../utils/messageText';
import { deriveTaskStatusFromEvents } from '../../utils/taskStatus.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import ThoughtProcess from './ThoughtProcess.vue';
import { renderWechatEmoji, replaceUnicodeEmoji } from '../emoji/render';
import {
  buildDeleteConfirmContent,
  isDeletableUiMessage,
  resolveTurnAnchorId,
} from '../../utils/messageDelete';

const props = defineProps<{
  messages: AnyMessage[];
  hasMore?: boolean;
  loadingOlder?: boolean;
}>();

const emit = defineEmits<{
  loadOlder: [];
}>();

const listRef = ref<HTMLElement | null>(null);
const previewImage = ref<ImageMessage | null>(null);
const previewImageRef = ref<HTMLImageElement | null>(null);
const previewScale = ref(1);
const previewOffset = ref({ x: 0, y: 0 });
const previewRotate = ref(0);
const previewDragging = ref(false);
const previewHasMoved = ref(false);
const isActive = ref(false);
let resizeObserver: ResizeObserver | null = null;
let previewDragStart: { x: number; y: number; startX: number; startY: number } | null = null;
let previewPointerId: number | null = null;
let preserveScrollHeight: number | null = null;
let preserveScrollTop: number | null = null;
const { speak, isPlaying, currentPlayingId, stop } = useTts();
const chatStore = useChatStore();
const settingsStore = useSettingsStore();
const selectionMode = ref(false);
const selectedUiIds = ref<Set<string>>(new Set());
const deleting = ref(false);

const selectedCount = computed(() => selectedUiIds.value.size);

watch(
  () => [
    props.messages.length,
    (props.messages[props.messages.length - 1] as any)?.content?.length || 0,
    (props.messages[props.messages.length - 1] as any)?.status || '',
  ],
  async () => {
    if (!isActive.value) return;
    if (preserveScrollHeight !== null) return;
    await nextTick();
    if (!isActive.value) return;
    scrollToBottom();
  },
  { deep: true, flush: 'post' }
);

watch(
  () => props.messages.length,
  async () => {
    if (preserveScrollHeight === null || preserveScrollTop === null) return;
    await nextTick();
    const list = listRef.value;
    if (list) {
      list.scrollTop = list.scrollHeight - preserveScrollHeight + preserveScrollTop;
    }
    preserveScrollHeight = null;
    preserveScrollTop = null;
  },
  { flush: 'post' },
);

watch(
  () => chatStore.lastMergedMessageId,
  async (msgId) => {
    if (!msgId || !isActive.value) return;
    await nextTick();
    if (!isActive.value) return;
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('pulse-highlight');
      setTimeout(() => {
        if (!isActive.value || !el.isConnected) return;
        el.classList.remove('pulse-highlight');
        chatStore.lastMergedMessageId = null;
      }, 2000);
    }
  },
  { flush: 'post' }
);

onMounted(() => {
  isActive.value = true;
  window.addEventListener('keydown', handlePreviewKeydown);
  window.addEventListener('keydown', handleSelectionKeydown);
  if (listRef.value) {
    resizeObserver = new ResizeObserver(() => {
      if (!isActive.value) return;
      if (preserveScrollHeight !== null) return;
      scrollToBottom();
    });
    resizeObserver.observe(listRef.value);
  }
});

onUnmounted(() => {
  isActive.value = false;
  window.removeEventListener('keydown', handlePreviewKeydown);
  window.removeEventListener('keydown', handleSelectionKeydown);
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
});

function scrollToBottom() {
  if (listRef.value) {
    listRef.value.scrollTop = listRef.value.scrollHeight;
  }
}

function handleListScroll() {
  const list = listRef.value;
  if (!list || !props.hasMore || props.loadingOlder) return;
  if (list.scrollTop > 32) return;
  preserveScrollHeight = list.scrollHeight;
  preserveScrollTop = list.scrollTop;
  emit('loadOlder');
}

function shouldShowTime(msg: AnyMessage, index: number): boolean {
  if (index === 0) return true;
  const prevMsg = props.messages[index - 1];
  const diff = msg.timestamp.getTime() - prevMsg.timestamp.getTime();
  return diff > 5 * 60 * 1000; // 5 分钟
}

function formatTime(date: Date): string {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  return isToday 
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
}

function handleSpeakMessage(msg: AnyMessage) {
  if (!msg.isSelf && msg.type === 'text') {
    if (isPlaying.value && currentPlayingId.value === msg.id) {
      stop();
      return;
    }
    const content = stripEmotionTags((msg as TextMessage).content || '');
    if (content && content.trim().length > 0) {
      const agentId =
        chatStore.currentAgentId ??
        (chatStore.currentConversationId
          ? (chatStore.conversations.find((c) => c.id === chatStore.currentConversationId)?.metadata?.agentId as number | undefined)
          : undefined) ??
        null;
      void speak(content, msg.id, agentId);
    }
  }
}


function openImagePreview(msg: ImageMessage) {
  previewImage.value = msg;
  previewScale.value = 1;
  previewOffset.value = { x: 0, y: 0 };
  previewRotate.value = 0;
  previewDragging.value = false;
  previewHasMoved.value = false;
  previewDragStart = null;
  previewPointerId = null;
}

function closeImagePreview() {
  previewImage.value = null;
  previewScale.value = 1;
  previewOffset.value = { x: 0, y: 0 };
  previewRotate.value = 0;
  previewDragging.value = false;
  previewHasMoved.value = false;
  previewDragStart = null;
  previewPointerId = null;
}

function clampPreviewScale(nextScale: number): number {
  return Math.min(8, Math.max(0.4, Number(nextScale.toFixed(2))));
}

function resetPreviewTransform() {
  previewScale.value = 1;
  previewOffset.value = { x: 0, y: 0 };
  previewRotate.value = 0;
  previewDragging.value = false;
  previewHasMoved.value = false;
  previewDragStart = null;
  previewPointerId = null;
}

function zoomIn() {
  previewScale.value = clampPreviewScale(previewScale.value + 0.25);
}

function zoomOut() {
  const next = clampPreviewScale(previewScale.value - 0.25);
  previewScale.value = next;
  if (next <= 1) {
    previewOffset.value = { x: 0, y: 0 };
  }
}

function rotateLeft() {
  previewRotate.value = (previewRotate.value - 90 + 360) % 360;
}

function rotateRight() {
  previewRotate.value = (previewRotate.value + 90) % 360;
}

function downloadImage() {
  if (!previewImage.value?.url) return;
  const link = document.createElement('a');
  link.href = previewImage.value.url;
  link.download = String(previewImage.value.metadata?.fileName || `image_${Date.now()}.png`);
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function handlePreviewWheel(event: WheelEvent) {
  if (!previewImage.value) return;
  event.preventDefault();
  const oldScale = previewScale.value;
  const delta = event.deltaY < 0 ? 0.2 : -0.2;
  const nextScale = clampPreviewScale(oldScale + delta);
  if (nextScale === oldScale) return;

  if (nextScale <= 1 && oldScale > 1) {
    previewOffset.value = { x: 0, y: 0 };
  } else {
    const ratio = nextScale / oldScale;
    previewOffset.value = {
      x: previewOffset.value.x * ratio,
      y: previewOffset.value.y * ratio,
    };
  }
  previewScale.value = nextScale;
}

function handlePreviewPointerDown(event: PointerEvent) {
  if (!previewImage.value) return;
  if (event.button !== 0) return;
  if ((event.target as HTMLElement).closest('.preview-toolbar, .preview-close-btn')) return;

  event.preventDefault();
  const overlayEl = event.currentTarget as HTMLElement | null;
  overlayEl?.setPointerCapture(event.pointerId);
  previewPointerId = event.pointerId;
  previewDragging.value = true;
  previewHasMoved.value = false;
  previewDragStart = {
    x: event.clientX,
    y: event.clientY,
    startX: previewOffset.value.x,
    startY: previewOffset.value.y,
  };
}

function handlePreviewPointerMove(event: PointerEvent) {
  if (!previewDragging.value || !previewDragStart || previewPointerId !== event.pointerId) return;
  const dx = event.clientX - previewDragStart.x;
  const dy = event.clientY - previewDragStart.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
    previewHasMoved.value = true;
  }
  previewOffset.value = {
    x: previewDragStart.startX + dx,
    y: previewDragStart.startY + dy,
  };
}

function stopPreviewDragging(event?: PointerEvent) {
  if (event && previewPointerId === event.pointerId) {
    try {
      (event.currentTarget as HTMLElement)?.releasePointerCapture(event.pointerId);
    } catch (_) {}
  }
  previewDragging.value = false;
  previewDragStart = null;
  previewPointerId = null;
}

function handleOverlayClick(event: MouseEvent) {
  if (previewHasMoved.value) return;
  if ((event.target as HTMLElement).closest('.preview-toolbar, .preview-close-btn, .image-preview-full')) return;
  closeImagePreview();
}

function handlePreviewDoubleClick() {
  if (previewScale.value <= 1) {
    previewScale.value = 2;
  } else {
    resetPreviewTransform();
  }
}

function handlePreviewKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && previewImage.value) {
    closeImagePreview();
  }
}

function handleSelectionKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && selectionMode.value) {
    exitSelectionMode();
  }
}

function canSelectMessage(msg: AnyMessage): boolean {
  return isDeletableUiMessage(msg.id, String(msg.status || ''));
}

function isMessageSelected(msg: AnyMessage): boolean {
  return selectedUiIds.value.has(msg.id);
}

function enterSelectionMode(msg?: AnyMessage) {
  selectionMode.value = true;
  selectedUiIds.value = new Set();
  if (msg && canSelectMessage(msg)) {
    selectedUiIds.value.add(msg.id);
  }
}

function exitSelectionMode() {
  selectionMode.value = false;
  selectedUiIds.value = new Set();
}

function toggleMessageSelection(msg: AnyMessage) {
  if (!canSelectMessage(msg)) return;
  const next = new Set(selectedUiIds.value);
  if (next.has(msg.id)) next.delete(msg.id);
  else next.add(msg.id);
  selectedUiIds.value = next;
}

function handleMessageRowClick(msg: AnyMessage) {
  if (!selectionMode.value) return;
  toggleMessageSelection(msg);
}

function collectAnchorIds(): number[] {
  const ids = new Set<number>();
  for (const uiId of selectedUiIds.value) {
    const msg = props.messages.find((m) => m.id === uiId);
    const anchorId = resolveTurnAnchorId(uiId, msg?.metadata);
    if (anchorId) ids.add(anchorId);
  }
  return [...ids];
}

async function confirmDeleteSelected() {
  const sessionId = chatStore.currentConversationId;
  const selectedIds = [...selectedUiIds.value];
  if (!sessionId || selectedIds.length === 0 || deleting.value) return;

  const anchorIds = collectAnchorIds();
  deleting.value = true;
  try {
    if (anchorIds.length > 0) {
      const impact = await chatStore.previewDeleteMessages(sessionId, anchorIds);
      Modal.confirm({
        title: '删除所选消息？',
        content: buildDeleteConfirmContent(impact),
        okText: '删除',
        cancelText: '取消',
        okButtonProps: { status: 'danger' },
        onOk: async () => {
          await chatStore.deleteSelectedMessages(sessionId, anchorIds, true);
          chatStore.removeLocalMessages(selectedIds, sessionId);
          exitSelectionMode();
        },
      });
    } else {
      Modal.confirm({
        title: '删除所选消息？',
        content: `将删除选中的 ${selectedIds.length} 条消息记录。`,
        okText: '删除',
        cancelText: '取消',
        okButtonProps: { status: 'danger' },
        onOk: async () => {
          chatStore.removeLocalMessages(selectedIds, sessionId);
          exitSelectionMode();
          const { Message } = await import('@arco-design/web-vue');
          Message.success('已删除所选消息');
        },
      });
    }
  } catch (error) {
    const { Message } = await import('@arco-design/web-vue');
    Message.error(error instanceof Error ? error.message : '删除失败');
  } finally {
    deleting.value = false;
  }
}



const renderer = new marked.Renderer();
renderer.code = (token) => {
  const codeText = token.text;
  const language = token.lang || '';
  const encodedCode = encodeURIComponent(codeText);
  return `
    <div class="markdown-code-wrapper">
      <pre><code class="language-${language}">${codeText}</code></pre>
      <button class="markdown-copy-btn" data-code="${encodedCode}" title="复制">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-icon"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
      </button>
    </div>
  `;
};

marked.setOptions({
  renderer,
  breaks: true,
  gfm: true,
});

interface MarkdownCacheEntry {
  content: string;
  html: string;
}

const markdownCache = new Map<string, MarkdownCacheEntry>();

const EMOJI_RENDER_SIZE = 20

const domPurifyConfig = {
  ADD_ATTR: ['style', 'title', 'data-code'],
}

/** 灰显舞台说明：`（翻了个白眼）` / `(笑)`，只改文本节点，不动标签属性。 */
const STAGE_DIRECTION_RE = /[（(][^（）()]{1,200}[）)]/g;

function wrapStageDirectionsHtml(html: string): string {
  if (!html || !/[（(]/.test(html)) return html;
  return html.replace(/(<[^>]+>)|([^<]+)/g, (_chunk, tag: string | undefined, text: string | undefined) => {
    if (tag) return tag;
    return (text || '').replace(
      STAGE_DIRECTION_RE,
      '<span class="stage-direction">$&</span>',
    );
  });
}

// 完整 markdown 渲染：仅用于已完成（status !== 'sending'）的消息，内容稳定，缓存有效。
function renderMarkdown(msgId: string, content: string): string {
  const text = content || '';
  const cached = markdownCache.get(msgId);
  if (cached && cached.content === text) {
    return cached.html;
  }
  // 1. Unicode → [微信名]；2. markdown；3. [微信名] → 雪碧图 span；4. 保留 span 的 style
  const normalized = replaceUnicodeEmoji(text);
  const rawHtml = marked.parse(normalized) as string;
  const htmlWithEmojis = renderWechatEmoji(rawHtml, {
    emojiSize: EMOJI_RENDER_SIZE,
    skipUnicodeReplace: true,
  });
  const html = wrapStageDirectionsHtml(DOMPurify.sanitize(htmlWithEmojis, domPurifyConfig));
  markdownCache.set(msgId, { content: text, html });
  return html;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 流式期间（status === 'sending'）的轻量渲染：段落/换行布局与 renderMarkdown 一致（<p> + <br>），
// 不跑 marked/DOMPurify。双换行 → <p> 段落（沿用 .markdown-content :deep(p) 的 0.8em 间距），
// 单换行 → 段内 <br>（对应 marked breaks:true）。
function renderStreamingText(content: string): string {
  const text = content || '';
  if (!text.trim()) return '';

  let paragraphs = text.split(/\n\n+/);
  if (paragraphs.length > 1 && paragraphs[paragraphs.length - 1] === '') {
    paragraphs = paragraphs.slice(0, -1);
  }

  const html = paragraphs
    .map((para) => {
      const normalized = replaceUnicodeEmoji(para);
      const escaped = escapeHtml(normalized).replace(/\n/g, '<br>');
      return `<p>${escaped}</p>`;
    })
    .join('');

  return wrapStageDirectionsHtml(renderWechatEmoji(html, {
    emojiSize: EMOJI_RENDER_SIZE,
    skipUnicodeReplace: true,
  }));
}

async function handleCopyClick(event: MouseEvent) {
  const btn = (event.target as HTMLElement).closest('.markdown-copy-btn');
  if (!btn) return;
  
  const code = decodeURIComponent(btn.getAttribute('data-code') || '');
  if (code) {
    try {
      await navigator.clipboard.writeText(code);
      const { Message } = await import('@arco-design/web-vue');
      Message.success('已复制到剪贴板');
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }
}

async function copyMessageContent(msg: AnyMessage) {
  if (msg.type === 'text') {
    const content = stripEmotionTags((msg as TextMessage).content || '');
    if (content) {
      try {
        await navigator.clipboard.writeText(content);
        const { Message } = await import('@arco-design/web-vue');
        Message.success('已复制到剪贴板');
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  }
}

function parseAssistantBubbleIndex(msg: AnyMessage): number {
  const raw = (msg.metadata as Record<string, unknown> | undefined)?.bubbleIndex;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function resolveTimelineOwner(msg: AnyMessage): AnyMessage {
  if (msg.type !== 'text' || msg.isSelf) return msg;
  const segmentGroupId = (msg as TextMessage).metadata?.segmentGroupId as string | undefined;
  if (!segmentGroupId || segmentGroupId === msg.id) return msg;
  const owner = props.messages.find((item) => item.id === segmentGroupId);
  return owner || msg;
}

function timelineEventsFor(msg: AnyMessage): UnifiedChatEvent[] {
  const owner = resolveTimelineOwner(msg);
  return (owner.metadata?.timelineEvents as UnifiedChatEvent[] | undefined) || [];
}

function usesSegmentTimeline(msg: AnyMessage): boolean {
  if (msg.type !== 'text' || msg.isSelf) return false;
  const textMsg = msg as TextMessage;
  if (textMsg.metadata?.segmentGroupId) return true;
  if (Array.isArray(textMsg.metadata?.segmentTexts) && textMsg.metadata.segmentTexts.length > 0) return true;
  return typeof textMsg.metadata?.bubbleIndex === 'number';
}

function errorClassFor(events: UnifiedChatEvent[]): string | null {
  const event = [...events].reverse().find(item => item.metadata?.error_class);
  return event?.metadata?.error_class ? String(event.metadata.error_class) : null;
}

function lastTaskStatus(events: UnifiedChatEvent[]): unknown {
  return deriveTaskStatusFromEvents(events);
}

function taskIdFor(events: UnifiedChatEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].taskId) return events[index].taskId || null;
  }
  return null;
}

function messageRenderKey(msg: AnyMessage): string {
  const events = timelineEventsFor(msg);
  const taskId = taskIdFor(events) || 'no-task';
  const status = String(msg.status || 'unknown');
  return `${msg.id}:${msg.type}:${msg.isSelf ? 'self' : 'other'}:${taskId}:${status}`;
}

type TimelineItem =
  | { kind: 'process'; id: string; events: UnifiedChatEvent[] }
  | { kind: 'text'; id: string; content: string; bubbleIndex?: number };

const timelineCache = new Map<string, TimelineItem[]>();

function isCompanionTimelineOwner(msg: AnyMessage): boolean {
  if (msg.type !== 'text' || msg.isSelf) return false;
  const groupId = (msg as TextMessage).metadata?.segmentGroupId as string | undefined;
  if (groupId && groupId !== msg.id && parseAssistantBubbleIndex(msg) > 0) return false;
  return true;
}

function shouldRenderMessageRow(msg: AnyMessage): boolean {
  if (msg.isSelf || msg.type !== 'text') return true;
  const groupId = (msg as TextMessage).metadata?.segmentGroupId as string | undefined;
  if (groupId && groupId !== msg.id && parseAssistantBubbleIndex(msg) > 0) return false;
  return true;
}

function aggregatedAssistantFallback(msg: AnyMessage): string {
  const owner = resolveTimelineOwner(msg);
  const segments = owner.metadata?.segmentTexts;
  if (Array.isArray(segments) && segments.length > 0) {
    return segments
      .map((part) => (typeof part === 'string' ? part : ''))
      .filter((part) => part.trim())
      .join('\n\n');
  }
  return msg.type === 'text' ? String((msg as TextMessage).content || '') : '';
}

function isCompanionDialogueMessage(msg: AnyMessage, events: UnifiedChatEvent[]): boolean {
  return msg.type === 'text'
    && !msg.isSelf
    && isCompanionTimelineOwner(msg)
    && isCompanionChatTimeline(events);
}

function timelineItemsFor(msg: AnyMessage): TimelineItem[] {
  const events = timelineEventsFor(msg);
  const bubbleIndex = parseAssistantBubbleIndex(msg);
  const eventsKey = events.map(e => `${e.eventId}:${e.eventSequence}`).join(',');
  const cacheKey = `${msg.id}:${bubbleIndex}:${msg.type === 'text' ? (msg as any).content : ''}:${msg.status}:${eventsKey}`;

  if (timelineCache.has(cacheKey)) {
    return timelineCache.get(cacheKey)!;
  }

  let items: TimelineItem[];
  if (isCompanionDialogueMessage(msg, events)) {
    const liveText = buildCompanionLiveText(events, aggregatedAssistantFallback(msg));
    if (liveText.trim()) {
      // 对话模式流式：优先用已累积的正文（与刷新后历史一致），不依赖 timeline 是否已写入 text_delta
      items = [{
        kind: 'text',
        id: `companion-live-${msg.id}`,
        content: liveText,
      }];
    } else {
      items = buildCompanionDialogueDisplayItems(
        events,
        liveText,
      ) as TimelineItem[];
    }
  } else if (
    msg.type === 'text'
    && !msg.isSelf
    && String(msg.status || '') === 'sending'
    && !hasProcessTimelineEvents(events)
  ) {
    const content = String((msg as any).content || '');
    items = content.trim()
      ? [{ kind: 'text', id: `streaming-${msg.id}`, content, bubbleIndex }]
      : [];
  } else if (usesSegmentTimeline(msg)) {
    items = timelineItemsForBubble(
      events,
      bubbleIndex,
      msg.type === 'text' ? String((msg as TextMessage).content || '') : '',
    ) as TimelineItem[];
  } else {
    items = buildTimelineItems(events, msg.type === 'text' ? (msg as any).content || '' : '') as TimelineItem[];
  }
  timelineCache.set(cacheKey, items);
  return items;
}

function showCompanionWorkingHint(msg: AnyMessage): boolean {
  if (!isCompanionTimelineOwner(msg)) return false;
  const events = timelineEventsFor(msg);
  const liveText = buildCompanionLiveText(events, aggregatedAssistantFallback(msg));
  return shouldShowCompanionWorkingHint(events, String(msg.status || ''), liveText);
}


function shouldShowAssistantLoading(msg: AnyMessage): boolean {
  if (msg.type !== 'text' || msg.isSelf || String(msg.status || '') !== 'sending') {
    return false;
  }
  const events = timelineEventsFor(msg);
  const liveText = buildCompanionLiveText(events, aggregatedAssistantFallback(msg));
  return !String(liveText || '').trim();
}

function resolvedSenderAvatar(msg: AnyMessage): string {
  if (msg.isSelf) {
    return msg.senderAvatar || '';
  }
  return chatStore.currentConversation?.avatar || msg.senderAvatar || '/bot.png';
}

function resolvedSenderName(msg: AnyMessage): string {
  if (msg.isSelf) {
    return msg.senderName || '我';
  }
  return chatStore.currentConversation?.name || msg.senderName || '灵枢 AI';
}

/**
 * 取出当前 text timeline item 要渲染的内容。
 * 每条助手消息对应一个气泡；分段由后端 bubbleIndex + 独立 message 承担。
 */
function textContentFor(item: { content: string }, msg: AnyMessage): string {
  const raw = item.content
    || (msg.type === 'text' ? String((msg as TextMessage).content || '') : '');
  return stripEmbeddedImageMarkup(raw);
}

</script>

<template>
  <div class="message-list-shell">
    <div ref="listRef" class="message-list" :class="{ 'selection-mode': selectionMode }" @scroll="handleListScroll">
    <div v-if="messages.length === 0" class="empty-messages">
      <p>暂无消息记录</p>
    </div>
    <div v-else class="messages-container">
      <div v-if="hasMore || loadingOlder" class="history-loader">
        {{ loadingOlder ? '正在加载更早的消息…' : '上滑加载更早的消息' }}
      </div>
      <div v-for="(msg, index) in messages" v-show="shouldRenderMessageRow(msg)" :key="messageRenderKey(msg)" :id="`msg-${msg.id}`" class="message-item">
        <!-- 仅当时间间隔超过 5 分钟或第一条消息时显示时间 -->
        <div v-if="shouldShowTime(msg, index)" class="time-divider">
          {{ formatTime(msg.timestamp) }}
        </div>
        
        <a-dropdown
          trigger="contextMenu"
          align-point
          :style="{ display: 'block' }"
          :disabled="selectionMode"
        >
          <article
            class="message-row"
            :class="{
              self: msg.isSelf,
              other: !msg.isSelf,
              selectable: canSelectMessage(msg),
              selected: isMessageSelected(msg),
            }"
            @click="handleMessageRowClick(msg)"
          >
          <button
            v-if="selectionMode && canSelectMessage(msg) && !msg.isSelf"
            type="button"
            class="message-select-btn"
            :class="{ selected: isMessageSelected(msg) }"
            aria-label="选择消息"
            :aria-pressed="isMessageSelected(msg)"
            @click.stop="toggleMessageSelection(msg)"
          >
            <IconCheck v-if="isMessageSelected(msg)" class="message-select-icon" />
          </button>
          <!-- 非本人消息显示头像 -->
          <a-popover v-if="!msg.isSelf" position="right" trigger="hover">
            <div 
              class="avatar-wrapper"
              :class="{ 'skill-active-marquee': chatStore.currentSessionActiveSkills.length > 0 }"
            >
              <img 
                class="message-avatar" 
                :src="resolvedSenderAvatar(msg)" 
                :alt="resolvedSenderName(msg)"
              />
            </div>
            <template #content>
              <div class="skills-popover-content">
                <div class="skills-header">当前激活技能</div>
                <div v-if="chatStore.currentSessionActiveSkills.length === 0" class="no-skills">
                  尚未激活任何专业技能
                </div>
                <ul v-else class="skills-list">
                  <li v-for="skill in chatStore.currentSessionActiveSkills" :key="skill" class="skill-item">
                    <span class="skill-dot"></span>
                    {{ skill }}
                  </li>
                </ul>
              </div>
            </template>
          </a-popover>
          
            <div class="bubble-wrapper">
            <!-- Text message from bot: split by \n to render separate bubbles -->
            <template v-if="msg.type === 'text' && !msg.isSelf">
              <div
                v-if="showCompanionWorkingHint(msg)"
                class="companion-working-hint-slot"
                aria-live="polite"
              >
                <div class="companion-working-hint">
                  <span class="companion-working-dot" aria-hidden="true"></span>
                  正在处理…
                </div>
              </div>
              <template v-for="item in timelineItemsFor(msg)" :key="item.id">
                <template v-if="item.kind === 'process' && !isCompanionDialogueMessage(msg, timelineEventsFor(msg))">
                  <ThoughtProcess
                    class="embedded-process"
                    :events="item.events"
                    :task-status="String(lastTaskStatus(item.events) || 'running')"
                    :error-class="errorClassFor(item.events)"
                    :task-id="taskIdFor(item.events)"
                    @resume="chatStore.resumeTask"
                    @cancel="chatStore.cancelTask"
                  />
                </template>
                <template v-else-if="item.kind === 'text'">
                  <div
                    class="bubble other markdown-content"
                    @click="handleCopyClick"
                  >
                    <div class="bubble-text-inner" v-html="msg.status === 'sending' ? renderStreamingText(textContentFor(item, msg)) : renderMarkdown(msg.id, textContentFor(item, msg))" />
                  </div>
                </template>
              </template>
              <div
                v-if="shouldShowAssistantLoading(msg)"
                class="bubble other assistant-loading-bubble"
                aria-label="正在回复"
              >
                <div class="assistant-loading">
                  <span class="assistant-loading-dot"></span>
                  <span class="assistant-loading-dot"></span>
                  <span class="assistant-loading-dot"></span>
                </div>
              </div>
            </template>

            <!-- Other messages: single bubble (user message, image message, or unsupported type) -->
            <template v-else>
              <!-- System voice call message: rendered on user side (right) with phone icon -->
              <div
                v-if="msg.type === 'system' && msg.isSelf"
                class="bubble self voice-call-bubble"
              >
                <div class="voice-call-content">
                  <svg class="voice-call-icon" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-2.2 2.2a15.053 15.053 0 0 1-6.59-6.59l2.2-2.21a.96.96 0 0 0 .25-1.01A11.36 11.36 0 0 1 8.57 3.9c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1 0 9.39 7.61 17 17 17 .55 0 1-.45 1-1v-3.52c0-.55-.45-1-.99-1z"/>
                  </svg>
                  <span class="voice-call-text">{{ (msg as SystemMessage).content }}</span>
                </div>
              </div>
              <!-- Other system message: centered hint -->
              <div v-else-if="msg.type === 'system'" class="system-message">
                {{ (msg as SystemMessage).content }}
              </div>
              <div
                v-else
                class="bubble"
                :class="{ self: msg.isSelf, other: !msg.isSelf, image: msg.type === 'image' }"
                @click="msg.type === 'image' ? openImagePreview(msg as ImageMessage) : handleCopyClick"
              >
                <div
                  v-if="msg.type === 'text'"
                  class="text-content markdown-content"
                  v-html="renderMarkdown(msg.id, (msg as any).content)"
                />
                <div v-else-if="msg.type === 'image'" class="image-bubble">
                  <img
                    :src="(msg as ImageMessage).thumbnailUrl || (msg as ImageMessage).url"
                    :alt="String(msg.metadata?.fileName || '图片')"
                    class="image-content"
                  />
                </div>
                <span v-else class="unsupported">[{{ msg.type }} 消息]</span>
              </div>
            </template>
            
            <div v-if="!selectionMode" class="bubble-actions" :class="{ self: msg.isSelf, other: !msg.isSelf }">
              <button
                v-if="msg.type === 'text' && !msg.isSelf && settingsStore.tts.enabled"
                class="bubble-action-btn"
                :class="{ 'is-playing': isPlaying && currentPlayingId === msg.id }"
                @click="handleSpeakMessage(msg)"
                :title="isPlaying && currentPlayingId === msg.id ? '暂停朗读' : '朗读回复'"
              >
                <svg v-if="isPlaying && currentPlayingId === msg.id" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="action-icon"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="action-icon"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path></svg>
                <span>{{ isPlaying && currentPlayingId === msg.id ? '暂停' : '朗读' }}</span>
              </button>
              <button v-if="msg.type === 'text'" class="bubble-action-btn" @click="copyMessageContent(msg)" title="复制内容">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="action-icon"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                <span>复制</span>
              </button>
              <button class="bubble-action-btn" @click="enterSelectionMode(msg)" title="选择/删除消息">
                <IconDelete class="action-icon" />
                <span>删除</span>
              </button>
            </div>
          </div>
          <button
            v-if="selectionMode && canSelectMessage(msg) && msg.isSelf"
            type="button"
            class="message-select-btn"
            :class="{ selected: isMessageSelected(msg) }"
            aria-label="选择消息"
            :aria-pressed="isMessageSelected(msg)"
            @click.stop="toggleMessageSelection(msg)"
          >
            <IconCheck v-if="isMessageSelected(msg)" class="message-select-icon" />
          </button>
          </article>
          <template #content>
            <a-doption @click="enterSelectionMode(msg)">
              <template #icon><IconDelete /></template>
              选择删除
            </a-doption>
          </template>
        </a-dropdown>
      </div>
    </div>
    </div>
    <div v-if="selectionMode" class="selection-toolbar">
      <span>已选 {{ selectedCount }} 条</span>
      <div class="selection-actions">
        <a-button size="small" @click="exitSelectionMode">
          <template #icon><IconClose /></template>
          取消
        </a-button>
        <a-button
          size="small"
          status="danger"
          :disabled="selectedCount === 0"
          :loading="deleting"
          @click="confirmDeleteSelected"
        >
          <template #icon><IconDelete /></template>
          删除
        </a-button>
      </div>
    </div>
  </div>
  <div
    v-if="previewImage"
    class="image-preview-overlay"
    :class="{ dragging: previewDragging }"
    @click="handleOverlayClick"
    @wheel.prevent="handlePreviewWheel"
    @pointerdown="handlePreviewPointerDown"
    @pointermove="handlePreviewPointerMove"
    @pointerup="stopPreviewDragging"
    @pointercancel="stopPreviewDragging"
  >
    <!-- 右上角关闭按钮 -->
    <button class="preview-close-btn" @click.stop="closeImagePreview" title="关闭 (Esc)">
      <IconClose />
    </button>

    <!-- 图片展示区 -->
    <div class="image-preview-container">
      <img
        ref="previewImageRef"
        :src="previewImage.url"
        :alt="String(previewImage.metadata?.fileName || '图片')"
        class="image-preview-full"
        :class="{ dragging: previewDragging, zoomed: previewScale > 1 }"
        :style="{
          transform: `translate3d(${previewOffset.x}px, ${previewOffset.y}px, 0) scale(${previewScale}) rotate(${previewRotate}deg)`,
        }"
        draggable="false"
        @dblclick.stop="handlePreviewDoubleClick"
      />
    </div>

    <!-- 底部悬浮操作工具栏 -->
    <div class="preview-toolbar" @click.stop @pointerdown.stop>
      <button class="preview-tool-btn" @click="zoomOut" title="缩小 (滚轮下翻)">
        <IconZoomOut />
      </button>
      <span class="preview-scale-label">{{ Math.round(previewScale * 100) }}%</span>
      <button class="preview-tool-btn" @click="zoomIn" title="放大 (滚轮上翻)">
        <IconZoomIn />
      </button>
      <div class="preview-tool-divider" />
      <button class="preview-tool-btn" @click="resetPreviewTransform" title="还原 1:1">
        <IconOriginalSize />
      </button>
      <button class="preview-tool-btn" @click="rotateLeft" title="向左旋转 90°">
        <IconRotateLeft />
      </button>
      <button class="preview-tool-btn" @click="rotateRight" title="向右旋转 90°">
        <IconRotateRight />
      </button>
      <div class="preview-tool-divider" />
      <button class="preview-tool-btn" @click="downloadImage" title="保存/下载原图">
        <IconDownload />
      </button>
    </div>
  </div>
</template>

<style scoped>
.message-list-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.message-list {
  flex: 1;
  min-height: 0; /* 极其关键：允许 Flex 项目缩小到 0，防止遮挡 */
  overflow-y: auto;
  padding: 20px 0;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-chat-window);
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}

/* 自定义滚动条整体样式 */
.message-list::-webkit-scrollbar {
  width: 6px;
}

.message-list::-webkit-scrollbar-track {
  background: transparent;
}

.message-list::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 10px;
  transition: background var(--transition-normal);
}

.message-list:hover::-webkit-scrollbar-track {
  background: var(--scrollbar-track);
}

.message-list:hover::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
}

.message-list:hover {
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}

.message-list::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}

.messages-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-loader {
  align-self: center;
  margin: 2px 0 10px;
  padding: 4px 10px;
  border-radius: 999px;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  font-size: 12px;
  line-height: 1.5;
}

.message-item {
  display: flex;
  flex-direction: column;
  padding: 0 20px;
}

.time-divider {
  align-self: center;
  font-size: var(--font-size-xs);
  color: var(--text-placeholder);
  margin: 30px 0 10px;
}

.message-row {
  display: flex;
  width: 100%;
  margin: 8px 0;
  align-items: flex-start;
}

.message-row.self {
  justify-content: flex-end;
}

.message-row.other {
  justify-content: flex-start;
  gap: 8px;
}

.message-row.selectable {
  cursor: pointer;
}

.message-row.selected {
  background: color-mix(in srgb, rgb(var(--primary-6)) 10%, transparent);
  border-radius: 12px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(var(--primary-6)) 22%, transparent);
}

.message-list.selection-mode .bubble-actions {
  display: none;
}

.message-select-btn {
  width: 18px;
  height: 18px;
  margin-top: 11px;
  padding: 0;
  border-radius: 6px;
  border: 1.5px solid color-mix(in srgb, var(--text-tertiary) 70%, transparent);
  background: color-mix(in srgb, var(--bg-input) 90%, transparent);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: pointer;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.18s ease;
}

.message-row.self .message-select-btn {
  margin-left: 8px;
}

.message-row.other .message-select-btn {
  margin-right: 4px;
}

.message-select-btn:hover {
  border-color: color-mix(in srgb, rgb(var(--primary-6)) 55%, var(--border-color));
  background: color-mix(in srgb, rgb(var(--primary-6)) 8%, var(--bg-input));
}

.message-select-btn.selected {
  border-color: rgb(var(--primary-6));
  background: rgb(var(--primary-6));
  box-shadow: 0 0 0 3px color-mix(in srgb, rgb(var(--primary-6)) 20%, transparent);
}

.message-select-icon {
  font-size: 12px;
  stroke-width: 4;
}

.selection-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 13px;
}

.selection-actions {
  display: flex;
  gap: 8px;
}

.avatar-wrapper {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  flex-shrink: 0;
  background: var(--bg-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--border-color) 72%, transparent);
}

.message-avatar {
  width: 100%;
  height: 100%;
  border-radius: 10px;
  object-fit: cover;
  position: relative;
  z-index: 2; /* 确保在跑马灯渐变之上 */
}

.bubble-wrapper {
  width: fit-content;
  max-width: 85%;
  flex: 0 1 auto;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
}

.sender-info {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 12px;
  margin-bottom: 2px;
}

.sender-name {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}

.bubble-actions {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s, visibility 0.2s;
}

.bubble-wrapper:hover .bubble-actions {
  opacity: 1;
  visibility: visible;
}

.bubble-actions.self {
  align-self: flex-end;
  margin-right: 12px;
}

.bubble-actions.other {
  align-self: flex-start;
}

.bubble-action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  transition: all 0.2s;
}

.bubble-action-btn:hover {
  color: var(--text-secondary);
  background: var(--bg-hover);
}

.bubble-action-btn.is-playing {
  color: var(--color-primary);
}

.action-icon {
  width: 14px;
  height: 14px;
}

.skills-popover-content {
  min-width: 140px;
  padding: 4px 0;
}

.skills-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border-color);
}

.no-skills {
  font-size: 12px;
  color: var(--text-tertiary);
  font-style: italic;
}

.skills-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.skill-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-primary);
  padding: 4px 0;
}

.skill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 5px rgba(34, 197, 94, 0.5);
}

.ai-tag {
  background-color: var(--bg-selected);
  color: var(--text-tertiary);
  font-size: 10px;
  padding: 0px 4px;
  border-radius: 2px;
  font-weight: bold;
  line-height: 1.4;
  text-transform: uppercase;
}

.bubble {
  display: inline-flex;
  flex-direction: column;
  gap: 10px;
  width: auto;
  max-width: 100%;
  padding: 12px 16px;
  border-radius: 4px;
  font-size: var(--font-size-base);
  line-height: 1.5;
  word-break: break-word;
  position: relative;
  align-self: flex-start;
  user-select: text;
  -webkit-user-select: text;
}

.bubble.image {
  padding: 0;
  background-color: transparent;
  border-radius: 10px;
  box-shadow: none;
  overflow: hidden;
  cursor: zoom-in;
}

.bubble.image::after {
  display: none;
}

/* 图片消息不要套用文字气泡的绿色底和小圆角，否则四角会露出 #95EC69 */
.bubble.self.image {
  background-color: transparent;
  color: inherit;
  border-radius: 10px;
  overflow: hidden;
}

.bubble.self.image::after {
  display: none;
}

.bubble.other.image {
  background-color: transparent;
  border-radius: 10px;
  overflow: hidden;
}

.bubble.other.image::after {
  display: none;
}

.image-bubble {
  display: block;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background: var(--bg-hover);
  line-height: 0;
}

.image-content {
  display: block;
  width: 220px;
  max-width: min(56vw, 320px);
  max-height: 280px;
  object-fit: cover;
  border-radius: inherit;
  vertical-align: top;
}

.image-preview-overlay {
  position: fixed;
  top: var(--titlebar-height, 28px);
  right: 0;
  bottom: 0;
  left: var(--sidebar-width, 54px);
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(8px);
  overflow: hidden;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  cursor: grab;
}

.image-preview-overlay.dragging {
  cursor: grabbing;
}

.preview-close-btn {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(30, 30, 30, 0.65);
  backdrop-filter: blur(10px);
  color: #f0f0f0;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 1110;
  transition: all 0.2s ease;
}

.preview-close-btn:hover {
  background: rgba(230, 67, 64, 0.85);
  border-color: rgba(230, 67, 64, 0.9);
  color: #fff;
  transform: scale(1.08);
}

.image-preview-container {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.image-preview-full {
  max-width: min(88vw, 1200px);
  max-height: 82vh;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  transition: transform 0.15s cubic-bezier(0.2, 0, 0, 1);
  transform-origin: center center;
  user-select: none;
  -webkit-user-select: none;
  pointer-events: auto;
  will-change: transform;
}

.image-preview-full.dragging {
  transition: none !important;
}

.preview-toolbar {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: 24px;
  background: rgba(24, 24, 28, 0.85);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  z-index: 1110;
}

.preview-tool-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.18s ease;
}

.preview-tool-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  transform: scale(1.08);
}

.preview-tool-btn:active {
  transform: scale(0.95);
}

.preview-scale-label {
  min-width: 46px;
  text-align: center;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.75);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
}

.preview-tool-divider {
  width: 1px;
  height: 16px;
  background: rgba(255, 255, 255, 0.15);
  margin: 0 4px;
}



.bubble.other {
  background-color: var(--bg-message-other);
  color: var(--text-primary);
  border-radius: 8px;
  margin-left: 0;
  box-shadow: none;
}

.bubble.other::after {
  content: "";
  position: absolute;
  left: -8px;
  top: 12px;
  width: 0;
  height: 0;
  border-right: 10px solid var(--bg-message-other);
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
}

.bubble.other.no-tail::after {
  display: none;
}



.bubble.self {
  background-color: var(--bg-message-self);
  color: var(--text-message-self);
  margin-right: 12px;
  border-radius: 8px;
  align-self: flex-end;
}



.bubble.self::after {
  content: "";
  position: absolute;
  right: -8px;
  top: 12px;
  width: 0;
  height: 0;
  border-left: 10px solid var(--bg-message-self);
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
}

.text-content {
  user-select: text;
  -webkit-user-select: text;
}

.timeline-text + .timeline-text {
  margin-top: 4px;
}

.assistant-reply {
  width: 100%;
  max-width: 680px;
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.72;
  letter-spacing: 0;
}

.embedded-process + .assistant-reply {
  margin-top: 8px;
  padding-top: 2px;
}

.embedded-process {
  width: 100%;
  margin-top: 0;
}

.companion-working-hint-slot {
  position: absolute;
  left: 0;
  top: 0;
  transform: translateY(calc(-100% - 6px));
  z-index: 1;
  pointer-events: none;
}

.companion-working-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
  color: var(--text-secondary, #8b8b8b);
  font-size: 13px;
  line-height: 1.4;
}

.companion-working-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-primary, #6b9cff);
  animation: companion-working-pulse 1.2s ease-in-out infinite;
}

@keyframes companion-working-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.92); }
  50% { opacity: 1; transform: scale(1); }
}

.embedded-terminal-panel {
  width: 100%;
  margin-top: -2px;
}

.assistant-loading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 42px;
  min-height: 22px;
  padding: 2px 0;
}

.assistant-loading-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-tertiary) 88%, white 12%);
  opacity: 0.32;
  animation: assistant-dot-bounce 1.1s infinite ease-in-out;
}

.assistant-loading-dot:nth-child(2) {
  animation-delay: 0.16s;
}

.assistant-loading-dot:nth-child(3) {
  animation-delay: 0.32s;
}

.markdown-content {
  display: block;
  max-width: 100%;
  white-space: normal;
  line-height: 1.72;
  user-select: text;
  -webkit-user-select: text;
}

.markdown-content :deep(.stage-direction) {
  color: var(--text-tertiary, #999999);
}

.bubble.self :deep(.stage-direction) {
  color: color-mix(in srgb, var(--text-message-self, #1a1a1a) 52%, transparent);
}

/* 使用 Vue 3 推荐的 :deep() 语法确保样式穿透生效 */
.markdown-content :deep(p) {
  margin: 0 0 0.8em 0 !important; /* 强制段落间距 */
  line-height: inherit !important;
}

.markdown-content :deep(li) {
  margin: 0.2em 0 !important;
  line-height: inherit !important;
}

.markdown-content :deep(p:last-child) {
  margin-bottom: 0 !important;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  margin: 0.8em 0 0.4em; /* 这里的 0.4em 控制标题下方的间距 */
  font-weight: 600;
  line-height: 1.25;
  color: var(--text-primary);
}

.markdown-content :deep(h1) { font-size: 1.3em; }
.markdown-content :deep(h2) { font-size: 1.2em; }
.markdown-content :deep(h3) { font-size: 1.1em; }
.markdown-content :deep(h4) { font-size: 1.05em; }
.markdown-content :deep(h5) { font-size: 1em; }
.markdown-content :deep(h6) { font-size: 0.95em; }

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 0.4em 0;
  padding-left: 1.4em;
}

.markdown-content :deep(li + li) {
  margin-top: 0.2em;
}

.markdown-content :deep(code) {
  font-family: Consolas, "SFMono-Regular", monospace;
  font-size: 0.92em;
  background: var(--bg-selected);
  border-radius: 4px;
  padding: 0.12em 0.35em;
  color: var(--text-primary);
}

.markdown-content :deep(pre) {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
  background: var(--bg-code);
  color: var(--text-code);
}

.markdown-content :deep(.markdown-code-wrapper) {
  position: relative;
  margin: 0.5em 0;
}

.markdown-content :deep(.markdown-copy-btn) {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

.markdown-content :deep(.markdown-code-wrapper:hover .markdown-copy-btn) {
  opacity: 1;
}

.markdown-content :deep(.markdown-copy-btn:hover) {
  background: rgba(255, 255, 255, 0.2);
}

.markdown-content :deep(.copy-icon) {
  width: 14px;
  height: 14px;
}

.markdown-content :deep(pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
}

.markdown-content :deep(blockquote) {
  margin: 0.75em 0;
  padding-left: 0.9em;
  border-left: 3px solid rgba(148, 163, 184, 0.45);
  color: var(--text-secondary);
}

.markdown-content :deep(a) {
  color: #22c55e;
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

/* Markdown 表格样式 */
.markdown-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
  font-size: 0.95em;
  overflow: hidden;
  border-radius: 6px;
  border: 1px solid var(--border-color);
}

.markdown-content :deep(thead) {
  background: var(--bg-selected);
}

.markdown-content :deep(th) {
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 2px solid var(--border-color);
  border-right: 1px solid var(--border-color);
}

.markdown-content :deep(th:last-child) {
  border-right: none;
}

.markdown-content :deep(td) {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  border-right: 1px solid var(--border-color);
  color: var(--text-primary);
}

.markdown-content :deep(td:last-child) {
  border-right: none;
}

.markdown-content :deep(tbody tr:last-child td) {
  border-bottom: none;
}

.markdown-content :deep(tbody tr:hover) {
  background: var(--bg-hover);
}

.unsupported {
  color: var(--text-tertiary);
  font-style: italic;
}

.empty-messages {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-size: var(--font-size-md);
}

@keyframes pulse-border {
  0% { box-shadow: 0 0 0 0 var(--color-primary-light-3); }
  50% { box-shadow: 0 0 0 10px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

@keyframes assistant-dot-bounce {
  0%, 80%, 100% {
    transform: translateY(0) scale(0.92);
    opacity: 0.28;
  }
  40% {
    transform: translateY(-2px) scale(1);
    opacity: 0.92;
  }
}

.pulse-highlight .bubble {
  animation: pulse-border 1s ease-in-out 2;
  border: 1px solid var(--color-primary);
  transition: border 0.3s;
}

.system-message {
  text-align: center;
  padding: 8px 16px;
  margin: 12px 0;
  font-size: 12px;
  color: var(--color-text-3);
  background: var(--color-fill-2);
  border-radius: 4px;
  user-select: none;
}

.bubble.self.voice-call-bubble {
  display: inline-flex;
  align-items: center;
  padding: 9px 14px;
  cursor: default;
  user-select: none;
}

.voice-call-content {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  line-height: 1.4;
}

.voice-call-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  opacity: 0.88;
}



.capsule-wave .wave-bar.b2 {
  animation-delay: 0.25s;
}

.capsule-wave .wave-bar.b3 {
  animation-delay: 0.5s;
}

@keyframes wave-bar-pulse {
  0% {
    transform: scaleY(0.25);
  }
  100% {
    transform: scaleY(1);
  }
}

:deep(img.emoji.twemoji),
:deep(img.wechat-emoji) {
  display: inline-block !important;
  width: 20px;
  height: 20px;
  max-width: none;
  vertical-align: -0.22em;
  margin: 0 1px;
  flex-shrink: 0;
  object-fit: contain;
}
</style>
