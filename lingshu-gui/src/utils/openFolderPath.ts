import { getFullUrl } from './apiConfig';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function openFolderPath(path: string): Promise<void> {
  const target = path.trim();
  if (!target) {
    throw new Error('路径为空');
  }

  if (isTauriRuntime()) {
    const { openPath } = await import('@tauri-apps/plugin-opener');
    await openPath(target);
    return;
  }

  const res = await fetch(getFullUrl('/api/system/open-path'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: target }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(String(data?.detail || '打开目录失败'));
  }
}
