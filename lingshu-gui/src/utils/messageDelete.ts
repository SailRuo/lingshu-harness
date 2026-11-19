/** Map guiv1 UI message id or metadata to backend chat_messages anchor id. */
export function resolveTurnAnchorId(uiId: string, metadata?: Record<string, any>): number | null {
  if (metadata) {
    if (metadata.turnId && Number.isFinite(Number(metadata.turnId)) && Number(metadata.turnId) > 0) {
      return Number(metadata.turnId);
    }
    if (metadata.persistedTurnId && Number.isFinite(Number(metadata.persistedTurnId)) && Number(metadata.persistedTurnId) > 0) {
      return Number(metadata.persistedTurnId);
    }
    if (metadata.anchorId && Number.isFinite(Number(metadata.anchorId)) && Number(metadata.anchorId) > 0) {
      return Number(metadata.anchorId);
    }
  }
  const match = uiId.match(/^(?:u|a|user|assistant|proactive)-(\d+)/);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw) || raw === 0) return null;
  if (raw < 0) {
    return Math.floor(Math.abs(raw) / 10_000);
  }
  return raw;
}

export function isDeletableUiMessage(_uiId: string, status?: string): boolean {
  return status !== 'sending';
}

export interface DeleteMessagesImpact {
  turnCount: number;
  messageCount: number;
  digestedTurnCount: number;
  streamCount: number;
  streams: Array<{
    id: string;
    narrative: string;
    rawStart?: number | null;
    rawEnd?: number | null;
  }>;
  recallTraceCount: number;
  hasMemoryAssociation: boolean;
}

export function buildDeleteConfirmContent(impact: DeleteMessagesImpact): string {
  const lines = [
    `将删除 ${impact.turnCount} 轮对话（共 ${impact.messageCount} 条消息），不可撤销。`,
  ];
  if (!impact.hasMemoryAssociation) {
    lines.push('这些消息尚未关联意识流或记忆整理数据。');
    return lines.join('\n');
  }
  lines.push('以下关联数据也会一并删除：');
  if (impact.streamCount > 0) {
    lines.push(`· 意识流 ${impact.streamCount} 条`);
    const preview = impact.streams
      .slice(0, 3)
      .map((item) => `  - ${item.narrative || item.id}`)
      .join('\n');
    if (preview) lines.push(preview);
  }
  if (impact.digestedTurnCount > 0) {
    lines.push(`· 已整理进记忆的对话回合 ${impact.digestedTurnCount} 轮`);
  }
  if (impact.recallTraceCount > 0) {
    lines.push(`· 记忆回响记录 ${impact.recallTraceCount} 条`);
  }
  return lines.join('\n');
}
