<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { Modal, Message } from '@arco-design/web-vue';
import MemoryPageShell from '../components/memory/MemoryPageShell.vue';
import { useMemoryApiContext, type MemoryAgentFilter } from '../composables/useMemoryApiContext';
import { useAgentsStore } from '../stores/agents';

interface ConstraintItem {
  id: number;
  ruleType: string;
  description: string;
  optOutProactive: boolean;
  evidence?: string | null;
  createdAt: string | null;
}

interface AppointmentItem {
  id: number;
  title: string;
  dueAt: string | null;
  allDay?: boolean;
  evidence?: string | null;
  status: string;
  recur: string;
}

function formatAppointmentDue(item: AppointmentItem): string {
  if (!item.dueAt) return '';
  const date = new Date(item.dueAt);
  if (item.allDay !== false) {
    return date.toLocaleDateString();
  }
  return date.toLocaleString();
}

const agentsStore = useAgentsStore();
const agentFilter = ref<MemoryAgentFilter>(0);
const { memoryQueryParams, getFullUrl } = useMemoryApiContext({ agentFilter });

const loading = ref(false);
const errorText = ref('');
const constraints = ref<ConstraintItem[]>([]);
const appointments = ref<AppointmentItem[]>([]);

async function load() {
  loading.value = true;
  errorText.value = '';
  try {
    const params = memoryQueryParams();
    const [cRes, aRes] = await Promise.all([
      fetch(getFullUrl(`/api/v1/memory/constraints?${params}`)),
      fetch(getFullUrl(`/api/v1/memory/appointments?${params}`)),
    ]);
    if (!cRes.ok || !aRes.ok) throw new Error('HTTP error');
    const cData = await cRes.json();
    const aData = await aRes.json();
    constraints.value = Array.isArray(cData.items) ? cData.items : [];
    appointments.value = Array.isArray(aData.items) ? aData.items : [];
  } catch (e) {
    errorText.value = (e as Error).message || '加载失败';
  } finally {
    loading.value = false;
  }
}

watch(agentFilter, () => { void load(); });
onMounted(() => {
  void agentsStore.fetchAgents();
  void load();
});

function confirmDeleteConstraint(item: ConstraintItem) {
  Modal.confirm({
    title: '删除这条规则？',
    content: item.description,
    okText: '删除',
    okButtonProps: { status: 'danger' },
    cancelText: '取消',
    onOk: async () => {
      const params = memoryQueryParams();
      const res = await fetch(getFullUrl(`/api/v1/memory/constraints/${item.id}?${params}`), {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      Message.success('已删除');
      await load();
    },
  });
}
</script>

<template>
  <MemoryPageShell v-model:agent-filter="agentFilter" title="边界与约定" subtitle="她学会的规矩 · 记下的日子">
    <div class="boundaries-content">
      <div v-if="loading" class="state-box">加载中…</div>
      <div v-else-if="errorText" class="state-box error">{{ errorText }}</div>
      <div v-else class="split-layout">
        <section class="panel">
          <h2>边界规则 <span class="count">{{ constraints.length }}</span></h2>
          <div v-if="!constraints.length" class="empty">尚未学到明确边界</div>
          <article v-for="c in constraints" :key="c.id" class="rule-card" :class="c.ruleType">
            <header class="rule-head">
              <span class="rule-badge">{{ c.ruleType === 'do' ? '可以' : '不要' }}</span>
              <button type="button" class="delete-btn" @click="confirmDeleteConstraint(c)">删除</button>
            </header>
            <p>{{ c.description }}</p>
            <p v-if="c.evidence" class="rule-evidence">原话：{{ c.evidence }}</p>
            <time v-if="c.createdAt">{{ new Date(c.createdAt).toLocaleDateString() }}</time>
          </article>
        </section>
        <section class="panel">
          <h2>约定提醒 <span class="count">{{ appointments.length }}</span></h2>
          <div v-if="!appointments.length" class="empty">暂无约定</div>
          <article v-for="a in appointments" :key="a.id" class="appt-card">
            <div class="appt-head">
              <strong>{{ a.title }}</strong>
              <span class="status">{{ a.status }}</span>
            </div>
            <p v-if="a.evidence" class="appt-evidence">原话：{{ a.evidence }}</p>
            <p v-if="a.dueAt" class="appt-due">到期 {{ formatAppointmentDue(a) }}</p>
            <span v-if="a.recur !== 'none'" class="recur">{{ a.recur }}</span>
          </article>
        </section>
      </div>
    </div>
  </MemoryPageShell>
</template>

<style scoped>
.boundaries-content { padding: 16px 24px 32px; }
.state-box { padding: 48px; text-align: center; color: var(--text-secondary); }
.split-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.panel {
  padding: 16px; border-radius: 12px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  background: var(--bg-secondary, rgba(255,255,255,0.02));
}
.panel h2 { margin: 0 0 14px; font-size: 15px; }
.count { font-size: 12px; color: var(--text-secondary); font-weight: 400; }
.rule-card, .appt-card {
  padding: 12px; margin-bottom: 8px; border-radius: 10px;
  border: 1px solid var(--border-color, rgba(255,255,255,0.06));
  background: rgba(255,255,255,0.02);
}
.rule-card p, .appt-card p { margin: 8px 0 0; font-size: 13px; line-height: 1.5; }
.rule-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.delete-btn {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 12px;
  color: #f87171;
  cursor: pointer;
}
.delete-btn:hover { text-decoration: underline; }
.rule-evidence,
.appt-evidence {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.55));
  line-height: 1.45;
}
.appt-due { margin-top: 4px; }
.rule-badge {
  display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
}
.rule-card.do .rule-badge { background: rgba(52,211,153,0.15); color: #34d399; }
.rule-card.dont .rule-badge { background: rgba(248,113,113,0.15); color: #f87171; }
.appt-head { display: flex; justify-content: space-between; gap: 8px; }
.status { font-size: 11px; color: var(--text-secondary); }
.empty { font-size: 13px; color: var(--text-secondary); }
@media (max-width: 800px) { .split-layout { grid-template-columns: 1fr; } }
</style>
