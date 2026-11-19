<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useSettingsStore } from '../../stores/settings';

const store = useSettingsStore();

function parseTrustedCommands(value: string) {
  return value
    .split(/[\s\n\r,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const readRootsDraft = ref('');
const writeRootsDraft = ref('');
const trustedCommandsDraft = ref('');

const securitySignature = computed(() =>
  JSON.stringify({
    enforceGitRollback: !!store.security.enforceGitRollback,
    readRoots: store.security.readRoots,
    writeRoots: store.security.writeRoots,
    trustedCommands: store.security.trustedCommands,
    fullAccessEnabled: !!store.security.fullAccessEnabled
  })
);

function syncTrustedCommandsDraft() {
  readRootsDraft.value = store.security.readRoots.join('\n');
  writeRootsDraft.value = store.security.writeRoots.join('\n');
  trustedCommandsDraft.value = store.security.trustedCommands.join('\n');
}

function commitReadRootsDraft() {
  store.security.readRoots = readRootsDraft.value.split('\n').map((item) => item.trim()).filter(Boolean);
}

function commitWriteRootsDraft() {
  store.security.writeRoots = writeRootsDraft.value.split('\n').map((item) => item.trim()).filter(Boolean);
}

function commitTrustedCommandsDraft() {
  store.security.trustedCommands = parseTrustedCommands(trustedCommandsDraft.value);
}

async function flushSecurityDrafts(force = false) {
  commitReadRootsDraft();
  commitWriteRootsDraft();
  commitTrustedCommandsDraft();
  await store.saveSecuritySettings({ showSuccess: false, force });
}

async function handleReadRootsBlur() {
  commitReadRootsDraft();
  await store.saveSecuritySettings({ showSuccess: false });
}

async function handleWriteRootsBlur() {
  commitWriteRootsDraft();
  await store.saveSecuritySettings({ showSuccess: false });
}

async function handleTrustedCommandsBlur() {
  commitTrustedCommandsDraft();
  await store.saveSecuritySettings({ showSuccess: false });
}

async function handleToggleChange() {
  await store.saveSecuritySettings({ showSuccess: false });
}

onMounted(() => {
  store.fetchSecuritySettings();
});

watch(
  securitySignature,
  () => syncTrustedCommandsDraft(),
  { immediate: true }
);

onBeforeUnmount(() => {
  void flushSecurityDrafts();
});
</script>

<template>
  <div class="security-settings">
    <div class="panel hero">
      <div>
        <h3>安全与回滚</h3>
        <p>定义工具的可读写边界、默认信任命令，以及是否启用 Git 回滚保护。</p>
      </div>
    </div>

    <div class="panel">
      <div class="switch-row">
        <div>
          <h4>启用 Git 原子回滚</h4>
          <p>写操作失败时尝试回到任务启动前的 Git 快照。</p>
        </div>
        <a-switch v-model="store.security.enforceGitRollback" :loading="store.securitySaving" @change="handleToggleChange" />
      </div>

      <div class="switch-row">
        <div>
          <h4>完整访问权限</h4>
          <p>任何操作不会发起审批，Agent 将直接执行工具与命令。</p>
        </div>
        <a-switch v-model="store.security.fullAccessEnabled" :loading="store.securitySaving" @change="handleToggleChange" />
      </div>
    </div>

    <div class="grid">
      <div class="panel">
        <h4>只读目录白名单</h4>
        <p>每行一个目录，未列出的路径默认不应被读工具长期访问。</p>
        <a-textarea
          v-model="readRootsDraft"
          :auto-size="{ minRows: 6, maxRows: 10 }"
          @blur="handleReadRootsBlur"
        />
      </div>

      <div class="panel">
        <h4>可写目录白名单</h4>
        <p>每行一个目录，建议只保留工作区或临时输出目录。</p>
        <a-textarea
          v-model="writeRootsDraft"
          :auto-size="{ minRows: 6, maxRows: 10 }"
          @blur="handleWriteRootsBlur"
        />
      </div>
    </div>

    <div class="panel">
      <h4>默认信任命令</h4>
      <p>每行一个命令名，用于提示哪些环境命令可以走更轻量的审批路径。</p>
      <a-textarea
        v-model="trustedCommandsDraft"
        :auto-size="{ minRows: 5, maxRows: 8 }"
        @blur="handleTrustedCommandsBlur"
      />
    </div>
  </div>
</template>

<style scoped>
.security-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}

.panel {
  padding: 20px;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-input);
}

.panel h3,
.panel h4 {
  margin: 0 0 8px;
  color: var(--text-primary);
}

.panel p {
  margin: 0 0 14px;
  color: var(--text-tertiary);
  font-size: 13px;
  line-height: 1.6;
}

.hero {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.switch-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
}

.switch-row + .switch-row {
  margin-top: 18px;
}

@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }

  .hero,
  .switch-row {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
