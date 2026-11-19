import { ref } from 'vue';
import { Message } from '@arco-design/web-vue';
import { fetchAsrModelStatus, type AsrModelStatus } from './asrModelApi';

/**
 * 全局 ASR 模型状态。
 *
 * 下载/安装在 Node 后端里跑，用户可能早就离开设置页了，所以轮询和完成提示
 * 都放在这个模块级单例里：MainLayout 挂载时启动一次，侧边栏和设置页共用
 * 同一份状态，不会重复轮询或重复弹提示。
 */
export const asrModelState = ref<AsrModelStatus | null>(null);
/** Smoothed download speed in bytes/second while downloading. */
export const asrDownloadSpeed = ref(0);

const POLL_INTERVAL_MS = 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let previousPhase: AsrModelStatus['phase'] | null = null;
let lastSample = { at: 0, bytes: 0 };
let started = false;

export function isAsrModelBusy(status: AsrModelStatus | null): boolean {
  return status?.phase === 'downloading' || status?.phase === 'installing';
}

export function initAsrModelWatcher(): void {
  if (started) return;
  started = true;
  void refreshAsrModelStatus(true);
}

export async function refreshAsrModelStatus(silent = true): Promise<AsrModelStatus | null> {
  try {
    const next = await fetchAsrModelStatus();
    applyAsrModelStatus(next);
    return next;
  } catch (error) {
    if (!silent) {
      Message.error(error instanceof Error ? error.message : '读取语音识别模型状态失败');
    }
    stopPolling();
    return null;
  }
}

/** Feed a status returned by an action endpoint so polling starts/stops immediately. */
export function applyAsrModelStatus(next: AsrModelStatus): void {
  const previous = previousPhase;
  previousPhase = next.phase;
  asrModelState.value = next;
  updateSpeedSample(next);

  if (isAsrModelBusy(next)) {
    schedulePoll();
  } else {
    stopPolling();
  }

  // Only announce a transition we actually observed. An import resolves directly
  // to `done`; the settings page shows its own success message for that path.
  if (previous === 'downloading' || previous === 'installing') {
    if (next.phase === 'done') {
      Message.success({ content: '语音识别模型下载完成，可以用了', duration: 5000 });
    } else if (next.phase === 'failed') {
      Message.error(next.error || '语音识别模型安装失败');
    }
  }
}

function stopPolling(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
}

function updateSpeedSample(status: AsrModelStatus): void {
  if (status.phase !== 'downloading') {
    lastSample = { at: 0, bytes: 0 };
    asrDownloadSpeed.value = 0;
    return;
  }
  const now = Date.now();
  if (lastSample.at > 0 && now > lastSample.at) {
    const instant = ((status.downloadedBytes - lastSample.bytes) * 1000) / (now - lastSample.at);
    if (instant >= 0) {
      asrDownloadSpeed.value = asrDownloadSpeed.value > 0
        ? asrDownloadSpeed.value * 0.5 + instant * 0.5
        : instant;
    }
  }
  lastSample = { at: now, bytes: status.downloadedBytes };
}

function schedulePoll(): void {
  if (timer != null) return;
  timer = setTimeout(() => {
    timer = null;
    void pollOnce();
  }, POLL_INTERVAL_MS);
}

async function pollOnce(): Promise<void> {
  await refreshAsrModelStatus(true);
}
