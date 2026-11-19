import { getFullUrl } from '../utils/apiConfig';

export type AsrInstallPhase = 'idle' | 'downloading' | 'installing' | 'done' | 'failed';

export interface AsrModelStatus {
  phase: AsrInstallPhase;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
  installed: boolean;
  model: string;
  installDir: string;
  sizeBytes: number;
  downloadUrl: string;
  /** Bytes kept from an interrupted attempt that the next download will resume. */
  resumableBytes?: number;
  runtimeReady: boolean;
  runtimeMessage: string;
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.detail === 'string') return data.detail;
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    /* not json */
  }
  return `请求失败 (${res.status})`;
}

export async function fetchAsrModelStatus(): Promise<AsrModelStatus> {
  const res = await fetch(getFullUrl('/api/v1/asr/model/status'));
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as AsrModelStatus;
}

export async function startAsrModelDownload(url?: string): Promise<AsrModelStatus> {
  const res = await fetch(getFullUrl('/api/v1/asr/model/download'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(url ? { url } : {}),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as AsrModelStatus;
}

export async function cancelAsrModelDownload(): Promise<AsrModelStatus> {
  const res = await fetch(getFullUrl('/api/v1/asr/model/cancel'), { method: 'POST' });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as AsrModelStatus;
}

export async function deleteAsrModel(): Promise<AsrModelStatus> {
  const res = await fetch(getFullUrl('/api/v1/asr/model'), { method: 'DELETE' });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as AsrModelStatus;
}

/**
 * Upload a model zip as a raw application/zip body. XHR (not fetch) so the
 * settings page can show upload progress for the ~226MB package.
 */
export function importAsrModelZip(
  file: File,
  onUploadProgress?: (loaded: number, total: number) => void,
): Promise<AsrModelStatus> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', getFullUrl('/api/v1/asr/model/import'));
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.responseType = 'text';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onUploadProgress?.(event.loaded, event.total);
    };
    xhr.onerror = () => reject(new Error('上传失败，请检查后端连接'));
    xhr.onload = () => {
      let data: any = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        onUploadProgress?.(file.size, file.size);
        resolve(data as AsrModelStatus);
        return;
      }
      const detail = data?.detail || data?.error || `导入失败 (${xhr.status})`;
      reject(new Error(String(detail)));
    };
    xhr.send(file);
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
