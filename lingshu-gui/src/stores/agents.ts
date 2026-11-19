import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface AgentConfig {
  id?: number;
  name: string;
  displayName: string;
  roleSetting?: string;
  speakingStyle?: string;
  selfEvolutionEnabled?: boolean;
  timeMirrorEnabled?: boolean;
  proactiveEnabled?: boolean;
  avatar?: string;
  color?: string;
  voice?: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

import { getFullUrl } from '../utils/apiConfig';

export const useAgentsStore = defineStore('agents', () => {
  const agents = ref<AgentConfig[]>([]);
  const isLoading = ref(false);
  const isLoaded = ref(false);
  const selectedAgentId = ref<number | null>(null);

  async function fetchAgents(force = false) {
    if (isLoaded.value && !force) return;
    if (isLoading.value) return;

    isLoading.value = true;
    try {
      const res = await fetch(getFullUrl('/api/v1/agents'));
      if (res.ok) {
        agents.value = await res.json();
        isLoaded.value = true;
      }
    } catch (err) {
      console.error('Failed to fetch agents', err);
    } finally {
      isLoading.value = false;
    }
  }

  async function createAgent(agentData: Partial<AgentConfig>) {
    try {
      const res = await fetch(getFullUrl('/api/v1/agents'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentData),
      });
      if (res.ok) {
        await fetchAgents(true);
        return await res.json();
      }
    } catch (err) {
      console.error('Failed to create agent', err);
    }
    return null;
  }

  async function updateAgent(id: number, agentData: Partial<AgentConfig>) {
    try {
      const res = await fetch(getFullUrl(`/api/v1/agents/${id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentData),
      });
      if (res.ok) {
        await fetchAgents(true);
        return await res.json();
      }
    } catch (err) {
      console.error('Failed to update agent', err);
    }
    return null;
  }

  async function deleteAgent(id: number) {
    try {
      const res = await fetch(getFullUrl(`/api/v1/agents/${id}`), {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchAgents(true);
        return true;
      }
    } catch (err) {
      console.error('Failed to delete agent', err);
    }
    return false;
  }

  async function setDefaultAgent(id: number) {
    try {
      const res = await fetch(getFullUrl(`/api/v1/agents/${id}/set-default`), {
        method: 'POST',
      });
      if (res.ok) {
        await fetchAgents(true);
        return true;
      }
    } catch (err) {
      console.error('Failed to set default agent', err);
    }
    return false;
  }

  async function getAgentDefaults() {
    try {
      const res = await fetch(getFullUrl('/api/v1/agents/defaults'));
      if (res.ok) {
        return await res.json();
      }
    } catch (err) {
      console.error('Failed to get agent defaults', err);
    }
    return null;
  }

  async function generateRoleSetting(draft: string, agentName = '') {
    try {
      const res = await fetch(getFullUrl('/api/v1/agents/role-setting/polish'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft, agentName }),
      });
      if (res.ok) {
        return await res.json();
      }
      const detail = await res.text();
      throw new Error(detail || `HTTP ${res.status}`);
    } catch (err) {
      console.error('Failed to generate role setting', err);
      throw err;
    }
  }

  return {
    agents,
    isLoading,
    isLoaded,
    selectedAgentId,
    fetchAgents,
    createAgent,
    updateAgent,
    deleteAgent,
    setDefaultAgent,
    getAgentDefaults,
    generateRoleSetting,
  };
});
