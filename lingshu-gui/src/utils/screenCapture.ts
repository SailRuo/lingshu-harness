import { invoke } from '@tauri-apps/api/core';

/**
 * 捕获当前屏幕截图
 * 返回 base64 格式的 JPEG 图片
 */
export async function captureScreenFrame(): Promise<string | null> {
  try {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      // Tauri 环境：使用原生 API 截图
      const dataUrl = await invoke<string>('capture_screen');
      return dataUrl;
    }

    // Web 环境：尝试使用浏览器截图 API
    if ('getDisplayMedia' in navigator.mediaDevices) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });

        const video = document.createElement('video');
        video.srcObject = stream;
        video.autoplay = true;

        await new Promise((resolve) => {
          video.onloadedmetadata = resolve;
        });

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          stream.getTracks().forEach((track) => track.stop());
          return null;
        }

        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);

        stream.getTracks().forEach((track) => track.stop());
        return dataUrl;
      } catch (error) {
        console.warn('[ScreenCapture] getDisplayMedia failed:', error);
        return null;
      }
    }

    return null;
  } catch (error) {
    console.warn('[ScreenCapture] Failed to capture screen:', error);
    return null;
  }
}