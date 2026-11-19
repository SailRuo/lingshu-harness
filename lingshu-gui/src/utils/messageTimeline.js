const PROCESS_EVENT_TYPES = new Set([
  'state',
  'thought',
  'tool_call',
  'tool_result',
  'terminal_command_started',
  'terminal_output',
  'terminal_command_finished',
]);

export function hasProcessTimelineEvents(events) {
  return [...events].some((event) => PROCESS_EVENT_TYPES.has(event.type));
}

function flushTextBuffer(items, textBuffer, textStartSequence, textBubbleIndex) {
  if (!textBuffer.trim()) {
    return { textBuffer: '', textStartSequence: null, textBubbleIndex: null };
  }
  items.push({
    kind: 'text',
    id: textStartSequence === null ? `text-${items.length}` : `text-${textStartSequence}`,
    content: textBuffer,
    bubbleIndex: textBubbleIndex ?? 0,
  });
  return { textBuffer: '', textStartSequence: null, textBubbleIndex: null };
}

function flushProcessBuffer(items, processBuffer) {
  if (processBuffer.length === 0) return [];
  items.push({
    kind: 'process',
    id: `process-${processBuffer[0].eventId || processBuffer[0].eventSequence}`,
    events: [...processBuffer],
  });
  return [];
}

/**
 * Build timeline items in eventSequence order, alternating text / process blocks.
 */
export function buildTimelineItems(events, fallbackContent = '') {
  const sortedEvents = [...events].sort((left, right) => left.eventSequence - right.eventSequence);
  if (sortedEvents.length === 0) {
    return fallbackContent.trim()
      ? [{ kind: 'text', id: 'text-fallback', content: fallbackContent, bubbleIndex: 0 }]
      : [];
  }

  const items = [];
  let textBuffer = '';
  let textStartSequence = null;
  let textBubbleIndex = null;
  let processBuffer = [];

  for (const event of sortedEvents) {
    if (event.type === 'text_delta') {
      flushProcessBuffer(items, processBuffer);
      processBuffer = [];

      const bubbleIndex = Number.isFinite(Number(event.metadata?.bubbleIndex))
        ? Number(event.metadata.bubbleIndex)
        : 0;
      if (
        textBuffer
        && textBubbleIndex !== null
        && bubbleIndex !== textBubbleIndex
      ) {
        ({ textBuffer, textStartSequence, textBubbleIndex } = flushTextBuffer(
          items,
          textBuffer,
          textStartSequence,
          textBubbleIndex,
        ));
      }
      if (textStartSequence === null) textStartSequence = event.eventSequence;
      textBubbleIndex = bubbleIndex;
      textBuffer += event.content || '';
      continue;
    }

    if (event.type === 'error') {
      flushProcessBuffer(items, processBuffer);
      processBuffer = [];
      if (textStartSequence === null) textStartSequence = event.eventSequence;
      if (textBubbleIndex === null) textBubbleIndex = 0;
      textBuffer += event.content ? `⚠️ ${event.content}` : '⚠️ 处理失败';
      continue;
    }

    if (PROCESS_EVENT_TYPES.has(event.type)) {
      ({ textBuffer, textStartSequence, textBubbleIndex } = flushTextBuffer(
        items,
        textBuffer,
        textStartSequence,
        textBubbleIndex,
      ));
      processBuffer.push(event);
    }
  }

  flushProcessBuffer(items, processBuffer);
  flushTextBuffer(items, textBuffer, textStartSequence, textBubbleIndex);

  if (items.length === 0 && fallbackContent.trim()) {
    return [{ kind: 'text', id: 'text-fallback', content: fallbackContent, bubbleIndex: 0 }];
  }

  return items;
}

/**
 * Assign interleaved timeline items to assistant text bubbles (\n segments).
 * Process blocks before a text segment attach to that segment's bubble.
 */
export function bucketTimelineItemsByBubble(items) {
  /** @type {Map<number, Array<{ kind: string }>>} */
  const buckets = new Map();
  /** @type {Array<{ kind: string }>} */
  let pendingProcess = [];

  const ensureBucket = (index) => {
    if (!buckets.has(index)) buckets.set(index, []);
    return buckets.get(index);
  };

  for (const item of items) {
    if (item.kind === 'process') {
      pendingProcess.push(item);
      continue;
    }
    if (item.kind === 'text') {
      const bubbleIndex = Number.isFinite(Number(item.bubbleIndex)) ? Number(item.bubbleIndex) : 0;
      const bucket = ensureBucket(bubbleIndex);
      if (pendingProcess.length > 0) {
        bucket.push(...pendingProcess);
        pendingProcess = [];
      }
      bucket.push(item);
    }
  }

  if (pendingProcess.length > 0) {
    const bucketIndexes = [...buckets.keys()];
    const attachIndex = bucketIndexes.length > 0 ? Math.max(...bucketIndexes) : 0;
    ensureBucket(attachIndex).push(...pendingProcess);
  }

  return buckets;
}

export function isCompanionChatTimeline(events) {
  return [...events].some((event) =>
    event?.metadata?.route === 'chat-fast' || event?.metadata?.companion_v3 === true,
  );
}

/**
 * When tools chronologically precede narration, swap groups for readability.
 * Otherwise preserve interleaved text/process order (text → tools → text → tools).
 */
export function reorderBubbleItemsForDisplay(items, events) {
  if (!isCompanionChatTimeline(events)) {
    return items;
  }
  const firstTextIdx = items.findIndex((item) => item.kind === 'text');
  const firstProcessIdx = items.findIndex((item) => item.kind === 'process');
  if (firstProcessIdx !== -1 && (firstTextIdx === -1 || firstProcessIdx < firstTextIdx)) {
    const texts = items.filter((item) => item.kind === 'text');
    const processes = items.filter((item) => item.kind === 'process');
    return [...texts, ...processes];
  }
  return items;
}

/** 对话模式：只保留文字气泡，按时间顺序排列，不展示工具过程块。 */
export function buildCompanionDialogueDisplayItems(allEvents, fallbackContent = '') {
  const interleaved = buildTimelineItems(allEvents, '');
  const textItems = interleaved
    .filter((item) => item.kind === 'text' && String(item.content || '').trim())
    .map((item, index) => ({
      kind: 'text',
      id: `companion-text-${item.id || index}`,
      content: item.content,
    }));
  if (textItems.length > 0) {
    return textItems;
  }
  if (fallbackContent.trim()) {
    return [{
      kind: 'text',
      id: 'companion-text-fallback',
      content: fallbackContent,
    }];
  }
  return [];
}

/** 口播段是否已在句读处结束（工具边界前完整的一 beat）。 */
export function isNarrationSegmentComplete(text) {
  const stripped = String(text || '').trimEnd();
  if (!stripped) return false;
  if (/[。！？；.!?;…]$/.test(stripped)) return true;
  if (/["'")」』】]$/.test(stripped)) return true;
  if (stripped.endsWith('\n')) return true;
  return false;
}

/** 对话模式：把多段 narration 合并为一段展示文本，仅完整 beat 之间空行分隔。 */
export function joinCompanionDialogueText(textItems) {
  const parts = textItems
    .map((item) => String(item.content || ''))
    .filter((part) => part.trim());
  if (parts.length === 0) return '';
  let result = parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    const separator = isNarrationSegmentComplete(parts[index - 1]) ? '\n\n' : '';
    result += separator + parts[index];
  }
  return result;
}

/** 对话模式流式正文：timeline 多段优先，否则 fallback；content 更长时优先 content。 */
export function buildCompanionLiveText(allEvents, fallbackContent = '') {
  const items = buildCompanionDialogueDisplayItems(allEvents, fallbackContent);
  const fromTimeline = joinCompanionDialogueText(items);
  const fallback = String(fallbackContent || '').trim();
  if (fromTimeline.trim() && fallback) {
    return fallback.length > fromTimeline.length ? fallback : fromTimeline;
  }
  return fromTimeline.trim() || fallback;
}

/** 工具刚跑完、下一段文字还没到时，显示轻量「正在处理…」提示。 */
export function shouldShowCompanionWorkingHint(events, messageStatus, liveText = '') {
  if (String(messageStatus || '') !== 'sending') return false;
  if (!isCompanionChatTimeline(events)) return false;
  const text = String(liveText || '').trim();
  // 尚未有任何口播文本时不展示（首段工具调用由 loading 点承担）
  if (!text) return false;
  // 口播仍在句中输出时不展示，避免与流式文字抢戏
  if (!isNarrationSegmentComplete(text)) return false;
  const sorted = [...events].sort((left, right) => left.eventSequence - right.eventSequence);
  // 口播流已结束（落库/收尾中）或整轮已 done：不要再挂「正在处理」
  if (sorted.some((event) => event.type === 'done')) return false;
  if (sorted.some((event) => (
    event.type === 'state' && String(event.content || '') === 'text_stream_completed'
  ))) {
    return false;
  }
  const last = sorted
    .filter((event) => !['done', 'state'].includes(event.type))
    .at(-1);
  if (!last) return false;
  return last.type === 'tool_call' || last.type === 'tool_result';
}

export function timelineItemsForBubble(allEvents, bubbleIndex, fallbackContent = '') {
  const interleaved = buildTimelineItems(allEvents, '');
  const buckets = bucketTimelineItemsByBubble(interleaved);
  const bucketItems = [...(buckets.get(bubbleIndex) || [])];
  const hasTextItem = bucketItems.some((item) => item.kind === 'text');
  if (!hasTextItem && fallbackContent.trim()) {
    bucketItems.push({
      kind: 'text',
      id: `text-fallback-${bubbleIndex}`,
      content: fallbackContent,
      bubbleIndex,
    });
  }
  if (bucketItems.length > 0) {
    return reorderBubbleItemsForDisplay(bucketItems, allEvents);
  }
  if (fallbackContent.trim()) {
    return [{ kind: 'text', id: `text-fallback-${bubbleIndex}`, content: fallbackContent, bubbleIndex }];
  }
  return [];
}
