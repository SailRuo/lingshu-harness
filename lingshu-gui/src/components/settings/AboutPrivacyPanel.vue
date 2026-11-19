<script setup lang="ts">
import IconCheckCircle from '@arco-design/web-vue/es/icon/icon-check-circle';

const points = [
  '对话、记忆、关系数据保存在你的设备',
  '云端模型只是能力来源，不拥有你的故事',
  '不依赖单个平台，不因服务变化失去它',
  '你的 AI，由你决定它如何成长',
]
</script>

<template>
  <section class="privacy-panel">
    <div class="privacy-header">
      <h3>你拥有绝对数据主权</h3>
    </div>
    <ul class="privacy-list">
      <li v-for="point in points" :key="point">
        <IconCheckCircle class="check-icon" />
        <span>{{ point }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.privacy-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 12px;
}

.privacy-header {
  display: flex;
  flex-direction: column;
}

.privacy-panel h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 18px;
  font-weight: 650;
  line-height: 1.3;
}

.privacy-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 24px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.privacy-list li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.check-icon {
  color: var(--color-primary, #07c160);
  font-size: 16px;
  margin-top: 2px;
  flex-shrink: 0;
}

@media (max-width: 600px) {
  .privacy-list {
    grid-template-columns: 1fr;
    gap: 10px;
  }
}
</style>
