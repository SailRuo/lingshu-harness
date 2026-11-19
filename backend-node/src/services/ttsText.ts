const EMOJI_RE =
  /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]+/gu;

const PARENTHETICAL_RE = /[（(][^（）()]{0,200}[）)]/g;

/**
 * P9: VRM 动作词登记表。
 *
 * Python 参考：LingShu-Agent/backend/core/companion/vrm_cues.py
 *   - VRM_CUE_REGISTRY（10 个 cue 的 id / kind / hint / tokens）
 *   - TOKEN_TO_CUE
 *   - _CUE_TAIL_PATTERN（完整动作词在句尾）
 *   - _PARTIAL_CUE_TAIL + strip_vrm_cue_for_display（半截动作词修复）
 *
 * Node 之前只有一条 VRM_CUE_RE 正则：它能清掉句中的完整动作词，但清不掉
 * 「写到一半」的动作词（例如流式缓冲里的 "#rela"），会被 TTS 当正文念出来。
 */
export interface VrmCueDef {
  id: string;
  kind: "pose" | "expression";
  hint: string;
  tokens: string[];
}

export const VRM_CUE_REGISTRY: VrmCueDef[] = [
  { id: "wave", kind: "pose", hint: "问候、道别、轻快地打招呼", tokens: ["#wave", "#招手"] },
  { id: "nod", kind: "pose", hint: "同意、表示听懂、简短确认", tokens: ["#nod", "#点头"] },
  {
    id: "yawn",
    kind: "pose",
    hint: "夜深了、困了、慵懒陪伴（少用）",
    tokens: ["#yawn", "#打哈欠"],
  },
  {
    id: "shake",
    kind: "pose",
    hint: "否定、思考、纠结、一时想不起来",
    tokens: ["#shake", "#摇头", "#思考", "#挠头", "#scratch"],
  },
  {
    id: "happy",
    kind: "expression",
    hint: "开心、被逗乐、温柔鼓励",
    tokens: ["#happy", "#笑", "#高兴"],
  },
  {
    id: "relaxed",
    kind: "expression",
    hint: "安抚、慢慢来、轻松承接",
    tokens: ["#relaxed", "#放松", "#欣喜"],
  },
  {
    id: "surprised",
    kind: "expression",
    hint: "意外消息、没想到、轻微吃惊",
    tokens: ["#surprised", "#惊讶"],
  },
  {
    id: "sad",
    kind: "expression",
    hint: "共情、心疼、陪你难过（克制使用）",
    tokens: ["#sad", "#难过", "#悲伤"],
  },
  {
    id: "angry",
    kind: "expression",
    hint: "嗔怪、被惹毛、轻微不满（克制使用）",
    tokens: ["#angry", "#生气", "#愤怒"],
  },
  {
    id: "neutral",
    kind: "expression",
    hint: "收回夸张表情，回到平常脸",
    tokens: ["#neutral", "#标准", "#恢复"],
  },
];

/** token（小写，含 #）→ cue id */
export const VRM_TOKEN_TO_CUE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const cue of VRM_CUE_REGISTRY) {
    for (const token of cue.tokens) map[token.toLowerCase()] = cue.id;
  }
  return map;
})();

/** token 里已经带了 "#"，这里只做正则转义。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 句中出现的完整动作词（保持 Node 既有行为：出现在任何位置都清掉）。 */
const VRM_CUE_RE = new RegExp(
  `(?:${VRM_CUE_REGISTRY.flatMap((cue) => cue.tokens).map(escapeRegExp).join("|")})` +
    "(?=$|\\s|[，。！？；：,.!?;:])",
  "gi",
);

/** 句尾的完整动作词（Python _CUE_TAIL_PATTERN）。 */
const VRM_CUE_TAIL_RE = new RegExp(
  `(${Object.keys(VRM_TOKEN_TO_CUE)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|")})\\s*$`,
  "i",
);

/** 句尾写到一半的动作词（Python _PARTIAL_CUE_TAIL）。 */
const VRM_PARTIAL_CUE_TAIL_RE = /#([\w\u4e00-\u9fff]*)$/i;

/** Python vrm_cues.py::resolve_vrm_cue_id */
export function resolveVrmCueId(raw: string | null | undefined): string | null {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return null;
  if (VRM_TOKEN_TO_CUE[text]) return VRM_TOKEN_TO_CUE[text];
  const withHash = text.startsWith("#") ? text : `#${text}`;
  if (VRM_TOKEN_TO_CUE[withHash]) return VRM_TOKEN_TO_CUE[withHash];
  if (VRM_CUE_REGISTRY.some((cue) => cue.id === text)) return text;
  return null;
}

/** Python vrm_cues.py::parse_vrm_cue_from_text */
export function parseVrmCueFromText(text: string): { text: string; cueId: string | null } {
  const trimmed = String(text || "").replace(/\s+$/, "");
  const match = VRM_CUE_TAIL_RE.exec(trimmed);
  if (!match) return { text, cueId: null };
  const token = match[1].toLowerCase();
  const cueId = VRM_TOKEN_TO_CUE[token] || null;
  return { text: trimmed.slice(0, match.index).trimEnd(), cueId };
}

/**
 * Python vrm_cues.py::strip_vrm_cue_for_display
 *
 * 1) 去掉句尾的完整动作词；
 * 2) 去掉句尾写到一半的动作词（"#rela" → 若它是某个 token 的前缀就整段删掉）。
 */
export function stripVrmCueForDisplay(text: string): string {
  const display = parseVrmCueFromText(text).text;
  const partial = VRM_PARTIAL_CUE_TAIL_RE.exec(display);
  if (!partial) return display;
  const partialToken = `#${partial[1]}`.toLowerCase();
  for (const token of Object.keys(VRM_TOKEN_TO_CUE)) {
    if (token.startsWith(partialToken) && token !== partialToken) {
      return display.slice(0, partial.index).trimEnd();
    }
  }
  return display;
}

export function sanitizeTtsText(text: string): string {
  let result = String(text || "");
  result = result.replace(/```[\s\S]*?```/g, " ");
  result = result.replace(/`([^`]*)`/g, "$1");
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/^#{1,6}\s+/gm, "");
  result = result.replace(/~~(.*?)~~/g, "$1");
  result = result.replace(/(\*\*|__)(.*?)\1/g, "$2");
  result = result.replace(/(\*|_)(.*?)\1/g, "$2");
  result = result.replace(/^\s*[-*+]\s+/gm, "");
  result = result.replace(/^\s*\d+[.)]\s+/gm, "");
  result = result.replace(/^\s*>\s?/gm, "");
  result = result.replace(VRM_CUE_RE, " ");
  // P9: 句尾完整 / 半截动作词都要清掉，别让 TTS 把 "#rela" 念出来。
  result = stripVrmCueForDisplay(result);
  result = result.replace(PARENTHETICAL_RE, " ");
  result = result.replace(EMOJI_RE, " ");
  result = result.replace(/[@＠]/g, "");
  result = result.replace(/\s+([，。！？；：,.!?;:])/g, "$1");
  result = result.replace(/\s+/g, " ").trim();
  return result;
}
