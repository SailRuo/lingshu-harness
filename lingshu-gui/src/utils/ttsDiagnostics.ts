import { getFullUrl } from "./apiConfig";

export function reportTtsDiagnostic(
  stage: string,
  message: string,
  data: Record<string, unknown> = {},
): void {
  try {
    const payload = JSON.stringify({
      stage,
      message,
      level: 30,
      data: {
        ...data,
        visibility: typeof document !== "undefined" ? document.visibilityState : undefined,
        ua: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        at: Date.now(),
      },
    });
    void fetch(getFullUrl("/api/v1/client-logs"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // diagnostics must never break playback
  }
}
