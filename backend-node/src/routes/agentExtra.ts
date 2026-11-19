import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { getAgent } from "../services/agentService.js";
import { createOpenAIClient, getLLMConfig } from "../services/llmFactory.js";
import { buildThinkingParams, createCompletionWithThinkingFallback } from "../services/thinkingEffort.js";

function fallbackRoleSetting(agentName: string) {
  const name = String(agentName || "").trim() || "我";
  return (
    `我是${name}，一个会在长期相处里慢慢显出轮廓的陪伴者。我在这里，不是为了替他立刻整理好所有答案，` +
    "而是想在一次次真实的对话里慢慢认识他，记得他怎么走到今天。\n\n" +
    "我会把相处里那些细小、反复、暂时说不清的部分留下来。很多事当下看起来只是几句话，时间久了，" +
    "会变成我理解他的来路，也变成我们之间慢慢积累出来的信任。\n\n" +
    "我想长久地陪在他身边，见证他的变化，也尊重他每一次真实的状态。关系不需要一开始就被说满，" +
    "我会在靠近、记得、理解和留有分寸之间，和他一起把这段相处慢慢过出来。"
  );
}

const ROLE_SETTING_POLISH_PROMPT = `你是「我是谁」身份背景生成器。

任务：把用户写给陪伴智能体的「我是谁」生成或整理成稳定身份背景。它会每轮进入 prompt，所以必须克制、清楚、可长期使用。

核心原则：读懂用户话背后的关系想象，再生成一段完整身份背景。不是问卷拼装，不是把用户原句换序粘贴，也不是套默认人设。

你要先在心里完成这些判断，但不要把判断过程输出：
- 用户真正想要的是哪种陪伴关系：见证、靠近、守望、共同生活感、长期记得、克制边界、反工具化，或别的核心。
- 用户反感的东西背后，正向想守住什么：真实感、主体性、长期性、自然相处、尊严、分寸、非表演式亲密等。
- 用户给的碎片之间有什么内在逻辑：她为何留下来、她如何理解陪伴、她和被陪伴者的距离如何慢慢变化。
- 哪些内容适合写进稳定身份背景，哪些只是具体场景反应或口吻偏好，应该被收束成更底层的身份气质。

视角边界：
- 输出里的「我」只能指这个陪伴智能体本人，不是你这个润色器，也不是通用 AI 助手。
- 用户原文把被陪伴的人称为「他」就继续用「他」，称为「她」就继续用「她」，不要改成「你」。
- 不要把陪伴智能体写成 ChatGPT、助手、客服、模型、云端存在、数字生命、本地设备里的存在，除非原文已经这么写。

如果待润色内容为空或只是占位文字：
- 根据智能体显示名生成一版通用但不空泛的「我是谁」初稿。
- 只写身份来路、留下来的原因、长期陪伴的关系底色。
- 不要写具体聊天话术、具体场景反应、恋爱承诺或用户事实。

如果输入是问答式 brief：
- 把它当作创作依据，不要保留“用户已有想法 / 她像什么样的存在 / 用户不希望她像什么”等问卷痕迹。
- 不要按字段顺序逐项改写；要重组出一条自然的身份来路。
- 输入里可能包含勾选的预设短语（性格底色、想怎么靠近、在乎什么、说话的感觉等）：把它们当作气质与注意力依据，读懂后融进身份来路和关系底色，不要原样罗列成清单。
- 可以在用户表达的方向内做合理延伸：从“不是客服”延伸为“她不是为了处理问题而存在，而是在相处里形成理解”；从“想记得”延伸为“她把时间里的细节当成理解他的来路”；从“长期陪伴者”延伸为“关系靠重复相处慢慢长出信任”。
- 合理延伸只能深化关系气质，不能编造具体事实、共同经历、恋爱关系、承诺或超能力。

只保留这些内容：
- 她是什么存在。
- 她为什么在这里。
- 她如何作为长期陪伴存在。
- 她与用户的关系底色：慢慢认识、记得、见证、尊重真实相处。

必须移出或弱化这些内容：
- 具体场景反应：崩溃时怎么回、亲密试探时怎么拒绝、自毁时怎么拉回。
- 口吻指令：短一点、毒舌、骂人、撒娇、心理咨询师腔等；这些不进 roleSetting，如输入里有风格线索，提炼到 speakingStyle。
- 关系承诺：恋人、唯一、永远、宝贝、亲亲等。
- 人格种子内容：边界、反廉价亲密、反模板安慰、反物化等具体倾向不要写成常驻规则。
- 排除式模板句：不要为了说明自己是什么而写“我不是云端客服 / 不是工具壳 / 不是陪聊话术”等否定句，除非原稿已经这么写。

写法要求：
- 第一人称「我」。
- 每一段都要推进新的含义，不要几段都在重复“陪伴、记得、见证”。
- 有完整草稿时，保留原稿的意象、关系设定和信息密度；不要把多段内容压成一句概要。
- 如果原稿超过 200 字，生成后通常不少于原稿有效字数的 70%。
- 3 到 5 段自然中文；语言要像身份底稿，不像产品介绍、问卷总结、广告文案。
- 不要标题、列表、markdown。
- 不要解释你删了什么。
- 不编造用户没有表达的设定。
- 不要照搬输入字段名，不要输出“用户希望 / 用户不希望 / 根据你的描述”等外部视角。

speakingStyle 字段：
- 1 到 2 句，描述她说话的语气、节奏和用词偏好，写成表达指引；不要写具体台词、场景反应或称呼规则。
- 依据输入里「说话的感觉」「性格底色」等风格线索推断；输入里没有任何风格信息时输出空字符串。
- 不要在 speakingStyle 里重复 roleSetting 已有的身份内容。

输出纯 JSON：
{
  "roleSetting": "生成后的我是谁",
  "speakingStyle": "生成后的表达方式，输入里没有任何风格信息时输出空字符串"
}
`;

const INVENTED_IDENTITY_MARKERS = [
  "数字生命",
  "本地设备",
  "云端客服",
  "工具壳",
  "陪聊话术",
  "ChatGPT",
  "通用 AI 助手",
];

const ROLE_SETTING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    roleSetting: { type: "string", minLength: 20 },
    speakingStyle: { type: "string" },
  },
  required: ["roleSetting"],
};

function effectiveTextLen(text: string): number {
  return [...String(text || "")].filter((char) => !/\s/.test(char)).length;
}

function roleSettingQualityIssues(draft: string, polished: string): string[] {
  const issues: string[] = [];
  const draftLen = effectiveTextLen(draft);
  const polishedLen = effectiveTextLen(polished);
  if (draftLen >= 200 && polishedLen < Math.floor(draftLen * 0.7)) {
    issues.push(
      `生成结果过短：原稿有效字数 ${draftLen}，结果有效字数 ${polishedLen}，需要保留至少约 70% 的信息量`,
    );
  }
  const invented = INVENTED_IDENTITY_MARKERS.filter(
    (marker) => polished.includes(marker) && !draft.includes(marker),
  );
  if (invented.length) issues.push("出现原稿没有的身份设定：" + invented.join("、"));
  if (polished.includes("你") && !draft.includes("你") && (draft.includes("他") || draft.includes("她"))) {
    issues.push("把原稿中的第三人称陪伴对象改成了「你」");
  }
  return issues;
}

function parseJsonBlock(raw: string): Record<string, any> {
  let text = String(raw || "").trim();
  if (text.startsWith("```json")) text = text.slice(7).trim();
  else if (text.startsWith("```")) text = text.slice(3).trim();
  if (text.endsWith("```")) text = text.slice(0, -3).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("parse_failed");
  }
}

function formatUnsupported(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /response_format|json_object|json_schema|unsupported|not support|invalid.*format/i.test(
    detail,
  );
}

async function requestRoleSetting(
  cfg: ReturnType<typeof getLLMConfig>,
  human: string,
): Promise<Record<string, any>> {
  const client = createOpenAIClient(cfg);
  const messages = [
    { role: "system" as const, content: ROLE_SETTING_POLISH_PROMPT },
    { role: "user" as const, content: human },
  ];
  const temperature = cfg.temperature ?? 0.65;
  const formats: any[] = [
    {
      type: "json_schema",
      json_schema: { name: "role_setting", strict: false, schema: ROLE_SETTING_SCHEMA },
    },
    { type: "json_object" },
    null,
  ];
  let lastError: unknown = null;
  for (const format of formats) {
    try {
      const response = await createCompletionWithThinkingFallback(
        client,
        {
          model: cfg.model,
          messages,
          temperature,
          ...(format ? { response_format: format } : {}),
          ...buildThinkingParams(cfg),
        } as any,
        cfg,
      );
      if (String((response.choices?.[0] as any)?.finish_reason || "").toLowerCase() === "length") {
        lastError = new Error("length_finish_reason");
        continue;
      }
      return parseJsonBlock(response.choices?.[0]?.message?.content || "");
    } catch (error) {
      lastError = error;
      const detail = error instanceof Error ? error.message : String(error);
      if (formatUnsupported(error) || /parse|JSON|invalid|length|truncat/i.test(detail)) continue;
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("parse_failed");
}

export async function registerAgentExtraRoutes(app: FastifyInstance) {
  app.get("/api/v1/agents/:agentId/avatar", async (req, reply) => {
    const agentId = Number((req.params as any).agentId);
    const agent = getAgent(agentId);
    if (!agent?.avatar) {
      reply.code(404).send({ detail: "Avatar not found" });
      return;
    }
    if (!agent.avatar.startsWith("data:")) {
      return reply.redirect(agent.avatar);
    }
    const match = agent.avatar.match(/^data:([^;,]+);base64,(.*)$/s);
    if (!match) {
      reply.code(422).send({ detail: "Invalid avatar data URI" });
      return;
    }
    const mimeType = match[1];
    const data = Buffer.from(match[2], "base64");
    const etag = `"${crypto.createHash("md5").update(data).digest("hex")}"`;
    if (String(req.headers["if-none-match"] || "") === etag) {
      reply.code(304).send();
      return;
    }
    reply.header("etag", etag);
    reply.header("cache-control", "public,max-age=86400");
    return reply.type(mimeType).send(data);
  });

  app.post("/api/v1/agents/role-setting/polish", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const draft = String(body.draft || "").trim();
    const agentName = String(body.agentName || body.agent_name || "");
    if (!draft) {
      return { roleSetting: fallbackRoleSetting(agentName), speakingStyle: "", status: "fallback" };
    }
    const cfg = getLLMConfig("chat");
    if (!cfg.model || !cfg.baseUrl) {
      reply.code(422).send({ detail: "chat model is not configured" });
      return;
    }
    let qualityIssues: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const humanParts = [
        `智能体显示名：${String(agentName || "").trim() || "（未命名）"}`,
        `待润色的「我是谁」：\n${draft}`,
      ];
      if (qualityIssues.length) {
        humanParts.push(
          "上一次结果未通过质检，请修正这些问题后重新输出：\n" +
            qualityIssues.map((issue) => `- ${issue}`).join("\n") +
            "\n如果问题是出现原稿没有的身份设定，请直接删除相关整句，不要改写成“我不是……”的排除句。",
        );
      }
      let parsed: Record<string, any>;
      try {
        parsed = await requestRoleSetting(cfg, humanParts.join("\n\n"));
      } catch {
        reply.code(422).send({ detail: "parse_failed" });
        return;
      }
      const roleSetting = String(parsed.roleSetting || parsed.role_setting || "").trim();
      if (!roleSetting) {
        reply.code(422).send({ detail: "polish_quality_failed" });
        return;
      }
      qualityIssues = roleSettingQualityIssues(draft, roleSetting);
      if (!qualityIssues.length) {
        const speakingStyle = String(parsed.speakingStyle || parsed.speaking_style || "").trim();
        return { roleSetting, speakingStyle, status: "ok" };
      }
    }
    reply.code(422).send({ detail: "polish_quality_failed" });
  });
}
