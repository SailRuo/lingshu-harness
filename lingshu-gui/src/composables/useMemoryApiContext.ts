import { computed, type Ref } from 'vue';
import { useChatStore } from '../stores/chat';
import { getFullUrl } from '../utils/apiConfig';

export type MemoryAgentScope = 'session';
/** Page-level agent filter: a specific agent id. */
export type MemoryAgentFilter = number;

export function useMemoryApiContext(options?: {
  agentScope?: MemoryAgentScope;
  /** When set, overrides agentScope for API query params (e.g. memory graph page). */
  agentFilter?: Ref<MemoryAgentFilter>;
}) {
  const chatStore = useChatStore();

  const userId = computed(() => String(chatStore.userId || 'default_user'));
  const agentId = computed(() => {
    const value = chatStore.currentAgentId;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  });

  const scopedAgentId = computed(() => {
    const filter = options?.agentFilter?.value;
    if (typeof filter === 'number' && Number.isFinite(filter)) {
      return filter;
    }
    return agentId.value;
  });

  function applyAgentScopeParams(params: URLSearchParams) {
    params.set('agentId', String(scopedAgentId.value));
  }

  function memoryQueryParams(
    extra?: Record<string, string | number | boolean | null | undefined>,
  ): URLSearchParams {
    const params = new URLSearchParams({
      userId: userId.value,
    });
    applyAgentScopeParams(params);
    if (!extra) return params;
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    return params;
  }

  return {
    userId,
    agentId,
    scopedAgentId,
    memoryQueryParams,
    getFullUrl,
  };
}
