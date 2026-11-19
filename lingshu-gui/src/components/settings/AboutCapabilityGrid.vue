<script setup lang="ts">
import IconMessage from '@arco-design/web-vue/es/icon/icon-message';
import IconEye from '@arco-design/web-vue/es/icon/icon-eye';
import IconSound from '@arco-design/web-vue/es/icon/icon-sound';
import IconLock from '@arco-design/web-vue/es/icon/icon-lock';

const groups = [
  {
    title: '陪你对话',
    lead: '不只是回答问题',
    desc: '它会理解你的语气、习惯和想法。聊过的话不会成为一次性的消耗。',
    icon: IconMessage,
  },
  {
    title: '长期记忆',
    lead: '它会慢慢认识你',
    desc: '记住重要的人、经历和选择。不是每次见面，都重新认识你。',
    icon: IconEye,
  },
  {
    title: '实时交流',
    lead: '像真实关系一样相处',
    desc: '支持语音交流。不用打开一个窗口，才开始聊天。',
    icon: IconSound,
  },
  {
    title: '私属于你',
    lead: '它住在你的设备里',
    desc: '数据、记忆、人格都由你掌控。你决定它如何存在。',
    icon: IconLock,
  },
]
</script>

<template>
  <section class="capability-grid">
    <article v-for="group in groups" :key="group.title" class="capability-item">
      <div class="item-icon-wrapper">
        <component :is="group.icon" class="item-icon" />
      </div>
      <div class="item-text">
        <h3>{{ group.title }}</h3>
        <p class="item-lead">{{ group.lead }}</p>
        <p class="item-desc">{{ group.desc }}</p>
      </div>
    </article>
  </section>
</template>

<style scoped>
.capability-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.capability-item {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 20px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  transition: all 0.2s ease-in-out;
}

.capability-item:hover {
  border-color: var(--color-primary-light-3, var(--color-primary, #07c160));
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.02);
}

.item-icon-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--color-primary, #07c160);
  flex-shrink: 0;
}

.item-icon {
  font-size: 20px;
}

.item-text {
  flex: 1;
  min-width: 0;
}

.capability-item h3 {
  margin: 0 0 6px;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 600;
}

.item-lead {
  margin: 0 0 8px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 550;
  line-height: 1.45;
}

.item-desc {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.55;
}

@media (max-width: 720px) {
  .capability-grid {
    grid-template-columns: 1fr;
  }
}
</style>
