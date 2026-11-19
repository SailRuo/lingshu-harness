import { getFullUrl } from './apiConfig';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function selectFolderPath(options?: {
  title?: string;
  defaultPath?: string;
}): Promise<string | null> {
  if (isTauriRuntime()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      directory: true,
      multiple: false,
      title: options?.title ?? '选择文件夹',
      defaultPath: options?.defaultPath,
    });
    return typeof selected === 'string' ? selected : null;
  }

  try {
    const res = await fetch(getFullUrl('/api/settings/choose-directory'), { method: 'POST' });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.directory === 'string' ? data.directory : null;
  } catch {
    return null;
  }
}
