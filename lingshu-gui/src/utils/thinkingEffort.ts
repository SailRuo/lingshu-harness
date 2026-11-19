/**
 * 思考档位（思考程度），与 App 端 `src/llm/llmConfig.ts` 的 5 档语义对齐：
 *
 * - `default`：不下发任何思考参数，交给上游默认。
 * - `off`：明确下发「关闭思考」。
 * - `low` / `medium` / `high`：明确要求开启思考，并按强度下发。
 */
export type ThinkingEffort = 'default' | 'off' | 'low' | 'medium' | 'high'

export const THINKING_OPTIONS: Array<{ value: ThinkingEffort; label: string }> = [
  { value: 'default', label: '默认' },
  { value: 'off', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

export function normalizeThinkingEffort(raw: unknown): ThinkingEffort {
  const norm = String(raw ?? '').trim().toLowerCase()
  if (norm === 'off' || norm === 'low' || norm === 'medium' || norm === 'high') return norm
  return 'default'
}

/** 是否要求上游开启思考（只有低/中/高三档会下发开启参数）。 */
export function thinkingEffortIsActive(effort: ThinkingEffort): boolean {
  return effort === 'low' || effort === 'medium' || effort === 'high'
}

/**
 * 桌面版遗留 `enableThinking` 布尔迁移。与 App 不同：桌面版这个布尔从未接入下发
 * （无 UI、请求里也不带），false 是休眠默认而非「显式关闭」，所以
 * false → 'default'（保持现状），true → 'medium'（开过就给中档）。
 */
export function normalizeEffortWithLegacy(rawEffort: unknown, legacyEnableThinking: unknown): ThinkingEffort {
  const effort = normalizeThinkingEffort(rawEffort)
  if (effort !== 'default') return effort
  return legacyEnableThinking === true || legacyEnableThinking === 'true' ? 'medium' : 'default'
}
