import { useSettingsStore } from '../stores/settings';

export type AsrProviderValue = 'local' | 'xiaomi' | 'aliyun' | 'apple';

/**
 * 当前选择的识别方式。composable 模块在应用装配期就会被 import，
 * 那时 Pinia 还未激活，因此吞掉异常退回本地模型；真正调用点都在
 * 组件事件回调里，Pinia 已就绪。
 */
export function getActiveAsrProvider(): AsrProviderValue {
  try {
    return useSettingsStore().asr.provider;
  } catch {
    return 'local';
  }
}

export function asrLanguageOption(): 'auto' | 'zh' | 'en' {
  try {
    return useSettingsStore().asr.language;
  } catch {
    return 'auto';
  }
}
