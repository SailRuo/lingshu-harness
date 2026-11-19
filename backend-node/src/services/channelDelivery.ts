/**
 * 外发通道（微信 / QQ）分段：一行一条消息。
 *
 * 对齐移动端 `src/chat/channelDelivery.ts` 的 `splitForChannelDelivery`：
 * 单独成行的圆括号动作（如「（轻声）」）不单独发送，而是跟随后面那句话，
 * 避免在 QQ / 微信里先冒出一条只有动作的消息。落库仍是单条原文，这里只负责投递。
 */

/** 整行都是圆括号动作（或剥掉动作后什么都不剩）→ 是一条「舞台指示」。 */
export function isStageDirectionOnlyLine(line: string): boolean {
  const t = String(line || "").trim();
  if (!t) return true;
  if (/^[（(][^）)]*[）)]$/.test(t)) return true;
  const without = t.replace(/[（(][^）)]*[）)]/g, "").trim();
  return without.length === 0;
}

export function splitForChannelDelivery(text: string): string[] {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const out: string[] = [];
  const cues: string[] = [];
  for (const line of lines) {
    if (isStageDirectionOnlyLine(line)) {
      cues.push(line);
      continue;
    }
    if (cues.length > 0) {
      out.push([...cues, line].join("\n"));
      cues.length = 0;
    } else {
      out.push(line);
    }
  }
  if (cues.length > 0) out.push(cues.join("\n"));
  return out;
}

/** 通道投递前剥掉思考块（桌面 chatStreamService 不剥 think，微信/QQ 侧在这里兜底）。 */
export function stripThinkBlocks(text: string): string {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}
