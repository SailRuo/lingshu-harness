function normalizeBase(baseUrl: string) {
  return (baseUrl || "").trim().replace(/\/+$/, "");
}

export interface ProviderModelsResult {
  ok: boolean;
  models: string[];
  status?: number;
  detail?: string;
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return "连接失败";
  if (error.name === "TimeoutError" || /timeout|aborted/i.test(error.message)) {
    return "连接超时";
  }
  return error.message || "连接失败";
}

export async function fetchProviderModels(input: {
  protocol: string;
  baseUrl: string;
  apiKey?: string;
}): Promise<ProviderModelsResult> {
  const protocol = String(input.protocol || "").toLowerCase();
  const base = normalizeBase(input.baseUrl);
  if (!base) return { ok: false, models: [], detail: "请填写服务地址" };
  if (["onnx", "local-onnx", "local_onnx"].includes(protocol)) {
    return { ok: false, models: [], detail: "该协议不支持模型列表接口" };
  }
  if (protocol === "volcengine") {
    return { ok: false, models: [], detail: "该服务商不支持模型列表接口" };
  }
  try {
    if (protocol === "ollama") {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        return { ok: false, models: [], status: res.status, detail: `接口返回 HTTP ${res.status}` };
      }
      const data: any = await res.json();
      return {
        ok: true,
        models: (data.models || []).map((model: any) => model.name).filter(Boolean),
      };
    }
    const modelsUrl =
      base.endsWith("/v1") || base.endsWith("/v3") || base.endsWith("/v4")
        ? `${base}/models`
        : `${base}/v1/models`;
    const headers: Record<string, string> = {};
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
    const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      let detail = `接口返回 HTTP ${res.status}`;
      try {
        const body = (await res.text()).trim();
        if (body) detail = `${detail}：${body.slice(0, 200)}`;
      } catch {
        // keep status-only detail
      }
      return { ok: false, models: [], status: res.status, detail };
    }
    const data: any = await res.json();
    return {
      ok: true,
      models: (data.data || []).map((model: any) => model.id).filter(Boolean),
      status: res.status,
    };
  } catch (error) {
    return { ok: false, models: [], detail: errorDetail(error) };
  }
}

export async function fetchProviderModelNames(input: {
  protocol: string;
  baseUrl: string;
  apiKey?: string;
}): Promise<string[]> {
  return (await fetchProviderModels(input)).models;
}
