export type VoiceCallWindowState = {
  avatar?: string;
  name?: string;
  transcript?: string;
  connecting?: boolean;
  active?: boolean;
  assistantSpeaking?: boolean;
  level?: number;
  channel?: string;
  status?: string;
  isMuted?: boolean;
  isScreenSharing?: boolean;
  speechActive?: boolean;
  connectionHint?: string;
  isThinking?: boolean;
  meta?: {
    source?: string;
    transport?: string;
    rtf?: number;
  };
};

export type OsDockCapability = {
  is_windows: boolean;
  is_windows_10: boolean;
  is_windows_11: boolean;
  build_number: number;
  supports_deskband: boolean;
  recommendation: 'windows_10_deskband' | 'topmost_island';
};

export const DESKBAND_ENABLED_STORAGE_KEY = 'lingshu.deskband.enabled';

export async function getOsDockCapability(): Promise<OsDockCapability | null> {
  if (!(await isTauriRuntime())) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<OsDockCapability>('get_os_dock_capability');
  } catch (err) {
    console.warn('[VoiceCallWindow] Failed to get OS dock capability:', err);
    return null;
  }
}

export async function registerDeskBand(): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<string>('register_deskband');
}

export async function unregisterDeskBand(): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return await invoke<string>('unregister_deskband');
}

const WINDOW_LABEL = 'voice-call';
export const VOICE_CALL_STATE_STORAGE_KEY = 'lingshu.voice_call_window.state';

export const ISLAND_WIDTH = 290;
export const ISLAND_HEIGHT = 40;
export const TOP_OFFSET = 16;
export const SCREEN_MARGIN = 8;
export const VOICE_CALL_POS_STORAGE_KEY = 'lingshu.voice_call_window.pos';

export async function isTauriRuntime(): Promise<boolean> {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 将窗口坐标严格限制在屏幕可见区域内部（防拖出屏幕外）
 */
export async function clampPositionToBounds(
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  try {
    const { primaryMonitor, currentMonitor } = await import('@tauri-apps/api/window');
    const mon = (await currentMonitor()) || (await primaryMonitor());
    if (mon) {
      const factor = mon.scaleFactor || 1;
      const monX = Math.round(mon.position.x / factor);
      const monY = Math.round(mon.position.y / factor);
      const screenWidth = mon.size.width / factor;
      const screenHeight = mon.size.height / factor;

      const minX = monX + SCREEN_MARGIN;
      const maxX = monX + Math.max(SCREEN_MARGIN, screenWidth - ISLAND_WIDTH - SCREEN_MARGIN);
      const minY = monY + SCREEN_MARGIN;
      const maxY = monY + Math.max(SCREEN_MARGIN, screenHeight - ISLAND_HEIGHT);

      const clampedX = Math.round(Math.min(Math.max(minX, x), maxX));
      const clampedY = Math.round(Math.min(Math.max(minY, y), maxY));
      return { x: clampedX, y: clampedY };
    }
  } catch (e) {
    console.warn('[VoiceCallWindow] Failed to clamp position:', e);
  }
  const screenWidth = typeof window !== 'undefined' && window.screen ? window.screen.width : 1920;
  const screenHeight = typeof window !== 'undefined' && window.screen ? window.screen.height : 1080;
  const maxX = Math.max(SCREEN_MARGIN, screenWidth - ISLAND_WIDTH - SCREEN_MARGIN);
  const maxY = Math.max(SCREEN_MARGIN, screenHeight - ISLAND_HEIGHT);
  return {
    x: Math.round(Math.min(Math.max(SCREEN_MARGIN, x), maxX)),
    y: Math.round(Math.min(Math.max(SCREEN_MARGIN, y), maxY)),
  };
}

export function saveIslandPosition(pos: { x: number; y: number; dockMode?: 'island' | 'taskbar' }): void {
  try {
    localStorage.setItem(VOICE_CALL_POS_STORAGE_KEY, JSON.stringify(pos));
  } catch {}
}

export async function calculateIslandPosition(): Promise<{ x: number; y: number }> {
  try {
    const raw = localStorage.getItem(VOICE_CALL_POS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { x?: number; y?: number; dockMode?: string };
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        return await clampPositionToBounds(parsed.x, parsed.y);
      }
    }
  } catch {}

  try {
    const { primaryMonitor, currentMonitor } = await import('@tauri-apps/api/window');
    const mon = (await primaryMonitor()) || (await currentMonitor());
    if (mon) {
      const screenWidth = mon.size.width / mon.scaleFactor;
      const x = Math.round((screenWidth - ISLAND_WIDTH) / 2);
      return await clampPositionToBounds(x, TOP_OFFSET);
    }
  } catch (e) {
    console.warn('[VoiceCallWindow] Failed to get monitor size:', e);
  }
  const screenWidth = typeof window !== 'undefined' && window.screen ? window.screen.width : 1920;
  return await clampPositionToBounds(Math.round((screenWidth - ISLAND_WIDTH) / 2), TOP_OFFSET);
}

let isWindowCreating = false;

/**
 * 在屏幕顶部中央打开/显示置顶悬浮岛窗口
 */
export async function showVoiceCallIslandWindow(initialState?: VoiceCallWindowState): Promise<void> {
  if (!(await isTauriRuntime())) return;

  if (initialState) {
    try {
      localStorage.setItem(VOICE_CALL_STATE_STORAGE_KEY, JSON.stringify(initialState));
    } catch {}
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(WINDOW_LABEL);
    if (existing) {
      const isVis = await existing.isVisible().catch(() => false);
      if (!isVis) {
        const { LogicalPosition } = await import('@tauri-apps/api/dpi');
        const pos = await calculateIslandPosition();
        await existing.setPosition(new LogicalPosition(pos.x, pos.y));
        await existing.setAlwaysOnTop(true);
        await existing.show();
      }
      if (initialState) {
        await syncVoiceCallWindow(initialState);
      }
      return;
    }

    if (isWindowCreating) return;
    isWindowCreating = true;
    const pos = await calculateIslandPosition();

    const child = new WebviewWindow(WINDOW_LABEL, {
      url: '/#/voice-call',
      title: '灵动通话岛',
      width: ISLAND_WIDTH,
      height: ISLAND_HEIGHT,
      x: pos.x,
      y: pos.y,
      resizable: false,
      decorations: false,
      transparent: true,
      backgroundColor: [0, 0, 0, 0],
      alwaysOnTop: true,
      skipTaskbar: true,
      shadow: false,
      visible: false,
    });

    await new Promise<void>((resolve, reject) => {
      child.once('tauri://created', async () => {
        isWindowCreating = false;
        resolve();
        try {
          // Belt-and-braces for macOS: keep both the window and webview layer
          // transparent even if the creation option is ignored by the platform.
          await child.setBackgroundColor([0, 0, 0, 0]);
        } catch {}
        try {
          if (initialState) {
            await syncVoiceCallWindow(initialState);
          }
          // 等待 DOM/CSS 解析完成，避免 WebView2 出现白色初始帧
          setTimeout(async () => {
            try {
              await child.setAlwaysOnTop(true);
              await child.show();
              // show 之后再次强制置顶，防止系统重置
              setTimeout(async () => {
                try { await child.setAlwaysOnTop(true); } catch {}
              }, 200);
            } catch {}
          }, 80);
        } catch {}
      });
      child.once('tauri://error', (event) => {
        isWindowCreating = false;
        reject(event);
      });
    });
  } catch (error) {
    isWindowCreating = false;
    console.error('[VoiceCallWindow] Failed to open island window:', error);
  }
}

/**
 * 隐藏悬浮岛窗口
 */
export async function hideVoiceCallIslandWindow(): Promise<void> {
  if (!(await isTauriRuntime())) return;
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(WINDOW_LABEL);
    if (existing) {
      await existing.hide();
    }
  } catch (error) {
    console.warn('[VoiceCallWindow] Failed to hide island window:', error);
  }
}

/**
 * 关闭并销毁悬浮岛窗口
 */
export async function closeVoiceCallWindow(): Promise<void> {
  if (!(await isTauriRuntime())) return;
  try {
    localStorage.removeItem(VOICE_CALL_STATE_STORAGE_KEY);
  } catch {}

  try {
    const { emit, emitTo } = await import('@tauri-apps/api/event');
    const inactiveState: VoiceCallWindowState = {
      active: false,
      connecting: false,
      assistantSpeaking: false,
      level: 0,
      isMuted: false,
      isScreenSharing: false,
      speechActive: false,
    };
    await Promise.allSettled([
      emitTo(WINDOW_LABEL, 'voice-call:state', inactiveState),
      emit('voice-call:state', inactiveState),
    ]);
  } catch {}

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('close_voice_call_window');
  } catch (err) {
    console.warn('[VoiceCallWindow] Rust close command fallback:', err);
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const existing = await WebviewWindow.getByLabel(WINDOW_LABEL);
    if (existing) {
      try {
        await existing.hide();
      } catch {}
      try {
        await (existing as any).destroy?.();
      } catch {}
      await existing.close();
    }
  } catch (error) {
    console.warn('[VoiceCallWindow] Failed to close island window:', error);
  }
}

let lastSyncTime = 0;
let pendingSyncState: VoiceCallWindowState | null = null;
let syncTimer: number | null = null;

async function doEmitState(state: VoiceCallWindowState): Promise<void> {
  try {
    const [{ emit, emitTo }, { WebviewWindow }] = await Promise.all([
      import('@tauri-apps/api/event'),
      import('@tauri-apps/api/webviewWindow'),
    ]);
    const existing = await WebviewWindow.getByLabel(WINDOW_LABEL);
    if (!existing) return;
    await Promise.allSettled([
      emitTo(WINDOW_LABEL, 'voice-call:state', state),
      emit('voice-call:state', state),
    ]);
  } catch (error) {
    console.warn('[VoiceCallWindow] Failed to emit state to island window:', error);
  }
}

/**
 * 同步状态给悬浮岛窗口（带 50ms 节流，避免高频 IPC 引起重绘卡顿）
 */
export async function syncVoiceCallWindow(state: VoiceCallWindowState): Promise<void> {
  if (!(await isTauriRuntime())) return;
  try {
    localStorage.setItem(VOICE_CALL_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('[VoiceCallWindow] Failed to persist window state:', error);
  }

  pendingSyncState = state;
  const now = Date.now();
  if (now - lastSyncTime < 50) {
    if (syncTimer === null) {
      syncTimer = window.setTimeout(() => {
        syncTimer = null;
        if (pendingSyncState) {
          void doEmitState(pendingSyncState);
        }
      }, 50);
    }
    return;
  }
  lastSyncTime = now;
  await doEmitState(state);
}

/**
 * 唤醒并聚焦主窗口
 */
export async function focusMainWindow(): Promise<void> {
  if (!(await isTauriRuntime())) return;
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const main = await WebviewWindow.getByLabel('main');
    if (main) {
      if (await main.isMinimized()) {
        await main.unminimize();
      }
      await main.show();
      await main.setFocus();
    }
  } catch (error) {
    console.warn('[VoiceCallWindow] Failed to focus main window:', error);
  }
}

/**
 * 监听来自悬浮岛的交互事件
 */
export async function listenVoiceCallEvents(callbacks: {
  onHangup?: () => void | Promise<void>;
  onToggleMute?: (payload?: any) => void | Promise<void>;
  onToggleScreenShare?: (payload?: any) => void | Promise<void>;
  onInterrupt?: () => void | Promise<void>;
  onFocusMain?: () => void | Promise<void>;
  onReady?: () => void | Promise<void>;
}): Promise<() => void> {
  if (!(await isTauriRuntime())) return () => {};
  const { listen } = await import('@tauri-apps/api/event');

  const unlisteners: Array<() => void> = [];

  if (callbacks.onReady) {
    const un = await listen('voice-call:ready', async () => {
      await callbacks.onReady?.();
    });
    unlisteners.push(un);
  }
  if (callbacks.onHangup) {
    const un = await listen('voice-call:hangup', async () => {
      await callbacks.onHangup?.();
    });
    unlisteners.push(un);
  }
  if (callbacks.onToggleMute) {
    const un = await listen<any>('voice-call:toggle-mute', async (event) => {
      console.log('[VoiceCallWindow] RECEIVED voice-call:toggle-mute, payload:', event?.payload, 'source windowLabel:', (event as any)?.windowLabel);
      await callbacks.onToggleMute?.(event?.payload);
    });
    unlisteners.push(un);
  }
  if (callbacks.onToggleScreenShare) {
    const un = await listen<any>('voice-call:toggle-screen-share', async (event) => {
      console.log('[VoiceCallWindow] RECEIVED voice-call:toggle-screen-share, payload:', event?.payload, 'source windowLabel:', (event as any)?.windowLabel);
      await callbacks.onToggleScreenShare?.(event?.payload);
    });
    unlisteners.push(un);
  }
  if (callbacks.onInterrupt) {
    const un = await listen('voice-call:interrupt', async () => {
      await callbacks.onInterrupt?.();
    });
    unlisteners.push(un);
  }
  if (callbacks.onFocusMain) {
    const un = await listen('voice-call:focus-main', async () => {
      await callbacks.onFocusMain?.();
    });
    unlisteners.push(un);
  }

  return () => {
    unlisteners.forEach((u) => u());
  };
}

// 保持旧接口兼容
export const openVoiceCallWindow = showVoiceCallIslandWindow;
export async function listenVoiceCallHangup(handler: () => void | Promise<void>): Promise<() => void> {
  return listenVoiceCallEvents({ onHangup: handler });
}
