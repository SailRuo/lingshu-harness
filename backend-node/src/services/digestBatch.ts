/**
 * Private digest batching helpers (M1).
 *
 * The APP's batching rule is token-based, not turn-based: read the oldest
 * pending messages in the lookback window and take as many as fit into the
 * 128K input budget (minus prompt overhead), one transcript line per message.
 * Line numbers in `[n]` are what `continuity.nodes[].index` points at.
 */

export interface DigestMessageRow {
  id: number;
  thread_id: number;
  agent_id: number;
  user_id: string;
  role: "user" | "assistant" | string;
  content: string;
  created_at: string;
}

export interface DigestTranscriptRow {
  index: number;
  messageId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface DigestChunk {
  messages: DigestMessageRow[];
  transcript: string;
  rows: DigestTranscriptRow[];
  tokenEstimate: number;
}

/** APP `NativeCoreLingJing.estimateDigestTokens`: CJK chars count 1, others 1/4. */
export function estimateDigestTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of String(text || "")) {
    const cp = char.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xffef);
    if (wide) cjk += 1;
    else other += 1;
  }
  return cjk + Math.floor((other + 3) / 4);
}

export function flattenTranscriptContent(text: string): string {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

export function truncateToTokenBudget(text: string, budgetTokens: number): string {
  if (budgetTokens <= 0) return "";
  if (estimateDigestTokens(text) <= budgetTokens) return text;
  let low = 0;
  let high = String(text).length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (estimateDigestTokens(String(text).slice(0, mid)) <= budgetTokens) low = mid;
    else high = mid - 1;
  }
  // Never split a surrogate pair.
  if (low > 0 && low < String(text).length) {
    const code = String(text).charCodeAt(low - 1);
    if (code >= 0xd800 && code <= 0xdbff) low -= 1;
  }
  return String(text).slice(0, low);
}

export function buildDigestTranscript(
  messages: DigestMessageRow[],
  userLabel: string,
  agentLabel: string,
): { text: string; rows: DigestTranscriptRow[] } {
  const lines: string[] = [];
  const rows: DigestTranscriptRow[] = [];
  let index = 0;
  for (const message of messages) {
    const role = String(message.role || "");
    if (role !== "user" && role !== "assistant") continue;
    const content = flattenTranscriptContent(message.content);
    if (!content) continue;
    const label = role === "user" ? userLabel : agentLabel;
    lines.push(`[${index}] ${label}：${content}`);
    rows.push({
      index,
      messageId: Number(message.id),
      role,
      content,
      createdAt: message.created_at,
    });
    index += 1;
  }
  return { text: lines.join("\n"), rows };
}

function lineTokens(message: DigestMessageRow, userLabel: string, agentLabel: string): number {
  const label = String(message.role) === "user" ? userLabel : agentLabel;
  return estimateDigestTokens(`${label}：${flattenTranscriptContent(message.content)}`) + 8;
}

/**
 * Greedy oldest-first chunking. A single over-budget message is truncated (not
 * dropped) so a very long imported message cannot starve the batch.
 */
export function planDigestChunks(
  messages: DigestMessageRow[],
  userLabel: string,
  agentLabel: string,
  budgetTokens: number,
): DigestChunk[] {
  const chunks: DigestChunk[] = [];
  let current: DigestMessageRow[] = [];
  let used = 0;
  const flush = () => {
    if (!current.length) return;
    const built = buildDigestTranscript(current, userLabel, agentLabel);
    chunks.push({
      messages: current,
      transcript: built.text,
      rows: built.rows,
      tokenEstimate: used,
    });
    current = [];
    used = 0;
  };
  for (const message of messages) {
    const content = flattenTranscriptContent(message.content);
    if (!content) continue;
    const cost = lineTokens(message, userLabel, agentLabel);
    if (current.length && used + cost > budgetTokens) {
      flush();
    }
    if (!current.length && cost > budgetTokens) {
      const copy: DigestMessageRow = {
        ...message,
        content: `${truncateToTokenBudget(content, Math.max(1_024, budgetTokens - 64))}\n…（原消息过长，已截断）`,
      };
      current.push(copy);
      used += budgetTokens;
      flush();
      continue;
    }
    current.push(message);
    used += cost;
  }
  flush();
  return chunks;
}
