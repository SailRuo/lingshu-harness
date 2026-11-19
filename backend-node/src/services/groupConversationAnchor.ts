import { requestDigestJson } from "./memoryService.js";
import {
  listRecentGroupMessages,
  readGroupAnchor,
  upsertGroupAnchor,
} from "./groupChatRepository.js";
import {
  buildGroupAnchorPrompt,
  formatGroupPublicTranscript,
  GROUP_ANCHOR_TRIGGER_MESSAGES,
} from "./groupPrompt.js";
import type { GroupMember } from "./groupChatTypes.js";

const running = new Set<string>();

/**
 * Compress public messages that have scrolled out of the live window. The
 * anchor is built only from public group messages; member-private recall is
 * never an input and therefore can never leak into it.
 */
export async function refreshGroupConversationAnchor(input: {
  groupId: string;
  groupTitle: string;
  userLabel: string;
  members: GroupMember[];
}): Promise<boolean> {
  if (running.has(input.groupId)) return false;
  running.add(input.groupId);
  try {
    const [anchor, recent] = await Promise.all([
      Promise.resolve(readGroupAnchor(input.groupId)),
      Promise.resolve(listRecentGroupMessages(input.groupId, 200)),
    ]);
    const priorIndex = anchor
      ? recent.findIndex((message) => message.id === anchor.coveredMessageId)
      : -1;
    const start = priorIndex >= 0 ? priorIndex + 1 : 0;
    const fresh = recent.slice(start).filter((message) => message.content.trim());
    if (fresh.length < GROUP_ANCHOR_TRIGGER_MESSAGES) return false;
    const cutoff = fresh[fresh.length - 1];
    if (!cutoff) return false;
    if (anchor?.coveredMessageId === cutoff.id) return false;
    const transcript = formatGroupPublicTranscript(fresh, input.members, input.userLabel);
    const system = buildGroupAnchorPrompt({
      groupTitle: input.groupTitle,
      previousSummary: anchor?.summary || "",
      transcript,
    });
    const result = (await requestDigestJson(system, "请总结以上群聊。", {
      temperature: 0.1,
      retries: 1,
    })) as { summary?: unknown };
    const summary = String(result?.summary || "").trim();
    if (!summary) return false;
    upsertGroupAnchor({
      groupId: input.groupId,
      summary,
      coveredMessageId: cutoff.id,
      coveredAt: cutoff.createdAt,
    });
    return true;
  } finally {
    running.delete(input.groupId);
  }
}
