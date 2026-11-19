<script setup lang="ts">
/**
 * 统一侧栏抽屉。传 popupContainer 时只盖住该容器（如记忆页 #memory-page-root），不遮全窗。
 */
const visible = defineModel<boolean>('visible', { required: true });

withDefaults(
  defineProps<{
    title: string;
    width?: number;
    /** CSS 选择器，抽屉与遮罩挂载到此容器内 */
    popupContainer?: string;
    mask?: boolean;
  }>(),
  {
    width: 400,
    popupContainer: undefined,
    mask: true,
  },
);

const emit = defineEmits<{
  cancel: [];
}>();

function handleCancel() {
  emit('cancel');
  visible.value = false;
}
</script>

<template>
  <a-drawer
    v-model:visible="visible"
    :title="title"
    :width="width"
    :footer="false"
    :mask="mask"
    :popup-container="popupContainer"
    unmount-on-close
    drawer-class="app-drawer"
    @cancel="handleCancel"
  >
    <div class="app-drawer-body">
      <slot />
    </div>
  </a-drawer>
</template>
