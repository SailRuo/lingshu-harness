import {
  CHAT_EVENT_RENDER_TARGET,
  CHAT_EVENT_TYPES,
  getChatEventRenderTarget,
  type ChatEventRenderTarget,
  type UnifiedChatEventType,
} from '../types/chat-events';

export const eventRoutingContract: Record<UnifiedChatEventType, ChatEventRenderTarget> =
  CHAT_EVENT_RENDER_TARGET;

export const routedEventTypes = CHAT_EVENT_TYPES.map((type) => ({
  type,
  target: getChatEventRenderTarget(type),
}));
