import { ref } from 'vue';
import { Message } from '@arco-design/web-vue';

export type AppConfirmOkStatus = 'primary' | 'danger' | 'warning';

export interface AppConfirmOptions {
  title: string;
  content: string;
  okText?: string;
  cancelText?: string;
  okStatus?: AppConfirmOkStatus;
  onOk: () => void | Promise<void>;
}

export function useAppConfirm() {
  const visible = ref(false);
  const title = ref('');
  const content = ref('');
  const okText = ref('确定');
  const cancelText = ref('取消');
  const okStatus = ref<AppConfirmOkStatus>('primary');
  const confirming = ref(false);

  let pendingOnOk: (() => void | Promise<void>) | null = null;

  function open(options: AppConfirmOptions) {
    title.value = options.title;
    content.value = options.content;
    okText.value = options.okText ?? '确定';
    cancelText.value = options.cancelText ?? '取消';
    okStatus.value = options.okStatus ?? 'primary';
    pendingOnOk = options.onOk;
    visible.value = true;
  }

  async function submit() {
    if (!pendingOnOk || confirming.value) return;
    confirming.value = true;
    try {
      await pendingOnOk();
      visible.value = false;
      pendingOnOk = null;
    } catch (error) {
      Message.error((error as Error).message || '操作失败');
    } finally {
      confirming.value = false;
    }
  }

  function cancel() {
    visible.value = false;
    pendingOnOk = null;
  }

  return {
    visible,
    title,
    content,
    okText,
    cancelText,
    okStatus,
    confirming,
    open,
    submit,
    cancel,
  };
}
