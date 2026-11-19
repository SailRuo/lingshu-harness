export interface FollowUpTtsRequest {
  content: string;
  messageId: string;
  agentId?: number | null;
  timestamp?: number;
}

type FollowUpTtsHandler = (request: FollowUpTtsRequest) => void;

let handler: FollowUpTtsHandler | null = null;

export function setFollowUpTtsHandler(next: FollowUpTtsHandler | null) {
  handler = next;
}

export function notifyFollowUpTts(request: FollowUpTtsRequest) {
  console.info('[followup-tts] notify', {
    messageId: request.messageId,
    chars: request.content.length,
    hasHandler: Boolean(handler),
  });
  handler?.(request);
}
