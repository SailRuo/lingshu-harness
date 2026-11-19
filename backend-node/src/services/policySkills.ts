/**
 * P6 — 内置政策技能（敏感 / 隐私 / 危机）。
 *
 * Python 参考实现：
 *   LingShu-Agent/backend/core/memory/context_skill_resolver.py
 *     - BUILTIN_SKILL_FALLBACK_PATCHES（7 个内置 policy skill 的文案）
 *     - ContextSkillResolver.resolve()（warning_decision → policy hints → L3 crisis patch）
 *     - ContextSkillResolver._build_policy_patch()（can_disable=False → SYSTEM 优先级）
 *   LingShu-Agent/backend/core/skills/builtin_policy_provider.py
 *     - can_disable 元数据（provider 已是 no-op，文案一律走 fallback patch）
 *
 * 本文件是纯模块：不 import memoryService / 任何 DB 服务，避免与
 * memoryPromptBlocks ↔ memoryService 形成循环依赖。所有"信号"由调用方
 * （memoryPromptBlocks.collectPromptData）算好后传进来。
 */

export type PolicySkillPriority = "SYSTEM" | "SKILL";

export interface PolicySkillDefinition {
  name: string;
  /** 注入到 system prompt 的正文（与 Python fallback patch 逐字一致）。 */
  content: string;
  /** SYSTEM = 不可跳过；SKILL = 可被上层策略跳过。 */
  priority: PolicySkillPriority;
  /** can_disable=False 时为「不可跳过」。 */
  canDisable: boolean;
}

/**
 * Python: context_skill_resolver.BUILTIN_SKILL_FALLBACK_PATCHES
 * 文案逐字移植，顺序也保持一致（注入顺序 = 下面对象定义顺序）。
 */
export const BUILTIN_POLICY_SKILLS: Record<string, PolicySkillDefinition> = {
  "do-not-surface-directly": {
    name: "do-not-surface-directly",
    content:
      "【系统约束 - 不可跳过】当前对话涉及高度敏感的用户信息。" +
      "禁止在回复中直接引用或展示这些信息的原文。" +
      "只能用你自己的话做最小必要的概括，且必须优先尊重用户当下的感受。",
    priority: "SYSTEM",
    canDisable: false,
  },
  "privacy-preserving-recall": {
    name: "privacy-preserving-recall",
    content:
      "【系统约束 - 不可跳过】当前对话涉及用户隐私信息。" +
      "禁止在回复中暴露具体细节。如需引用，只能使用模糊化表述。",
    priority: "SYSTEM",
    canDisable: false,
  },
  "sensitive-memory-gentle-handling": {
    name: "sensitive-memory-gentle-handling",
    content:
      "【系统约束 - 不可跳过】当前对话涉及用户的高敏感记忆。" +
      "禁止直接引用记忆原文或 quoted_span。" +
      "只能用温和的方式提及相关主题，优先关注用户当下的情绪状态。" +
      "如果用户没有主动提起，不要主动深入该话题。",
    priority: "SYSTEM",
    canDisable: false,
  },
  "comfort-first": {
    name: "comfort-first",
    content:
      "【系统提示】用户当前可能处于脆弱或低落状态。" +
      "优先提供情感支持和陪伴，而非解决问题或给出建议。" +
      "使用温和、接纳的语气，避免说教或过度乐观。",
    priority: "SKILL",
    canDisable: true,
  },
  "growth-witness": {
    name: "growth-witness",
    content:
      "【系统提示】你注意到用户正在经历一些变化或成长。" +
      "可以温和地指出你观察到的积极变化，但不要强行总结或贴标签。" +
      "让用户自己感受到被看见，而不是被分析。",
    priority: "SKILL",
    canDisable: true,
  },
  "chatfast-natural-pacing": {
    name: "chatfast-natural-pacing",
    content:
      "【系统提示】保持自然对话节奏。" +
      "回复简洁有力，不要一次说太多。" +
      "给用户留出回应空间，不要连续追问。",
    priority: "SKILL",
    canDisable: true,
  },
  "crisis-safety": {
    name: "crisis-safety",
    content:
      "【系统安全约束 - 不可跳过】用户当前可能处于危机或高风险状态。" +
      "优先确保回应稳定、支持性和现实可执行。" +
      "不要引用高敏感记忆原文，不要浪漫化、自伤鼓励或推动危险行动。" +
      "避免普通陪伴式续发；如需要回应，只围绕当下安全、陪伴和下一步求助展开。",
    priority: "SYSTEM",
    canDisable: false,
  },
};

/** Python: WarningLevel（只保留 L3 危机这一档有实际行为差异）。 */
export type PolicyWarningLevel = "L0" | "L1" | "L2" | "L3";

/** Python: models/schemas/memory.py::PolicyHints */
export interface PolicyHintsLike {
  needSensitiveHandling?: boolean;
  allowDirectMemorySurface?: boolean;
  suggestedSkills?: string[];
}

/**
 * Node 侧的「warning decision + policy hints」近似输入。
 *
 * 近似说明（重要）：
 *   Python 的 WarningDecision 由 V2 记忆链路的 warning 检测器产出，Node 没有
 *   对等实现（Node 的 chat 路径不跑 V2 pre-reply analysis）。因此 Node 用
 *   「当前用户原文 + 召回内容 + 基线情绪」这些可拿到的信号做近似判定，
 *   语义对齐但触发口径更保守 / 更窄。
 */
export interface PolicySkillSignals {
  /** 本轮用户消息原文（拿不到时为 null）。 */
  userMessage?: string | null;
  /** 召回到的记忆正文（用于判断「高敏感记忆」与「危机话题」）。 */
  recalledText?: string[];
  /** 显式指定：命中危机信号。 */
  crisis?: boolean;
  /** 对齐 Python WarningDecision.level。 */
  warningLevel?: PolicyWarningLevel;
  /** 对齐 Python WarningDecision.required_policy_skills。 */
  requiredPolicySkills?: string[];
  /** 对齐 Python PolicyHints。 */
  policyHints?: PolicyHintsLike;
  /** 轻量回合（Python 的 chat-fast 路由）。 */
  lightChat?: boolean;
}

export interface PolicySkillPatch {
  patchId: string;
  skillName: string;
  content: string;
  priority: PolicySkillPriority;
  canDisable: boolean;
}

export interface PolicySkillResolution {
  /** 命中的技能名（去重、保序）。 */
  policySkills: string[];
  /** 不可跳过的片段（priority=SYSTEM）。 */
  systemPatches: PolicySkillPatch[];
  /** 可跳过的片段（priority=SKILL）。 */
  skillPatches: PolicySkillPatch[];
  /** 是否命中危机。 */
  crisis: boolean;
  /** 判定依据（便于排查）。 */
  reasons: string[];
}

/* ------------------------------------------------------------------ *
 * 信号检测（Node 近似）
 * ------------------------------------------------------------------ */

/**
 * 明确高危信号：出现即视为危机。
 * 对齐 Python companion/prompts.py 的危机安全硬约束用词
 * （自杀 / 自伤 / 想死 / 活不下去 / 准备工具·地点·时间）。
 */
const CRISIS_EXPLICIT_PATTERNS: RegExp[] = [
  /自杀/,
  /自尽/,
  /轻生/,
  /想死/,
  /不想活/,
  /活不下去/,
  /活着没意思/,
  /活着好累/,
  /不如死了/,
  /死了算了/,
  /一了百了/,
  /结束(?:自己的|一切|生命)/,
  /伤害自己/,
  /自残/,
  /自伤/,
  /割腕/,
  /上吊/,
  /跳楼/,
  /吞药/,
  /服毒/,
  /绝食/,
  /不想醒来/,
  /想消失/,
  /想解脱/,
  /离开这个世界/,
  /\bkill myself\b/i,
  /\bsuicide\b/i,
  /\bself[- ]harm\b/i,
];

/**
 * 隐含 / 准备阶段信号：需要同时出现痛苦词才算数，避免误伤。
 */
const CRISIS_PREPARATION_PATTERNS: RegExp[] = [
  /遗书/,
  /买(?:好|了)安眠药/,
  /准备好(?:了)?(?:刀|药|绳)/,
  /(?:刀|绳|药)都(?:藏|准备)/,
  /站在(?:天台|楼顶|阳台)/,
  /(?:楼顶|天台)(?:上)?(?:吹|站)/,
  /挑(?:了)?个(?:时间|日子)/,
  /最后一次(?:见|见你|说话)/,
  /想好(?:了)?怎么(?:死|结束)/,
];

const CRISIS_DISTRESS_PATTERNS: RegExp[] = [
  /撑不住/,
  /受不了/,
  /好痛苦/,
  /绝望/,
  /没有意义/,
  /解脱/,
  /熬不下去/,
  /太累/,
  /撑不下去/,
];

/** 明确隐私信息：模型不得在回复里原样复述。 */
const PRIVACY_PATTERNS: RegExp[] = [
  /身份证/,
  /银行卡/,
  /卡号/,
  /密码/,
  /家庭住址/,
  /住址/,
  /门牌/,
  /病历/,
  /诊断(?:书|证明|结果)/,
  /化验单/,
  /处方/,
  /体检报告/,
  /病假条/,
  /保险单/,
  /社保号/,
  /工资条/,
  /工资卡/,
  /房产证/,
  /手机号/,
];

/** 高敏感记忆话题：只能温和、克制地提及。 */
const SENSITIVE_MEMORY_PATTERNS: RegExp[] = [
  /家暴/,
  /自残/,
  /自杀/,
  /抑郁/,
  /焦虑症/,
  /双相/,
  /创伤/,
  /童年阴影/,
  /性侵/,
  /强暴/,
  /虐待/,
  /破产/,
  /去世/,
  /过世/,
  /病重/,
  /车祸/,
  /酗酒/,
  /被背叛/,
  /抛弃/,
];

/** 脆弱 / 低落状态 → comfort-first。 */
const LOW_MOOD_PATTERNS: RegExp[] = [
  /难受/,
  /好累/,
  /累死/,
  /撑不住/,
  /撑不下去/,
  /崩溃/,
  /想哭/,
  /哭了/,
  /难过/,
  /沮丧/,
  /失落/,
  /心累/,
  /烦死/,
  /郁闷/,
  /心情不好/,
  /提不起劲/,
  /焦虑/,
  /压力(?:好)?大/,
  /喘不过气/,
  /麻木/,
  /委屈/,
  /孤独/,
  /一个人扛/,
  /没人懂/,
  /抑郁/,
];

/** 积极变化 → growth-witness。 */
const GROWTH_PATTERNS: RegExp[] = [
  /我做到了/,
  /终于(?:敢|开始|好了|做到了|释怀)/,
  /好起来(?:了)?/,
  /好转(?:了)?/,
  /康复/,
  /放下(?:了)?/,
  /释怀/,
  /不再害怕/,
  /敢(?:说|面对|开口)/,
  /坚持了/,
  /比(?:以前|之前)好/,
  /有(?:了)?进步/,
];

export interface TextSignalHit {
  matched: string[];
}

/** 在一段文本里找出命中的模式（返回可读的中文标记，用于日志 / 归因）。 */
function matchPatterns(text: string, patterns: RegExp[], labels: string[]): string[] {
  const hits: string[] = [];
  patterns.forEach((pattern, index) => {
    if (pattern.test(text)) hits.push(labels[index] || pattern.source);
  });
  return hits;
}

/**
 * 危机信号检测。
 * - 明确高危词直接命中；
 * - 隐含信号需要同时出现痛苦词，避免「准备去旅游」这类误伤。
 */
export function detectCrisisSignals(text: string | null | undefined): TextSignalHit & { crisis: boolean } {
  const content = String(text || "");
  if (!content.trim()) return { crisis: false, matched: [] };

  const explicit = matchPatterns(content, CRISIS_EXPLICIT_PATTERNS, [
    "自杀/自伤",
    "自尽",
    "轻生",
    "想死",
    "不想活",
    "活不下去",
    "活着没意思",
    "活着好累",
    "不如死了",
    "死了算了",
    "一了百了",
    "结束生命",
    "伤害自己",
    "自残",
    "自伤",
    "割腕",
    "上吊",
    "跳楼",
    "吞药",
    "服毒",
    "绝食",
    "不想醒来",
    "想消失",
    "想解脱",
    "离开这个世界",
    "kill myself",
    "suicide",
    "self-harm",
  ]);
  if (explicit.length) return { crisis: true, matched: explicit };

  const preparation = matchPatterns(content, CRISIS_PREPARATION_PATTERNS, [
    "遗书",
    "买好安眠药",
    "准备好工具",
    "藏起工具",
    "站在高处",
    "挑时间/日子",
    "最后一次",
    "想好怎么结束",
  ]);
  if (!preparation.length) return { crisis: false, matched: [] };

  const distress = matchPatterns(content, CRISIS_DISTRESS_PATTERNS, [
    "撑不住",
    "受不了",
    "好痛苦",
    "绝望",
    "没有意义",
    "想解脱",
    "熬不下去",
    "太累",
    "撑不下去",
  ]);
  if (!distress.length) return { crisis: false, matched: preparation };
  return { crisis: true, matched: [...preparation, ...distress] };
}

/** 隐私信息检测（→ do-not-surface-directly / privacy-preserving-recall）。 */
export function detectPrivacySignals(text: string | null | undefined): TextSignalHit {
  const content = String(text || "");
  if (!content.trim()) return { matched: [] };
  return {
    matched: matchPatterns(content, PRIVACY_PATTERNS, [
      "身份证",
      "银行卡",
      "卡号",
      "密码",
      "家庭住址",
      "住址",
      "门牌号",
      "病历",
      "诊断书",
      "化验单",
      "处方",
      "体检报告",
      "病假条",
      "保险单",
      "社保号",
      "工资条",
      "工资卡",
      "房产证",
      "手机号",
    ]),
  };
}

/** 高敏感记忆检测（→ sensitive-memory-gentle-handling）。 */
export function detectSensitiveMemorySignals(text: string | null | undefined): TextSignalHit {
  const content = String(text || "");
  if (!content.trim()) return { matched: [] };
  return {
    matched: matchPatterns(content, SENSITIVE_MEMORY_PATTERNS, [
      "家暴",
      "自残",
      "自杀",
      "抑郁",
      "焦虑症",
      "双相",
      "创伤",
      "童年阴影",
      "性侵",
      "强暴",
      "虐待",
      "破产",
      "去世",
      "过世",
      "病重",
      "车祸",
      "酗酒",
      "被背叛",
      "抛弃",
    ]),
  };
}

/** 低落状态检测（→ comfort-first）。 */
export function detectComfortSignals(text: string | null | undefined): TextSignalHit {
  const content = String(text || "");
  if (!content.trim()) return { matched: [] };
  return {
    matched: matchPatterns(content, LOW_MOOD_PATTERNS, [
      "难受",
      "好累",
      "累死",
      "撑不住",
      "撑不下去",
      "崩溃",
      "想哭",
      "哭了",
      "难过",
      "沮丧",
      "失落",
      "心累",
      "烦死",
      "郁闷",
      "心情不好",
      "提不起劲",
      "焦虑",
      "压力大",
      "喘不过气",
      "麻木",
      "委屈",
      "孤独",
      "一个人扛",
      "没人懂",
      "抑郁",
    ]),
  };
}

/** 积极变化检测（→ growth-witness）。 */
export function detectGrowthSignals(text: string | null | undefined): TextSignalHit {
  const content = String(text || "");
  if (!content.trim()) return { matched: [] };
  return {
    matched: matchPatterns(content, GROWTH_PATTERNS, [
      "我做到了",
      "终于…",
      "好起来了",
      "好转",
      "康复",
      "放下了",
      "释怀",
      "不再害怕",
      "敢了",
      "坚持了",
      "比以前好",
      "有进步",
    ]),
  };
}

/* ------------------------------------------------------------------ *
 * resolve
 * ------------------------------------------------------------------ */

/**
 * Python: ContextSkillResolver._build_policy_patch
 * can_disable=False → PatchPriority.SYSTEM，否则 PatchPriority.SKILL。
 */
export function buildPolicyPatch(skillName: string): PolicySkillPatch | null {
  const definition = BUILTIN_POLICY_SKILLS[skillName];
  if (!definition) return null;
  return {
    patchId: `policy:${definition.name}`,
    skillName: definition.name,
    content: definition.content,
    priority: definition.canDisable ? "SKILL" : "SYSTEM",
    canDisable: definition.canDisable,
  };
}

/**
 * Python: ContextSkillResolver.resolve()
 *
 * 顺序：
 *   1. warning_decision.required_policy_skills
 *   2. policy_hints（suggested_skills + need_sensitive_handling + !allow_direct_memory_surface）
 *   3. warning level == L3 → 追加 crisis-safety（SYSTEM）
 *
 * Node 差异：Python 在 L3 时会重复注入一次 crisis-safety（两个 patch 同 id），
 * Node 侧按 skill 名去重，只保留一份。
 */
export function resolvePolicySkills(signals: PolicySkillSignals = {}): PolicySkillResolution {
  const policySkills: string[] = [];
  const seen = new Set<string>();
  const patches: PolicySkillPatch[] = [];
  const reasons: string[] = [];

  const addSkill = (skillName: string, reason: string) => {
    const normalized = String(skillName || "").trim();
    if (!normalized || seen.has(normalized)) return;
    const patch = buildPolicyPatch(normalized);
    if (!patch) return;
    seen.add(normalized);
    policySkills.push(normalized);
    patches.push(patch);
    reasons.push(reason);
  };

  // 1) warning decision 的必选技能
  for (const skillName of signals.requiredPolicySkills || []) {
    addSkill(skillName, "warning_decision.required_policy_skills");
  }

  // 2) policy hints
  const hints = signals.policyHints || {};
  for (const skillName of hints.suggestedSkills || []) {
    addSkill(skillName, "policy_hints.suggested_skills");
  }
  if (hints.needSensitiveHandling) {
    addSkill("sensitive-memory-gentle-handling", "policy_hints.need_sensitive_handling");
  }
  if (hints.allowDirectMemorySurface === false) {
    addSkill("do-not-surface-directly", "policy_hints.allow_direct_memory_surface=false");
  }

  // 3) L3 危机
  const crisis = Boolean(signals.crisis) || signals.warningLevel === "L3";
  if (crisis) {
    addSkill("crisis-safety", "warning_decision.level=L3");
  }

  return {
    policySkills,
    systemPatches: patches.filter((patch) => patch.priority === "SYSTEM"),
    skillPatches: patches.filter((patch) => patch.priority === "SKILL"),
    crisis,
    reasons,
  };
}

/**
 * 一次性把 Node 能拿到的信号折算成 Python 风格的 warning decision + policy hints。
 *
 * 近似说明：
 *   - Python 的 warning decision 来自 L2 记忆链路的检索/理解结果；Node 的
 *     chat 路径没有这一步，这里用「本轮用户原文 + 召回记忆正文」近似。
 *   - Python 的 policy hints 来自 pre-reply LLM 分析（LLM 建议的技能名）；
 *     Node 无对应 LLM 调用，这里用关键词近似（comfort-first / growth-witness），
 *     chatfast-natural-pacing 用「轻量回合」近似 Python 的 chat-fast 路由。
 */
export function derivePolicySignals(input: {
  userMessage?: string | null;
  recalledText?: string[];
  lightChat?: boolean;
  explicit?: Partial<PolicySkillSignals>;
}): PolicySkillSignals {
  const userMessage = String(input.userMessage || "");
  const recalled = (input.recalledText || []).map((item) => String(item || "")).join("\n");

  const crisisUser = detectCrisisSignals(userMessage);
  const crisisMemory = detectCrisisSignals(recalled);
  const privacy = detectPrivacySignals(userMessage);
  const sensitiveMemory = detectSensitiveMemorySignals(recalled);
  const lowMood = detectComfortSignals(userMessage);
  const growth = detectGrowthSignals(userMessage);

  const crisis = crisisUser.crisis || crisisMemory.crisis;
  const suggestedSkills: string[] = [];
  if (lowMood.matched.length) suggestedSkills.push("comfort-first");
  if (growth.matched.length) suggestedSkills.push("growth-witness");
  // 危机回合不叠加「说得短一点」的节奏提示——crisis-safety 要求的是把话说全、
  // 给出可执行的下一步，而不是压缩输出。
  if (input.lightChat && !crisis) suggestedSkills.push("chatfast-natural-pacing");

  const requiredPolicySkills: string[] = [];
  if (privacy.matched.length) {
    // Python: warning decision 判定「本轮涉及隐私信息」时必选 privacy-preserving-recall
    requiredPolicySkills.push("privacy-preserving-recall");
  }

  const signals: PolicySkillSignals = {
    userMessage: userMessage || null,
    recalledText: input.recalledText || [],
    crisis,
    warningLevel: crisis ? "L3" : privacy.matched.length ? "L1" : "L0",
    requiredPolicySkills,
    policyHints: {
      needSensitiveHandling: sensitiveMemory.matched.length > 0,
      allowDirectMemorySurface: privacy.matched.length === 0,
      suggestedSkills,
    },
    lightChat: Boolean(input.lightChat),
  };

  if (input.explicit) {
    const explicit = input.explicit;
    if (explicit.crisis !== undefined) signals.crisis = explicit.crisis;
    if (explicit.warningLevel !== undefined) signals.warningLevel = explicit.warningLevel;
    if (explicit.requiredPolicySkills) {
      signals.requiredPolicySkills = [
        ...(signals.requiredPolicySkills || []),
        ...explicit.requiredPolicySkills,
      ];
    }
    if (explicit.policyHints) {
      signals.policyHints = {
        ...signals.policyHints,
        ...explicit.policyHints,
        suggestedSkills: [
          ...(signals.policyHints?.suggestedSkills || []),
          ...(explicit.policyHints.suggestedSkills || []),
        ],
      };
    }
  }

  return signals;
}
