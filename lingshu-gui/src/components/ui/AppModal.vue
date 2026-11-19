<script setup lang="ts">
import { computed, useSlots } from 'vue';

/**
 * 统一模态框：showFooter=true 使用 Arco 底栏；false 仅内容区（可 #footer 自定义）。
 */
const visible = defineModel<boolean>('visible', { required: true });
const slots = useSlots();

const props = withDefaults(
  defineProps<{
    title: string;
    width?: number | string;
    okText?: string;
    cancelText?: string;
    okLoading?: boolean;
    okStatus?: 'primary' | 'danger' | 'warning';
    /** 是否显示默认确定/取消底栏 */
    showFooter?: boolean;
    maskClosable?: boolean;
  }>(),
  {
    width: 520,
    okText: '确定',
    cancelText: '取消',
    okLoading: false,
    okStatus: 'primary',
    showFooter: true,
    maskClosable: false,
  },
);

const okButtonProps = computed(() => (
  props.okStatus === 'primary' ? {} : { status: props.okStatus }
));

/** false 才彻底隐藏底栏；自定义 #footer 时必须保留 footer 区域 */
const footerVisible = computed(() => props.showFooter || Boolean(slots.footer));

const emit = defineEmits<{
  ok: [];
  cancel: [];
}>();

function handleOk() {
  emit('ok');
}

function handleCancel() {
  emit('cancel');
  visible.value = false;
}
</script>

<template>
  <a-modal
    v-model:visible="visible"
    :title="title"
    :width="width"
    :footer="footerVisible"
    :mask-closable="maskClosable"
    :ok-text="okText"
    :cancel-text="cancelText"
    :ok-loading="okLoading"
    :ok-button-props="okButtonProps"
    modal-class="app-modal"
    @ok="handleOk"
    @cancel="handleCancel"
  >
    <slot />
    <template v-if="!showFooter && $slots.footer" #footer>
      <slot name="footer" />
    </template>
  </a-modal>
</template>
