/**
 * 上下文大小档位（K tokens）：大模型请求携带的对话数据上限。历史原文从新到旧
 * 装填到「预算 − 余量」为止，超出部分由回合后的空闲摘要压缩成「历史会话摘要」。
 * 后端 conversationAnchorService 读同一个键（chatContextBudgetK），语义对齐
 * App 端 chatUiSettings.ts / NativeSecretsPlugin.chatContextTokenBudget。
 */
export type ContextBudgetK = 64 | 128 | 256 | 512

export const CONTEXT_BUDGET_OPTIONS: Array<{ value: ContextBudgetK; label: string }> = [
  { value: 64, label: '64K' },
  { value: 128, label: '128K' },
  { value: 256, label: '256K' },
  { value: 512, label: '512K' },
]

/** 压缩触发/装填共用的安全余量（后端 CONTEXT_TRIGGER_MARGIN_TOKENS 一致）。 */
export const CONTEXT_TRIGGER_MARGIN_TOKENS = 5_000

export function normalizeContextBudgetK(raw: unknown): ContextBudgetK {
  const k = Number(raw)
  if (k === 64 || k === 128 || k === 256 || k === 512) return k
  return 128
}
