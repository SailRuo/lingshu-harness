/**
 * 米家（MIoT）云集成：扫码登录、设备列表与属性读写。
 * 基于 Do1e/mijia-api（GPL-3.0，https://github.com/Do1e/mijia-api）移植为 TypeScript，并有增删改动。
 * 依 GPL-3.0 第 4/5 条保留原项目版权声明（Copyright (C) Do1e/mijia-api contributors）。
 * 本集成使用小米非官方接口，可能违反小米服务条款，账号相关风险由使用者自行承担。
 */
import crypto from "node:crypto";
import QRCode from "qrcode";
import { getDb } from "../db/sqlite.js";
import { MIJIA_TOOL_NAMES } from "../tools/mijiaTools.js";
import { decryptSecret, encryptSecret } from "./secretStore.js";
import { getSecuritySettings, saveSecuritySettings } from "./settingsService.js";

const AUTH_ROW = "MIJIA_AUTH";
const API_BASE = "https://api.mijia.tech/app";
const SERVICE_LOGIN =
  "https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=mijia&_locale=zh_CN";
const LOGIN_URL = "https://account.xiaomi.com/longPolling/loginUrl";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type Auth = Record<string, string | number>;

interface HttpResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

interface DeviceProperty {
  name: string;
  description: string;
  type: string;
  rw: string;
  range: unknown;
  value_list: unknown;
  method: { siid: number; piid: number };
}

interface DeviceAction {
  name: string;
  description: string;
  method: { siid: number; aiid: number };
}

interface DeviceSpec {
  properties: DeviceProperty[];
  actions: DeviceAction[];
}

type LoginState = "pending" | "authenticated" | "error";

interface PendingLogin {
  id: string;
  pollUrl: string;
  auth: Auth;
  state: LoginState;
  error?: string;
  cancelled?: boolean;
  timer?: NodeJS.Timeout;
}

const pendingLogins = new Map<string, PendingLogin>();

export function isMijiaTool(name: string): boolean {
  return (MIJIA_TOOL_NAMES as readonly string[]).includes(name);
}

/* ---------------------------- credential storage ---------------------------- */

function readAuth(): Auth {
  const row = getDb()
    .prepare("SELECT value FROM settings_rows WHERE id = ?")
    .get(AUTH_ROW) as { value: string } | undefined;
  if (!row) return {};
  const plain = decryptSecret(row.value);
  if (!plain) return {};
  try {
    const parsed = JSON.parse(plain) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Auth)
      : {};
  } catch {
    return {};
  }
}

function saveAuth(value: Auth): void {
  getDb()
    .prepare(
      "INSERT INTO settings_rows (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
    )
    .run(AUTH_ROW, encryptSecret(JSON.stringify(value)));
}

function removeAuth(): void {
  getDb().prepare("DELETE FROM settings_rows WHERE id = ?").run(AUTH_ROW);
}

/* ------------------------------ crypto helpers ------------------------------ */

function randomFrom(chars: string, length: number): string {
  const bytes = crypto.randomBytes(length);
  let value = "";
  for (const byte of bytes) value += chars[byte % chars.length];
  return value;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function unb64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function digest(name: "sha1" | "sha256", bytes: Uint8Array): Uint8Array {
  return new Uint8Array(crypto.createHash(name).update(bytes).digest());
}

function rc4(key: Uint8Array, input: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) s[index] = index;
  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + s[index] + key[index % key.length]) & 255;
    const swap = s[index];
    s[index] = s[j];
    s[j] = swap;
  }
  let i = 0;
  j = 0;
  const out = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    const swap = s[i];
    s[i] = s[j];
    s[j] = swap;
    out[index] = input[index] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

function encRc4(key: string, text: string): string {
  const payload = new TextEncoder().encode(text);
  const stream = rc4(unb64(key), new Uint8Array(1024 + payload.length));
  for (let index = 0; index < payload.length; index += 1) {
    stream[1024 + index] ^= payload[index];
  }
  return b64(stream.slice(1024));
}

function decRc4(key: string, text: string): string {
  const payload = unb64(text);
  const stream = rc4(unb64(key), new Uint8Array(1024 + payload.length));
  return new TextDecoder().decode(
    stream.slice(1024).map((value, index) => value ^ payload[index]),
  );
}

async function signedNonce(ssecurity: string, nonceValue: string): Promise<string> {
  const all = new Uint8Array([...unb64(ssecurity), ...unb64(nonceValue)]);
  return b64(digest("sha256", all));
}

async function signature(
  uri: string,
  signed: string,
  params: Record<string, string>,
): Promise<string> {
  const parts = [
    "POST",
    uri,
    ...Object.entries(params).map(([key, value]) => `${key}=${value}`),
    signed,
  ];
  return b64(digest("sha1", new TextEncoder().encode(parts.join("&"))));
}

function nonce(): string {
  const bytes = crypto.randomBytes(12);
  const minutes = Math.floor(Date.now() / 60000);
  bytes[8] = (minutes >>> 24) & 255;
  bytes[9] = (minutes >>> 16) & 255;
  bytes[10] = (minutes >>> 8) & 255;
  bytes[11] = minutes & 255;
  return b64(bytes);
}

/* -------------------------------- transport -------------------------------- */

async function http(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<HttpResult> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 1_000), 130_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error("米家网络请求超时");
    }
    throw new Error(
      `米家网络请求失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const setCookies = (
    response.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.();
  if (setCookies && setCookies.length) headers["set-cookie"] = setCookies.join(", ");
  return { status: response.status, body: await response.text(), headers };
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/^&&&START&&&/, "")) as Record<string, unknown>;
}

function cookies(headers?: Record<string, string>): Auth {
  const raw = headers?.["set-cookie"] || headers?.["Set-Cookie"] || "";
  const out: Auth = {};
  for (const part of raw.split(/,(?=[^;]+=)/)) {
    const [pair] = part.split(";");
    const at = pair.indexOf("=");
    if (at > 0) out[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return out;
}

/* ------------------------------ account login ------------------------------- */

function userAgent(data: Auth): string {
  if (typeof data.ua === "string") return data.ua;
  const id1 = randomFrom("0123456789ABCDEF", 40);
  const id2 = randomFrom("0123456789ABCDEF", 32);
  const id3 = randomFrom("0123456789ABCDEF", 32);
  const id4 = randomFrom("0123456789ABCDEF", 40);
  const passO =
    typeof data.pass_o === "string" ? data.pass_o : randomFrom("0123456789abcdef", 16);
  data.pass_o = passO;
  data.ua =
    `Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM-${id1}-CN-${id3}-` +
    `${id2}-SmartHome-MI_APP_STORE-${id1}|${id4}|${passO}-64`;
  return data.ua;
}

function deviceId(data: Auth): string {
  if (typeof data.deviceId === "string") return data.deviceId;
  data.deviceId = randomFrom(
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-",
    16,
  );
  return data.deviceId;
}

function cookieHeader(data: Auth, login = false): string {
  if (login) {
    return (
      `deviceId=${deviceId(data)}; pass_o=${data.pass_o || ""}; ` +
      `passToken=${data.passToken || ""}; userId=${data.userId || ""}; ` +
      `cUserId=${data.cUserId || ""}; uLocale=zh_CN;`
    );
  }
  return (
    `cUserId=${data.cUserId || ""}; yetAnotherServiceToken=${data.serviceToken || ""}; ` +
    `serviceToken=${data.serviceToken || ""}; timezone_id=Asia/Shanghai; ` +
    "timezone=GMT+08:00; is_daylight=0; dst_offset=0; channel=MI_APP_STORE; " +
    `countryCode=CN; PassportDeviceId=${deviceId(data)}; locale=zh_CN`
  );
}

async function location(data: Auth): Promise<Record<string, string> | null> {
  const result = await http(SERVICE_LOGIN, {
    headers: {
      "User-Agent": userAgent(data),
      Cookie: cookieHeader(data, true),
      Connection: "keep-alive",
      // Keep the body in plain text; Node's fetch already decompresses gzip,
      // this mirrors the mobile client and avoids double decoding.
      "Accept-Encoding": "identity",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  if (result.status !== 200) throw new Error(`米家登录失败 (${result.status})`);
  const body = parse(result.body);
  const locationUrl = String(body.location || "");
  if (!locationUrl) throw new Error(String(body.desc || "无法获取登录地址"));
  if (Number(body.code) === 0) {
    const callback = await http(locationUrl, {
      headers: { "User-Agent": userAgent(data) },
    });
    if (callback.status === 200 && callback.body.trim() === "ok") {
      Object.assign(data, cookies(callback.headers), {
        ssecurity: String(body.ssecurity || ""),
      });
      return null;
    }
  }
  return Object.fromEntries(new URL(locationUrl).searchParams.entries());
}

export type MijiaLoginStart =
  | { status: "authenticated" }
  | {
      status: "pending";
      loginId: string;
      qrDataUrl: string;
      loginUrl: string;
    };

export async function startMijiaLogin(): Promise<MijiaLoginStart> {
  const data = readAuth();
  const locationData = await location(data);
  if (!locationData) {
    saveAuth(data);
    setMijiaEnabled(true);
    return { status: "authenticated" };
  }
  const query = new URLSearchParams({
    ...locationData,
    theme: "",
    bizDeviceType: "",
    _hasLogo: "false",
    _qrsize: "240",
    _dc: String(Date.now()),
  });
  const result = await http(`${LOGIN_URL}?${query.toString()}`, {
    headers: {
      "User-Agent": userAgent(data),
      Connection: "keep-alive",
      "Accept-Encoding": "identity",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const login = parse(result.body);
  if (result.status !== 200 || Number(login.code) !== 0) {
    throw new Error(String(login.desc || "获取米家二维码失败"));
  }
  const loginUrl = String(login.loginUrl || "").trim();
  const pollUrl = String(login.lp || "").trim();
  if (!loginUrl) throw new Error("米家未返回登录地址");
  if (!pollUrl) throw new Error("米家未返回轮询地址");
  saveAuth(data);
  const qrDataUrl = await QRCode.toDataURL(loginUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240,
    color: { dark: "#000000", light: "#ffffff" },
  });
  const pending: PendingLogin = {
    id: crypto.randomUUID(),
    pollUrl,
    auth: data,
    state: "pending",
  };
  pendingLogins.set(pending.id, pending);
  void completePendingLogin(pending);
  return {
    status: "pending",
    loginId: pending.id,
    qrDataUrl,
    loginUrl,
  };
}

async function completePendingLogin(pending: PendingLogin): Promise<void> {
  try {
    const data = pending.auth;
    const result = await http(pending.pollUrl, {
      headers: { "User-Agent": userAgent(data) },
      timeoutMs: 125_000,
    });
    const login = parse(result.body);
    if (result.status !== 200 || Number(login.code) !== 0) {
      throw new Error(String(login.desc || "米家登录超时或失败"));
    }
    if (pending.cancelled) return;
    for (const key of [
      "psecurity",
      "nonce",
      "ssecurity",
      "passToken",
      "userId",
      "cUserId",
    ]) {
      data[key] = String(login[key] || "");
    }
    const callback = await http(String(login.location || ""), {
      headers: { "User-Agent": userAgent(data) },
    });
    // A logout may land while the callback request is in flight.
    if (pending.cancelled) return;
    Object.assign(data, cookies(callback.headers), {
      expireTime: Date.now() + 30 * 86400000,
    });
    saveAuth(data);
    setMijiaEnabled(true);
    pending.state = "authenticated";
  } catch (error) {
    if (pending.cancelled) return;
    pending.state = "error";
    pending.error = error instanceof Error ? error.message : String(error);
  } finally {
    pending.timer = setTimeout(() => pendingLogins.delete(pending.id), 10 * 60_000);
    pending.timer.unref?.();
  }
}

export interface MijiaLoginState {
  status: LoginState;
  detail?: string;
}

export function getMijiaLoginState(loginId: string): MijiaLoginState {
  const pending = pendingLogins.get(loginId);
  if (!pending) {
    return {
      status: "error",
      detail: "登录会话不存在或已过期，请重新获取二维码",
    };
  }
  if (pending.state === "error") {
    return { status: "error", detail: pending.error || "米家登录失败" };
  }
  return { status: pending.state };
}

export interface MijiaStatus {
  authenticated: boolean;
  expiresAt: number | null;
}

export function mijiaStatus(): MijiaStatus {
  const data = readAuth();
  const expiresAt = Number(data.expireTime || 0);
  if (expiresAt > 0 && expiresAt <= Date.now()) {
    removeAuth();
    return { authenticated: false, expiresAt: null };
  }
  return {
    authenticated: Boolean(data.ssecurity && data.serviceToken && data.cUserId),
    expiresAt: expiresAt > 0 ? expiresAt : null,
  };
}

export function mijiaLogout(): void {
  for (const pending of pendingLogins.values()) {
    pending.cancelled = true;
    if (pending.timer) clearTimeout(pending.timer);
  }
  pendingLogins.clear();
  removeAuth();
}

export function mijiaEnabled(): boolean {
  const security = getSecuritySettings() as Record<string, unknown>;
  const enabledMap = security.nativeToolEnabled;
  if (!enabledMap || typeof enabledMap !== "object") return false;
  return Boolean((enabledMap as Record<string, unknown>).mijia);
}

export function setMijiaEnabled(enabled: boolean): void {
  const security = getSecuritySettings() as Record<string, unknown>;
  const enabledMap =
    security.nativeToolEnabled && typeof security.nativeToolEnabled === "object"
      ? (security.nativeToolEnabled as Record<string, unknown>)
      : {};
  saveSecuritySettings({
    ...security,
    nativeToolEnabled: { ...enabledMap, mijia: enabled },
  });
}

/** Validate the stored session with the same cloud API used by the tools. */
export async function mijiaVerifyLogin(): Promise<"valid" | "invalid" | "unverified"> {
  if (!mijiaStatus().authenticated) return "invalid";
  try {
    await homes();
    return "valid";
  } catch (error) {
    if (!mijiaStatus().authenticated) return "invalid";
    console.warn("[MIJIA] login verification unavailable", error);
    return "unverified";
  }
}

/* --------------------------------- cloud api -------------------------------- */

function isAuthFailure(message: string): boolean {
  return /\bauth(?:entication|orization)?(?:[\s_-]+)?error\b|(?:token|session).*(?:expired|invalid)|(?:expired|invalid).*(?:token|session)/i.test(
    message,
  );
}

async function api(uri: string, data: Record<string, unknown>): Promise<unknown> {
  const credentials = readAuth();
  if (!credentials.ssecurity) {
    throw new Error("米家未登录，请先在设置中扫码登录。");
  }
  const raw = JSON.stringify(data);
  const nonceValue = nonce();
  const signed = await signedNonce(String(credentials.ssecurity), nonceValue);
  const params: Record<string, string> = { data: raw };
  params.rc4_hash__ = await signature(uri, signed, params);
  for (const [key, value] of Object.entries(params)) {
    params[key] = encRc4(signed, value);
  }
  params.signature = await signature(uri, signed, params);
  params.ssecurity = String(credentials.ssecurity);
  params._nonce = nonceValue;
  const body = new URLSearchParams(params).toString();
  const result = await http(`${API_BASE}${uri}`, {
    method: "POST",
    headers: {
      "User-Agent": userAgent(credentials),
      Cookie: cookieHeader(credentials),
      "Content-Type": "application/x-www-form-urlencoded",
      "miot-encrypt-algorithm": "ENCRYPT-RC4",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
    },
    body,
  });
  let response: Record<string, unknown>;
  try {
    response = JSON.parse(result.body) as Record<string, unknown>;
  } catch {
    response = JSON.parse(decRc4(signed, result.body)) as Record<string, unknown>;
  }
  if (
    result.status !== 200 ||
    Number(response.code) !== 0 ||
    !("result" in response)
  ) {
    const message = String(
      response.message || response.desc || `米家 API 错误 ${response.code || result.status}`,
    );
    if (isAuthFailure(message)) {
      mijiaLogout();
      throw new Error("米家登录已失效，请重新扫码登录。");
    }
    throw new Error(message);
  }
  saveAuth(credentials);
  return response.result;
}

interface HomeRow {
  id: string | number;
  uid: string | number;
  [key: string]: unknown;
}

async function homes(): Promise<{ homelist: HomeRow[] }> {
  return (await api("/v2/homeroom/gethome_merged", {
    fg: true,
    fetch_share: true,
    fetch_share_dev: true,
    fetch_cariot: true,
    limit: 300,
    app_ver: 7,
    plat_form: 0,
  })) as { homelist: HomeRow[] };
}

async function devices(homeId?: string): Promise<Array<Record<string, unknown>>> {
  const homeList = (await homes()).homelist;
  const list = homeId
    ? homeList.filter((home) => String(home.id) === homeId)
    : homeList;
  const out: Array<Record<string, unknown>> = [];
  for (const home of list) {
    let start = "";
    do {
      const value = (await api("/home/home_device_list", {
        home_owner: Number(home.uid),
        home_id: Number(home.id),
        limit: 200,
        start_did: start,
        get_split_device: true,
        support_smart_home: true,
        get_cariot_device: true,
        get_third_device: true,
      })) as Record<string, unknown>;
      const info = (value.device_info as Array<Record<string, unknown>>) || [];
      for (const item of info) out.push({ ...item, home_id: home.id });
      start = value.has_more ? String(value.max_did || "") : "";
    } while (start);
  }
  return out;
}

async function find(name: string): Promise<Record<string, unknown>> {
  const found = (await devices()).filter((device) => String(device.name) === name);
  if (!found.length) throw new Error(`Device '${name}' not found`);
  if (found.length > 1) {
    throw new Error(`Multiple devices found with name '${name}', please be more specific`);
  }
  return found[0];
}

async function spec(model: string): Promise<DeviceSpec> {
  const result = await http(
    `https://home.miot-spec.com/spec/${encodeURIComponent(model)}`,
    { headers: { "User-Agent": BROWSER_UA } },
  );
  const match = result.body.match(
    /<script data-page="app" type="application\/json">(.*?)<\/script>/s,
  );
  if (!match) throw new Error(`无法获取设备能力: ${model}`);
  const page = JSON.parse(match[1]) as {
    props: {
      i18n?: { zh_cn?: Record<string, string> };
      tree?: {
        services?: Array<{
          iid: number;
          type: string;
          properties?: Array<{
            iid: number;
            type: string;
            description: string;
            format: string;
            access: string;
            valueRange?: unknown;
            valueList?: unknown;
          }>;
          actions?: Array<{
            iid: number;
            type: string;
            description: string;
          }>;
        }>;
      };
    };
  };
  const i18n = page.props.i18n?.zh_cn || {};
  const properties: DeviceProperty[] = [];
  const actions: DeviceAction[] = [];
  const used = new Set<string>();
  for (const service of page.props.tree?.services || []) {
    for (const prop of service.properties || []) {
      let name = prop.type;
      if (used.has(name)) name = `${service.type}-${name}`;
      used.add(name);
      const description =
        `${prop.description} / ` +
        `${i18n[`service:${String(service.iid).padStart(3, "0")}:property:${String(prop.iid).padStart(3, "0")}`] || ""}`;
      properties.push({
        name,
        description: description.replace(/ \/ $/, ""),
        type: String(prop.format)
          .replace(/^int.*/, "int")
          .replace(/^uint.*/, "uint"),
        rw: `${prop.access.includes("read") ? "r" : ""}${prop.access.includes("write") ? "w" : ""}`,
        range: prop.valueRange || null,
        value_list: prop.valueList || null,
        method: { siid: service.iid, piid: prop.iid },
      });
    }
    for (const action of service.actions || []) {
      let name = action.type;
      if (used.has(`a:${name}`)) name = `${service.type}-${name}`;
      used.add(`a:${name}`);
      const description =
        `${action.description} / ` +
        `${i18n[`service:${String(service.iid).padStart(3, "0")}:action:${String(action.iid).padStart(3, "0")}`] || ""}`;
      actions.push({
        name,
        description: description.replace(/ \/ $/, ""),
        method: { siid: service.iid, aiid: action.iid },
      });
    }
  }
  return { properties, actions };
}

function isEngineeringProperty(name: string, description?: string): boolean {
  const normalizedName = name.toLowerCase();
  const normalizedDescription = (description || "").toLowerCase();
  if (
    normalizedName.includes("parm") ||
    normalizedName.includes("param") ||
    normalizedName.includes("serial-no") ||
    normalizedName.includes("serial_no") ||
    normalizedName.endsWith("-sn") ||
    normalizedName === "version" ||
    normalizedName.endsWith("-version") ||
    normalizedName.includes("longitude") ||
    normalizedName.includes("latitude") ||
    normalizedName.includes("debug") ||
    normalizedName.includes("factory") ||
    normalizedName.includes("register") ||
    normalizedName.includes("eeprom") ||
    normalizedName === "examine"
  ) {
    return true;
  }
  return (
    normalizedDescription.includes("外机参数") ||
    normalizedDescription.includes("内机参数") ||
    normalizedDescription.includes("出厂条码") ||
    normalizedDescription.includes("序列号") ||
    normalizedDescription.includes("调试") ||
    normalizedDescription.includes("工程")
  );
}

/* --------------------------------- tool calls ------------------------------- */

export async function executeMijiaTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    if (name === "list_homes") {
      return JSON.stringify({ success: true, homes: (await homes()).homelist });
    }
    if (name === "list_devices") {
      const list = await devices(
        typeof args.home_id === "string" ? args.home_id : undefined,
      );
      return JSON.stringify({
        success: true,
        devices: list.map((device) => ({
          name: device.name,
          model: device.model,
          did: device.did,
        })),
      });
    }
    if (name === "list_scenes") {
      const output: unknown[] = [];
      for (const home of (await homes()).homelist) {
        const result = (await api(
          "/appgateway/miot/appsceneservice/AppSceneService/GetSimpleSceneList",
          {
            app_version: 12,
            get_type: 2,
            home_id: String(home.id),
            owner_uid: Number(home.uid),
          },
        )) as { manual_scene_info_list?: Array<Record<string, unknown>> };
        output.push(
          ...(result.manual_scene_info_list || []).map((scene) => ({
            ...scene,
            home_id: home.id,
          })),
        );
      }
      return JSON.stringify({ success: true, scenes: output });
    }
    if (name === "run_scene") {
      const homeId = String(args.home_id || "");
      const home = (await homes()).homelist.find(
        (item) => String(item.id) === homeId,
      );
      if (!home) throw new Error(`未找到 home_id=${homeId}`);
      await api(
        "/appgateway/miot/appsceneservice/AppSceneService/NewRunScene",
        {
          scene_id: String(args.scene_id),
          scene_type: 2,
          phone_id: "null",
          home_id: homeId,
          owner_uid: Number(home.uid),
        },
      );
      return JSON.stringify({ success: true, scene_id: args.scene_id });
    }

    const device = await find(String(args.dev_name || ""));
    const info = await spec(String(device.model));
    if (name === "list_device_capabilities") {
      return JSON.stringify({
        success: true,
        device: device.name,
        model: device.model,
        properties: info.properties.filter(
          (prop) => !isEngineeringProperty(prop.name, prop.description),
        ),
        actions: info.actions,
      });
    }
    if (name === "get_device_properties") {
      const values: Record<string, unknown> = {};
      const readable = info.properties.filter(
        (prop) =>
          prop.rw.includes("r") && !isEngineeringProperty(prop.name, prop.description),
      );
      let batchOk = false;
      try {
        const batchSize = 10;
        for (let index = 0; index < readable.length; index += batchSize) {
          const chunk = readable.slice(index, index + batchSize);
          const result = (await api("/miotspec/prop/get", {
            params: chunk.map((prop) => ({ did: device.did, ...prop.method })),
            datasource: 1,
          })) as Array<{
            siid?: number;
            piid?: number;
            code?: number;
            value?: unknown;
          }>;
          if (Array.isArray(result) && result.length > 0) {
            for (let inner = 0; inner < chunk.length; inner += 1) {
              const prop = chunk[inner];
              const item =
                result.find(
                  (entry) =>
                    entry.siid === prop.method.siid &&
                    entry.piid === prop.method.piid,
                ) ?? result[inner];
              const value = item?.value ?? null;
              if (
                typeof value === "string" &&
                value.length > 50 &&
                value.split(",").length > 5
              ) {
                continue;
              }
              values[prop.name] = value;
            }
          }
        }
        batchOk = true;
      } catch (error) {
        if (!mijiaStatus().authenticated) throw error;
        batchOk = false;
      }
      if (!batchOk) {
        for (const prop of readable) {
          try {
            const result = (await api("/miotspec/prop/get", {
              params: [{ did: device.did, ...prop.method }],
              datasource: 1,
            })) as Array<{ value?: unknown }>;
            const value = result[0]?.value ?? null;
            if (
              typeof value === "string" &&
              value.length > 50 &&
              value.split(",").length > 5
            ) {
              continue;
            }
            values[prop.name] = value;
          } catch (error) {
            if (!mijiaStatus().authenticated) throw error;
            values[prop.name] = null;
          }
        }
      }
      return JSON.stringify({
        success: true,
        device: device.name,
        properties: values,
      });
    }

    const property = info.properties.find(
      (prop) =>
        prop.name === args.prop_name ||
        prop.name.replace(/-/g, "_") === args.prop_name,
    );
    if (name === "get_device_property") {
      if (!property) throw new Error(`不支持的属性: ${args.prop_name}`);
      const result = (await api("/miotspec/prop/get", {
        params: [{ did: device.did, ...property.method }],
        datasource: 1,
      })) as Array<{ value?: unknown }>;
      return JSON.stringify({
        success: true,
        device: device.name,
        property: args.prop_name,
        value: result[0]?.value,
      });
    }
    if (name === "set_device_property") {
      if (!property) throw new Error(`不支持的属性: ${args.prop_name}`);
      let value: unknown = args.value;
      if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (
        typeof value === "string" &&
        value.trim() !== "" &&
        !Number.isNaN(Number(value))
      ) {
        value = Number(value);
      }
      const result = (await api("/miotspec/prop/set", {
        params: [{ did: device.did, ...property.method, value }],
      })) as Array<{ code?: number }>;
      return JSON.stringify({
        success: result[0]?.code === 0 || result[0]?.code === 1,
        device: device.name,
        property: args.prop_name,
        value,
      });
    }
    if (name === "run_device_action") {
      const action = info.actions.find((item) => item.name === args.action_name);
      if (!action) throw new Error(`不支持的动作: ${args.action_name}`);
      const result = (await api("/miotspec/action", {
        params: { did: device.did, ...action.method },
      })) as { code?: number };
      return JSON.stringify({
        success: result?.code === 0 || result?.code === 1,
        device: device.name,
        action: args.action_name,
      });
    }
    if (name === "control_device") {
      const command = String(args.command || "").trim().toLowerCase();
      const on = info.properties.find((prop) => prop.name === "on");
      if (command === "on" || command === "off") {
        return on
          ? executeMijiaTool("set_device_property", {
              dev_name: device.name,
              prop_name: "on",
              value: command === "on" ? "true" : "false",
            })
          : executeMijiaTool("run_device_action", {
              dev_name: device.name,
              action_name: command === "on" ? "turn-on" : "turn-off",
            });
      }
      if (command === "toggle") {
        return executeMijiaTool("run_device_action", {
          dev_name: device.name,
          action_name: "toggle",
        });
      }
      const split = command.split("=", 2);
      if (split.length === 2) {
        return executeMijiaTool("set_device_property", {
          dev_name: device.name,
          prop_name: split[0].trim(),
          value: split[1].trim(),
        });
      }
      throw new Error(`Unknown command '${command}'`);
    }
    throw new Error(`未知米家工具: ${name}`);
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
