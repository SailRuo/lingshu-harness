<script setup lang="ts">
defineProps<{
  version: string
}>()
</script>

<template>
  <section class="about-product-panel">
    <div class="product-brand">
      <div class="product-mark">
        <img src="/logo.png" class="about-logo" alt="灵枢" />
        <div class="product-info">
          <p class="product-kicker">本地优先的情感陪伴智能体</p>
          <h2 class="product-name">灵枢 · LingShu AI</h2>
          <p class="app-version">{{ version }}</p>
        </div>
      </div>
      <div class="promise-strip">
        <span>连续见证</span>
        <span>本地记忆</span>
        <span>一起变化</span>
      </div>
    </div>

    <div class="product-copy">
      <h3>不是陪你今天聊天，是和你一起长出一段关系。</h3>
      <p>
        灵枢运行在你自己的设备上。她会记住你在意的人、反复绕不开的事、说过的约定，
        以及你们一起走过后留下的痕迹。
      </p>
    </div>
  </section>
</template>

<style scoped>
.about-product-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 24px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 12px;
}

.product-brand {
  flex: 0 0 260px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 16px;
}

.product-mark {
  display: flex;
  align-items: center;
  gap: 14px;
}

.about-logo {
  width: 68px;
  height: 68px;
  border-radius: 16px;
  box-shadow: 0 8px 24px rgba(7, 193, 96, 0.14);
  flex-shrink: 0;
}

.product-info {
  display: flex;
  flex-direction: column;
}

.product-kicker {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 500;
}

.product-name {
  margin: 2px 0;
  color: var(--text-primary);
  font-size: 20px;
  font-weight: 650;
  line-height: 1.2;
}

.app-version {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 12px;
}

.product-copy {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
  border-left: 1px solid var(--border-color);
  padding-left: 24px;
}

.product-copy h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 22px;
  line-height: 1.35;
  font-weight: 650;
  text-wrap: balance;
}

.product-copy p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13.5px;
  line-height: 1.6;
}

.promise-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.promise-strip span {
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 11px;
}

@media (max-width: 768px) {
  .about-product-panel {
    flex-direction: column;
    align-items: stretch;
    gap: 24px;
    padding: 24px;
  }
  .product-brand {
    flex: none;
  }
  .product-copy {
    border-left: none;
    padding-left: 0;
    border-top: 1px solid var(--border-color);
    padding-top: 20px;
  }
}
</style>
