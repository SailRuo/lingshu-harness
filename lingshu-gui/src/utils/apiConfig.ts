const STORAGE_KEY = 'lingshu_backend_url';
/** Bundled Node backend listens on loopback HTTP (no TLS listener). */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8600';
const DEFAULT_PORT = '8600';

/**
 * Backend base URL resolved once at startup (Settings → General default).
 * When running inside the desktop GUI and the user hasn't explicitly saved a
 * backend URL, this is auto-filled with the machine's LAN IP so the address
 * matches what the backend advertises (activation link / HTTPS cert SAN)
 * instead of forcing the user to replace `localhost` by hand.
 */
let resolvedDefaultBaseUrl: string | null = null;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

function isPrivateLanHost(hostname: string): boolean {
  return (
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  );
}

async function detectLanBaseUrl(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const ip = (await invoke<string>('get_lan_ip')).trim();
    if (!ip || isLoopbackHost(ip)) return null;
    return normalizeBaseUrl(`https://${ip}:${DEFAULT_PORT}`);
  } catch {
    return null;
  }
}

/**
 * The desktop app talks to the bundled Node backend, which only listens on
 * loopback HTTP. Older Python builds stored https://localhost:8600 (or a LAN
 * HTTPS address); rewrite those legacy defaults so an existing saved setting
 * does not leave the GUI pointing at a TLS listener that no longer exists.
 * Custom hosts/ports are left untouched.
 */
function normalizeDesktopBackendUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    if (port !== DEFAULT_PORT) return url;
    if (isLoopbackHost(parsed.hostname) || isPrivateLanHost(parsed.hostname)) {
      return `http://127.0.0.1:${DEFAULT_PORT}`;
    }
  } catch {
    // keep original
  }
  return url;
}

/**
 * Resolve the default backend base URL once during app bootstrap.
 * Must run before any synchronous `getApiBaseUrl()` caller (e.g. license
 * refresh). Respects an explicit saved URL / env override and only falls back
 * to LAN-IP auto-detection when neither is present.
 */
export async function initApiConfig(): Promise<void> {
  // 桌面端后端由 Tauri 随应用启动，地址和端口是确定的，不再读取用户手填的地址。
  // 开发脚本通过 VITE_API_BASE_URL 注入实际端口（8600 被占用时会顺延）。
  if (isTauriRuntime()) {
    const fromEnv = (import.meta.env.VITE_API_BASE_URL || '').trim();
    if (fromEnv) {
      resolvedDefaultBaseUrl = normalizeDesktopBackendUrl(normalizeBaseUrl(fromEnv));
      return;
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
    resolvedDefaultBaseUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
    return;
  }
  const stored = readStoredUrl();
  if (stored) return;
  if (migrateFromEnv()) return;
  const detected = await detectLanBaseUrl();
  if (detected) {
    resolvedDefaultBaseUrl = detected;
  }
}

function normalizeBaseUrl(url: string): string {
  const raw = url.trim().replace(/\/+$/, '');
  if (!raw) return '';

  // 未写协议时按 http 补全：Node 后端没有 TLS 监听；远程 HTTPS 请显式写 https://
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname) return '';
    if (!parsed.port && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      parsed.port = DEFAULT_PORT;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return withProtocol;
  }
}

function readStoredUrl(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? normalizeBaseUrl(stored) : null;
  } catch {
    return null;
  }
}

function migrateFromEnv(): string | null {
  const fromEnv = (import.meta.env.VITE_API_BASE_URL || '').trim();
  if (!fromEnv) return null;
  const normalized = normalizeBaseUrl(fromEnv);
  try {
    localStorage.setItem(STORAGE_KEY, normalized);
  } catch {
    // ignore storage errors during migration
  }
  return normalized;
}

/** Backend HTTP base URL configured at runtime (Settings → General). */
export function getApiBaseUrl(): string {
  return readStoredUrl() ?? migrateFromEnv() ?? resolvedDefaultBaseUrl ?? DEFAULT_BASE_URL;
}

export function setApiBaseUrl(url: string): void {
  const normalized = normalizeBaseUrl(url);
  if (!normalized) {
    throw new Error('Backend URL cannot be empty');
  }
  localStorage.setItem(STORAGE_KEY, normalized);
}

export function getFullUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

export function getVoiceDuplexWsUrl(): string {
  const url = new URL('/api/v1/chat/voice-duplex', getApiBaseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** @deprecated Use getThreadDuplexWsUrl instead */
export function getSessionDuplexWsUrl(): string {
  return getThreadDuplexWsUrl();
}

export function getThreadDuplexWsUrl(): string {
  const url = new URL('/api/v1/chat/thread-duplex', getApiBaseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export async function testBackendConnection(baseUrl?: string): Promise<{ ok: boolean; message: string }> {
  const target = normalizeBaseUrl(baseUrl ?? getApiBaseUrl());
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${target}/health`, { signal: controller.signal });
    if (res.ok) return { ok: true, message: '连接成功' };
    return { ok: false, message: `服务返回 ${res.status}` };
  } catch (err) {
    let message = err instanceof Error && err.name === 'AbortError'
      ? '连接超时'
      : err instanceof Error
        ? err.message
        : '无法连接到后端';
    try {
      const parsed = new URL(target);
      const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
      if (parsed.protocol === 'https:' && !isLocalhost && /failed to fetch/i.test(message)) {
        const httpProbe = new URL(target);
        httpProbe.protocol = 'http:';
        const probeController = new AbortController();
        const probeTimeout = window.setTimeout(() => probeController.abort(), 2500);
        try {
          const probeRes = await fetch(`${httpProbe.toString().replace(/\/+$/, '')}/health`, {
            signal: probeController.signal,
          });
          if (probeRes.ok) {
            message = '连接失败：后端当前以 HTTP 运行，但地址配置为 HTTPS。请重启后端并确认已加载证书，或临时改用 http:// 地址。';
          } else {
            message = '连接失败：无法访问后端 HTTPS。若证书已安装，请确认后端已以 HTTPS 启动。';
          }
        } catch {
          message = '连接失败：无法访问后端 HTTPS。若证书已安装，请确认后端已以 HTTPS 启动。';
        } finally {
          window.clearTimeout(probeTimeout);
        }
      }
    } catch {
      // keep the original fetch error
    }
    return { ok: false, message };
  } finally {
    window.clearTimeout(timeout);
  }
}
