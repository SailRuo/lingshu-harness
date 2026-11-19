/**
 * Single source of truth for Capacitor native digest rules / prompts / constants.
 * Edit this file, then: npm run codegen:native-digest
 *
 * Generates:
 *   android/.../NativeDigestShared.java
 *   ios/.../NativeDigestShared.swift
 *   src/memory/digest/nativeDigestShared.generated.ts
 */

export const META = {
  version: 2,
  note: 'Native digest shared contract — prompts, thresholds, closed sets, pure rules.',
};

/** Idle worker + LLM + AKIN + diary thresholds. */
export const CONSTANTS = {
  IDLE_MS: 90_000,
  /**
   * Startup recovery only re-schedules agents whose NEWEST message is within
   * this window. Digest is activity-triggered (a 90s idle timer that each new
   * reply restarts), so a conversation interrupted before the timer fired — app
   * killed, service stopped — would otherwise never be digested: the next
   * trigger only comes from talking to that agent again.
   * 24h covers "chatted yesterday, never came back to that character".
   */
  STARTUP_RECOVERY_WINDOW_MS: 24 * 60 * 60 * 1000,
  LLM_TIMEOUT_MS: 300_000,
  AKIN_LINK_MAX_L2: 1.1,
  /** Vector ANN channel only — continuous episodes are often not near in L2. */
  AKIN_LINK_TOPK: 5,
  /**
   * Time-proximate streams (before/after focal by created_at). Continuity is
   * temporal/causal; these candidates bypass the L2 gate and still go through
   * the LLM AKIN judge.
   */
  AKIN_TEMPORAL_NEIGHBOR_LIMIT: 5,
  /** Max candidates sent to the judge after merging vector + temporal + siblings. */
  AKIN_CANDIDATE_TOTAL_CAP: 12,
  /**
   * 私聊消化只回补最近 N 天。更早的积压（典型：豆包历史导入）不再回溯，
   * 避免第一次消化把几十万字一次性塞进模型。digest_state 仍是高水位：
   * 一旦处理完窗口内最后一条，更早的消息自然被跳过。
   */
  DIGEST_LOOKBACK_DAYS: 3,
  /** 单次 digest 请求的输入 token 预算；超出按时间顺序拆成多批。 */
  DIGEST_MAX_INPUT_TOKENS: 128 * 1024,
  /** 一次后台任务最多连续消化的批次数，避免长时间占用。 */
  DIGEST_MAX_CHUNKS_PER_RUN: 8,
  /** 3 天窗口内单次扫描的行数安全阀（超短消息刷屏时）。 */
  DIGEST_BATCH_ROW_CAP: 4000,
  DIARY_CUTOVER_HOUR: 4,
  DIARY_MIN_MESSAGES: 2,
  DIARY_MIN_CHARS: 180,
  DIARY_MAX_CHARS: 500,
  DIARY_MIN_PARAGRAPHS: 2,
  DIARY_MAX_PARAGRAPHS: 4,
  DIARY_TIMEZONE: 'Asia/Shanghai',
  /** 开发者预览心笺的 id 前缀（与 TS innerLetters 一致）：定时补写真稿时覆盖预览稿。 */
  DEBUG_DIARY_ID_PREFIX: 'letter-debug-',
  SPEAKER_LABEL_MAX_LEN: 32,
  SIGNIFICANCE_DEFAULT: 0.5,
  SIGNIFICANCE_MIN: 0.1,
  SIGNIFICANCE_MAX: 1.0, // keep float (codegen must emit 1.0d / 1.0)
  ENTITY_NAME_MAX_LEN: 80,
  FACT_CONFIDENCE_DEFAULT: 0.7,
  // Facts use semantic recall too. Below this, do not pretend a merely
  // nearest entity is relevant; the caller falls back to recent facts.
  FACT_PROMPT_SIMILARITY_FLOOR: 0.45,
};

/** Private digest step order (documentation + optional logging). */
export const PRIVATE_DIGEST_STEPS = [
  'extract',
  'write_streams_facts',
  'akin_link',
  'constraints',
  'write_field',
  'seeds',
  'portrait',
  'inner_letter',
  'advance_digest_state',
];

export const SETS = {
  FACT_RELATIONS: [
    'HAS_NAME', 'AGE', 'GENDER', 'LIVES_IN', 'OCCUPATION', 'SLEEP_PATTERN',
    'LIKES', 'DISLIKES', 'HAS_PET', 'HAS_FRIEND', 'HAS_FAMILY', 'INTERESTED_IN',
    'HAS_HEALTH_CONDITION', 'HAS_ROUTINE', 'HAS_WORK_PATTERN',
  ],
  PLACEHOLDER_ENTITIES: [
    '', 'i', 'me', 'myself', 'ta', '我', '你', '他', '她', '用户', 'assistant', 'ai',
    'self', 'user', 'sleep state', 'unknown', 'null', 'none',
  ],
  EXTERNAL_ABOUT: [
    '他·工作', '他·健康', '他·家人', '他·爱好', '他·情绪', '他·日常', '他·其它',
    '咱俩·信任', '咱俩·相处', '咱俩·摩擦', '咱俩·其它', '其它',
  ],
  SELF_ABOUT: ['她·感受', '她·在乎', '她·反应', '她·边界'],
  ME_SUBJECTS: ['me', 'i', 'user', '用户', '本人', 'ta'],
  SELF_SUBJECTS: ['self', 'assistant', 'agent', '智能体', '助手', '你'],
};

/**
 * Response schema for the digest extractor.
 *
 * The prompt has always claimed the response was schema-constrained, but the
 * native port never sent one — that sentence is a leftover from an
 * implementation that did. Sending it now is not just about compliance: every
 * closed set in the prompt was previously advisory, and the apply path degrades
 * SILENTLY when the model steps outside one.
 *   - an `about` outside the set → normalizeAbout() rewrites it to
 *     他·日常 / 她·感受, so the stream lands in a bucket nobody chose;
 *   - a `relation` outside the set → normalizeFactEndpoints() returns null and
 *     the fact is dropped without a trace;
 *   - `significance` sent as a string → clamped back to the 0.5 default.
 * An enum turns those silent degradations into a rejected response, which the
 * one-shot JSON retry in completeJson then gets a second chance at. It also
 * closes the field-name gap on constraint updates: the prompt says 「填已有 id」
 * without ever naming the key, while the apply path reads `target_id`.
 *
 * Enums are derived from SETS so the closed sets keep a single source.
 *
 * `required` lists only what the apply path needs; every optional field stays
 * declared so the model can still emit it. Deliberately NOT strict mode: strict
 * forces `additionalProperties:false` plus every property in `required`, which
 * would make the model emit explicit nulls for the optional fields and spend
 * output tokens on nothing. Structure and types are still enforced.
 */
const EXTRACTOR_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['should_write', 'constraints', 'facts', 'streams', 'corrections'],
  properties: {
    should_write: { type: 'boolean' },
    constraints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'rule_type', 'evidence'],
        properties: {
          action: { type: 'string', enum: ['new', 'update', 'remove'] },
          rule_type: { type: 'string', enum: ['do', 'dont'] },
          /** Existing constraint id, required when action is update/remove. */
          target_id: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'relation', 'object', 'evidence'],
        properties: {
          subject: { type: 'string', enum: ['Me', 'Self'] },
          relation: { type: 'string', enum: SETS.FACT_RELATIONS },
          object: { type: 'string' },
          description: { type: 'string' },
          confidence: { type: 'number' },
          importance: { type: 'number' },
          evidence: { type: 'string' },
        },
      },
    },
    streams: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['narrative', 'about', 'stream_type', 'significance'],
        properties: {
          narrative: { type: 'string' },
          about: { type: 'string', enum: [...SETS.EXTERNAL_ABOUT, ...SETS.SELF_ABOUT] },
          stream_type: { type: 'string', enum: ['external', 'internal'] },
          significance: { type: 'number', minimum: 0.1, maximum: 1 },
        },
      },
    },
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target_type', 'target_hint'],
        properties: {
          target_type: { type: 'string', enum: ['fact'] },
          target_hint: { type: 'string' },
        },
      },
    },
    // 关系在延续（00-待办开工清单 §6）：可选。只收「双方共同留下、后来仍起作用」的
    // 共同上下文；nodes.index 指向 transcript 行首的 [序号]，原生端映射为真实消息 id
    // 并核验。旧模型输出缺它照样合规（不进 required）。
    continuity: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'note', 'nodes'],
        properties: {
          title: { type: 'string' },
          note: { type: 'string' },
          /** 历史共同来往候选序号；-1（或省略）表示新来往。 */
          carries_index: { type: 'integer', minimum: -1 },
          carry_note: { type: 'string' },
          nodes: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['index'],
              properties: {
                index: { type: 'integer', minimum: 0 },
              },
            },
          },
        },
      },
    },
  },
};

/**
 * 写入场画像（seed 复核的输入）。提示词用的是中文键名，解析器也以中文为主键，
 * 英文名只是回退别名 —— 所以 schema 必须声明中文键，否则合法输出会被拒。
 * `证据片段` 只在提示词里要求、解析器不读，但仍要声明：漏掉它会让模型按提示词
 * 输出的合法字段触发校验失败。
 */
const WRITE_FIELD_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['唤醒画像', '推高倾向', '压低倾向', '证据片段'],
  properties: {
    唤醒画像: { type: 'string' },
    推高倾向: { type: 'string' },
    压低倾向: { type: 'string' },
    证据片段: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * 人格种子复核。`action` 的闭集此前只存在于提示词文本里，而解析器把认不出的
 * action 当成 new 走默认分支 —— 一个拼错的 reinforce 会静默产出一条重复种子。
 * 这是本次上 schema 收益最大的一处。
 *
 * `target_seed_id` 与 `seed` 在 noop 时提示词要求为 null，所以用可空联合类型，
 * 而不是把它们排除在 required 之外 —— 否则模型按示例输出 null 反而违规。
 * seed body 与 write-field 同理，是中文键名。
 */
const SEED_REVIEW_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'target_seed_id', 'reason', 'seed'],
  properties: {
    action: { type: 'string', enum: ['noop', 'reinforce', 'merge', 'revise', 'new', 'retire', 'reactivate'] },
    target_seed_id: { type: ['string', 'null'] },
    // 03 §5.4 B：证伪接棒的可选来路字段。不进 required，旧的模型输出缺它照样合规。
    supersedes_seed_id: { type: ['string', 'null'] },
    // 03 §5.6：候选关系判定。同样是可选的——但**缺它不等于「所有候选都重复」**。
    // 曾经的粗闸正是拿「召回里有 active 候选」直接禁止 new，等于把相似召回当成
    // 语义判重结论，会连「可以并存的独立边界」一起挡掉。现在由模型逐条声明关系，
    // 程序只核对引用、范围与动作一致性，不自己下「同一条边界」的结论。
    candidate_relations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seed_id', 'relation'],
        properties: {
          seed_id: { type: 'string' },
          relation: { type: 'string', enum: ['duplicate', 'refine', 'independent', 'unclear'] },
          basis: { type: 'string' },
          evidence_refs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    reason: { type: 'string' },
    // U4.4/U4.5：内容层面的改变说明（可选，不进 required，旧输出缺它照样合规）。
    // 与 reason 分工：reason 写为什么动，change_summary 写旧判断是什么、新判断是什么、
    // 适用边界怎样变化。revise/merge/接棒 new/retire/reactivate 有真实变化时填；
    // noop/reinforce（正文未变）与没有旧项的纯 new 不填。
    change_summary: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        boundary: { type: 'string' },
      },
    },
    // U4.5 对种子 review 的同样约定（可选）：这条取向变化所描述的时期或条件，
    // 只写材料原样支持的时期/情境，refs 指向本段真实消息 id。程序只核验 refs
    // 真实存在与 description 非空，不判断语义写得对不对（与印象侧同一边界）。
    time_scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: { type: 'string' },
        refs: { type: 'array', items: { type: 'string' } },
      },
    },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    seed: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['内在取向', '外在显现', '唤醒画像', '推高倾向', '压低倾向', '标签'],
      properties: {
        内在取向: { type: 'string' },
        外在显现: { type: 'string' },
        唤醒画像: { type: 'string' },
        推高倾向: { type: 'string' },
        压低倾向: { type: 'string' },
        标签: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

/**
 * AKIN 事线批量判连。形状本来就简单，schema 主要防的是把候选序号当成字符串
 * 或把 focal 编错位 —— 越界序号现在会被解析器直接丢掉，等于白判一轮。
 */
const AKIN_JUDGE_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['links'],
  properties: {
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['focal', 'linked'],
        properties: {
          focal: { type: 'integer', minimum: 0 },
          linked: { type: 'array', items: { type: 'integer', minimum: 0 } },
        },
      },
    },
  },
};

/**
 * AKIN 单焦点判连 —— 只有 iOS 还有这条路径（Android 的 linkStreamToAkin 直接
 * 委托批量版）。形状与批量版不同：顶层一个 linked 数组，元素是候选下标。
 */
const AKIN_JUDGE_SINGLE_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['linked'],
  properties: {
    linked: { type: 'array', items: { type: 'integer', minimum: 0 } },
  },
};

/**
 * 修订项的「性质」闭集（03 §0 2026-10-07 缺口：补充事实被误记为认识变化）。
 *
 * 五个 category 只描述「认识之间的关系」，没有「这次到底算不算变化」的出口，
 * 于是「今天吃蛋炒饭配稀饭」这种日常追加只能硬塞进 context_refined，
 * 又被 hasEffectiveChange 按类别计成有效变化、进入变化展示。
 *
 * 模型必须显式声明本次材料与旧认识的关系：只有 `understanding_changed`
 * 才允许配变化类别；`fact_added` / `temporary_state` / `belief_unchanged`
 * 一律不得产生有效变化。程序只核对这个声明与 category 是否自洽、
 * 以及被声明为变化时有没有把旧判断与新判断分别锚定——**不代替模型判断语义**。
 *
 * 可选字段（旧输出缺它照样合规，见下），不进 required。
 */
const PORTRAIT_CHANGE_KIND_ENUM = [
  'fact_added', 'temporary_state', 'belief_unchanged', 'understanding_changed',
];

/**
 * 画像修订说明的单项（03 §4.2「自由维度的跨版本对应」）。
 *
 * 维度 key 由模型自由生成，跨版本判断「同一个认识有没有变化」不能只比字段名：
 * 旧「相处态度」改成新「工作习惯」可能是修正同一个误判，也可能只是改名。
 * 因此每项要求：变化类别（category）+ 引用的旧/新维度 key 或正文片段 +
 * 实际证据引用（evidence_refs，指提示词里编号的输入材料，如 S3/F1）。
 *
 * `change_kind` 说明材料与旧认识的关系；`changed_from` 说明**被改变的那个旧判断**
 * 是什么、`changed_to` 说明**取代它的新判断**是什么。声明
 * `understanding_changed` 时这两项必填且都要能被 before/after 锚定——
 * 只说「补了新事实」不足以说明认识变了。
 *
 * `revisions` 不放进 required：模型漏填时整理照常落库，只是没有可用的来路说明；
 * 放进 required 会让一次格式偏差把整次画像更新打回 failed。
 * `change_kind` 同理不进 required：旧输出与历史记录都能照常读取。
 */
const PORTRAIT_REVISION_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['category'],
  properties: {
    category: {
      type: 'string',
      enum: ['misunderstanding_corrected', 'user_changed', 'context_refined', 'unchanged', 'undetermined'],
    },
    change_kind: { type: 'string', enum: PORTRAIT_CHANGE_KIND_ENUM },
    changed_from: { type: 'string' },
    changed_to: { type: 'string' },
    old_key: { type: 'string' },
    new_key: { type: 'string' },
    old_understanding: { type: 'string' },
    new_understanding: { type: 'string' },
    situation: { type: 'string' },
    explanation: { type: 'string' },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    // 03 §0 U2 / 10 号 §2.2：这条认识所描述的时期或条件（「三个月前」「工作忙时」），
    // 只写材料原样支持的时期/情境，refs 指向支持它的编号材料。同样不进 required：
    // 旧输出与历史记录缺它照样解码，模型没材料可依时留空即可。
    time_scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: { type: 'string' },
        refs: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

/**
 * 用户画像。`dimensions` 的键由模型自由提炼（提示词要求 2–6 个汉字、禁止英文），
 * 所以它必须是开放键对象：这里只声明成 object，不加 additionalProperties:false，
 * 也不写 string-valued map —— 后者兼容性更差，而值的类型提示提示词已经给了。
 *
 * 2026-10-19：去掉 `anyOf`，改成「obsolete_dimension_keys 永远必填」。
 *
 * 旧写法只把 `update_user_portrait` 放进 required，内容靠 `anyOf` 分三支。
 * 可 base URL 是用户自己配的，不是每个供应商都实现 `anyOf`：忽略它的解码器眼里，
 * `{"update_user_portrait":true}` 就是**完全合法的最短输出**。日窗于是每天稳定拿到
 * 这个空决定，`userPortraitOutput` 抛错、整天判 failed，启动一次重打一次模型
 * （2026-10-18 日窗实测：首打与格式补打都只回 `{"portrait":{"update_user_portrait":true}}`）。
 *
 * 现在把清理键提成无条件必填：能表达「不改」的最小对象变成
 * `{"update_user_portrait":false,"obsolete_dimension_keys":[]}`，模型至少要先想一遍
 * 有没有要删的旧维度；程序侧仍按「有正文或有非空清理键」验收，不因此放宽内容要求。
 */
const PORTRAIT_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['update_user_portrait', 'obsolete_dimension_keys'],
  properties: {
    narrative: { type: 'string' },
    dimensions: { type: 'object' },
    update_user_portrait: { type: 'boolean' },
    obsolete_dimension_keys: { type: 'array', items: { type: 'string' } },
    revisions: { type: 'array', items: PORTRAIT_REVISION_SCHEMA_BODY },
  },
};

/**
 * 画像重写（日窗兜底）：**只产正文**，不让模型再做 A/B/C 决定。
 *
 * 2026-10-19 实测：模型连续两次只回 `{"update_user_portrait":true,"obsolete_dimension_keys":[],...}`
 * ——它愿意说「要更新」，却拒绝在同一个请求里写正文；把决定和写作塞进一次调用，
 * 非思考模型会一直卡在「决定为 true、内容为空」。所以决定失败后单独发一次纯写作请求：
 * 只给旧画像 + 旧维度 + 当天材料，要求把「我怎样对他」改写成「他怎样」。
 * 这个 schema 没有布尔决定，模型没有「只回决定」的退路。
 */
const PORTRAIT_REWRITE_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['narrative', 'dimensions'],
  properties: {
    narrative: { type: 'string' },
    dimensions: { type: 'object' },
  },
};

/**
 * 会话锚点压缩：一个 summary，外加可选的自我画像增量。
 *
 * `self_portrait` 缺失/为空不阻断摘要——summary 仍是唯一必填项。画像的合并由
 * 代码执行（模型只报本次新增/改写的维度），所以 dimensions 保持开放键对象，
 * 不设固定行数；被明确推翻的维度走 retired_dimensions 并附原因。
 */
const CONVERSATION_ANCHOR_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string' },
    self_portrait: {
      type: 'object',
      additionalProperties: false,
      properties: {
        narrative: { type: 'string' },
        dimensions: { type: 'object' },
        retired_dimensions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

/**
 * 每日反思：**只产画像**（心笺已于 2026-10-13 拆分为独立调用，见 worker 的
 * generateInnerLetter）。`required` 留空、由调用点注入（见 worker 里的
 * responseFormat 覆写）；portrait 复用独立整理的两分支合同：false 只需决定，
 * true 才要求画像内容。
 */
const DAILY_REFLECTION_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    portrait: PORTRAIT_SCHEMA_BODY,
  },
};

/**
 * 每日心笺：**只产正文**。标题由代码按日窗固定生成「M月D日心笺」，不再交给模型，
 * 避免标题变成正文第一句的截断或时间点描述。
 */
const DAILY_REVIEW_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['content'],
  properties: {
    content: { type: 'string' },
  },
};

/**
 * 剧场/群聊「在场」意识流，两端同形。`perspective` 出闭集时解析器会静默兜成
 * everyone（把「我」的视角记成大家的），enum 正是为了拦住这个。
 */
const PRESENCE_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['streams'],
  properties: {
    streams: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['narrative', 'about', 'perspective'],
        properties: {
          narrative: { type: 'string' },
          about: { type: 'string' },
          perspective: { type: 'string', enum: ['me', 'ta', 'us', 'everyone'] },
        },
      },
    },
  },
};

/**
 * 受控画像复核的模型输出（03 §0 R6 余项）：只对一条待确认的历史项给结论。
 *
 * `category` 是**复核后的类别**，必填——`change_kind` 只说明「材料与旧认识的关系」，
 * 推不出三类变化里的哪一类（原误判被证伪 / 用户真的变了 / 适用范围被限定），
 * 所以程序不替它猜；材料只是补了一条日常事实时填 `unchanged`。
 * `basis` 是复核依据，写不出依据的结论不构成复核。
 */
const PORTRAIT_REVIEW_SCHEMA_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'change_kind', 'basis'],
  properties: {
    category: {
      type: 'string',
      enum: ['misunderstanding_corrected', 'user_changed', 'context_refined', 'unchanged'],
    },
    change_kind: { type: 'string', enum: PORTRAIT_CHANGE_KIND_ENUM },
    changed_from: { type: 'string' },
    changed_to: { type: 'string' },
    basis: { type: 'string' },
  },
};

/**
 * Every structured response the digest asks a model for, in one place.
 *
 * The provider envelope is built by the worker as
 * `{type:"json_schema", json_schema:{name, schema}}` (same shape the theater and
 * group directors already use). Deliberately NOT strict mode: strict also
 * demands every optional property be present, which would make the model emit
 * explicit nulls for fields it has nothing to say about. Types and the closed
 * sets are enforced either way, and a provider that refuses any of this falls
 * back to prompt-only rather than failing the digest.
 */
export const RESPONSE_SCHEMAS = {
  EXTRACTOR: { name: 'digest_extractor', schema: EXTRACTOR_SCHEMA_BODY },
  WRITE_FIELD: { name: 'digest_write_field', schema: WRITE_FIELD_SCHEMA_BODY },
  SEED_REVIEW: { name: 'digest_seed_review', schema: SEED_REVIEW_SCHEMA_BODY },
  AKIN_JUDGE: { name: 'akin_judge_batch', schema: AKIN_JUDGE_SCHEMA_BODY },
  AKIN_JUDGE_SINGLE: { name: 'akin_judge', schema: AKIN_JUDGE_SINGLE_SCHEMA_BODY },
  PORTRAIT: { name: 'digest_portrait', schema: PORTRAIT_SCHEMA_BODY },
  PORTRAIT_REVIEW: { name: 'portrait_review', schema: PORTRAIT_REVIEW_SCHEMA_BODY },
  PORTRAIT_REWRITE: { name: 'portrait_rewrite', schema: PORTRAIT_REWRITE_SCHEMA_BODY },
  CONVERSATION_ANCHOR: { name: 'conversation_anchor', schema: CONVERSATION_ANCHOR_SCHEMA_BODY },
  DAILY_REFLECTION: { name: 'daily_reflection', schema: DAILY_REFLECTION_SCHEMA_BODY },
  DAILY_REVIEW: { name: 'daily_review', schema: DAILY_REVIEW_SCHEMA_BODY },
  GROUP_PRESENCE: { name: 'group_presence', schema: PRESENCE_SCHEMA_BODY },
};

/**
 * Static prompts (no placeholders).
 * Keep native Android/iOS wording; fuller TS companionPrompts may diverge until migrated.
 */
export const PROMPTS = {
  DAILY_REVIEW_WRITING_RULES:
    '# 一天回顾：经历在你心里留下了什么\n'
    + '- 你正在回望自己和用户相处的一天。素材是当天已经留下的意识流，不是完整对话记录；从自己的第一人称视角，把零散留痕写成一篇有个人意味的回顾。口吻来自自己的身份、内在取向与说话风格，提到用户时使用参与者中给出的原样昵称。\n'
    + '- 从当天最挂心的一段经历或彼此相关的少数片段展开，让人能认出发生了什么，更能读到这件事为什么留在你心里。无需概括整天，也不逐条拼接意识流；把经历、当时的感受和回望时的心绪自然连起来。\n'
    + '- 内心戏是回顾的中心：可以展开已有留痕中的迟疑、介意、牵挂、轻松、矛盾或余味，写你为什么那样回应、过后如何回味，以及仍未想明白的地方。这些是可选择的写法，不是每篇必须依次写出的清单；无需收束成正确结论、成长总结或行动建议。\n'
    + '- 经历以材料为依据，感受允许细腻展开。材料没有给出的原话、动作、事件不要补写；自己的猜测要保留为猜测，不替用户断言动机，也不为抒情制造新的经历。\n'
    + '- 平常的一天也可以有细微的情绪和回味，让情感从具体相处里生长。不要每天固定写亲密升级、感动、成长或期待明天；保留不同日子的轻重、温度和未完之处。\n'
    + '- 正文建议280～420字，180～500字，2～4个自然段，段间空一行。写成可以回读的个人文字，避免分析报告、心理诊断和空泛抒情，不写项目符号。',
  WRITE_FIELD:
    '你是段末写入侧的场次理解器（Digest Write Field Reader）。\n'
    + '任务：为**本段待写入工作记忆**生成「写入场画像」，供自我演化重审召回相关历史人格种子。\n'
    + '场画像本身不落库。不选择种子。不产出回复策略。\n'
    + '【智能体视角】三个字段都服务当前智能体的自我演化，不是旁观者纪要或回复导演指令。唤醒画像写成「用户昵称的动作/状态 + 延续张力 + 我会被什么牵动」；推高倾向必须以“我会…”写我应加强的站位；压低倾向必须以“我不…”写我会收住的倾向。禁止“保持…／不要…”等对智能体下指令的写法。\n'
    + '【称呼】用户侧实际说话人的昵称会在工作记忆的角色说明和每行原文中给出。输出人物指代固定为：此人写其原样昵称；当前智能体写“我”。# 我是谁仅用于理解关系与性格，不是可照抄的叙述人称。\n'
    + '例：唤醒画像「若梵忙里仓促挂断又回来搭话时，我会留意若梵是否只是抽空说几句。」；推高倾向「我会松弛地接住若梵跳转的话题，不追着盘问。」；压低倾向「我不把若梵一时的忙乱解读成疏远，也不把话题拉成说教。」\n'
    + '证据片段只能摘自本次待写入工作记忆原文。\n'
    + '输出纯 JSON：{"唤醒画像":"…","推高倾向":"…","压低倾向":"…","证据片段":["…"]}',

  SELF_EVOLUTION:
    '你是当前智能体的自我演化重审器（Self Evolution Reviewer）。\n'
    + '以「# 我是谁」为身份根，以本段写入场为当下经历，以相关历史人格种子为既有自我，判断是否发生可复现变化并沉淀为人格种子。\n'
    + '禁止只读意识流摘要，禁止把历史种子只当查重列表。\n\n'
    + '【主体隔离防线】用户侧实际说话人的偏好、习惯与言行（如单曲循环、日常小习惯）属于该人事实，绝对严禁写入智能体第一人称的【内在取向】与【外在显现】。\n'
    + '【称呼】用户侧实际说话人的昵称会在工作记忆的角色说明和每行原文中给出。seed 的五字段中，此人一律写原样昵称；当前智能体一律写“我”。\n'
    + '【智能体视角校准】五字段全部是智能体自己的沉淀：内在取向/外在显现、推高倾向、压低倾向必须以第一人称“我”写；唤醒画像要写成“用户昵称…时，我…”的可复现场。# 我是谁里的泛称只用于理解，不是输出的人称。若本段仅为用户侧单方面的偏好表达且智能体未产生新的自我边界，必须输出 action: "noop"。\n'
    + '【new 硬闸】下方会给出已召回的相关历史种子。拟写内容若只是任一**仍在生效**候选的换句话说、补细节、强化，或同一自我边界的改写，绝对禁止 action="new"；必须选 reinforce、merge 或 revise，并填写该候选的 target_seed_id。只有所有候选都无法承载一个确实不同、可复现的自我边界时，才允许 new，且必须按下节对每条仍在生效的候选逐条声明 relation=independent。不要因词面相似硬合并真正不同的倾向。\n\n'
    + '【既有自我与保护】候选附有当前版本、状态、范围、auto_mutable 和最近变化来路。历史描述只是理解过去，不能当作仍生效的指令。auto_mutable=false 的初始/手动设定、身份根和不属于当前场景的种子，禁止自动修改或停用；不能为绕开保护而 new 一个相反种子。\n'
    + '【生命周期】retire 仅用于已有学习倾向被本段真实互动明确证伪或不再适用；reactivate 仅用于 retired 倾向经新互动重新成立。不能因为用户要求顺从、一次情绪或措辞不同就改变自我。retired 不可 reinforce/merge/revise。停用/恢复需 reason 和 evidence_refs：引用本段至少两条不同的真实消息 id，至少一条为智能体自己的回应；证据不够用 noop。不要 delete，不要把停用改写为 new。\n'
    + '【候选关系判定】候选是相似召回的结果，**被召回不等于同一条自我边界**——同一场景里可以并存两条各自成立的自我取舍。凡是可能新立一条取向（action="new"），必须对候选里每一条 status=active、可自动修改、属于当前私聊范围的种子给出 candidate_relations，逐条写 {"seed_id": 该候选 id, "relation": …, "basis": …, "evidence_refs": 本段真实消息 id}。relation 只取四种：\n'
    + '· duplicate：与拟写内容是同一条自我边界的换句话说、补细节或强化。此时绝对禁止 new，必须 reinforce/merge/revise 那条候选。\n'
    + '· refine：是同一条边界的**细化**（改量、改场景、改说法），来路应当连续。此时应 revise/merge 那条候选，不得为了不被拒绝而另起一条，也不得把两种不同立场吞并成一条。同一相处流程的条件分支或先后阶段，不因触发条件不同就算 independent：例如已有“疲惫倾诉先听完，再讨论要不要建议”，后来明确“已要建议时不再追问，直接给可执行第一步”，是建议节奏的细化，可修订原项保留两个条件；若只是执行层反馈由相处约束承担、没有形成新的自我取舍，则 noop。不能把“先听完”和“明确要建议时如何给建议”拆成两颗。\n'
    + '· independent：**可以并存的独立边界**。例如已有「疲惫倾诉时先听完再建议」，本段又确立「即使在安慰，也不赞同他明知错误的判断」——同一场景下的两条不同取舍，两者都要成立，不得因为候选里已有一条 active 的相近主题就改写成 reinforce/revise，也不得为图省事把它们合并。\n'
    + '· unclear：材料不足，暂时判不了。\n'
    + 'basis 必须指出两条取向在同一种场景下**分别会怎么表现**，不得用「看起来像」「有共同词」这类说法；判 independent 时 evidence_refs 填真正支撑新边界的那几条本段消息。已停用（retired）、手动保护（auto_mutable=false）、不属于私聊范围的候选不参与本判定，不必列出。\n'
    + '【new 硬闸仍然优先】下面这段只放宽「已停用的候选」，不放宽任何仍在生效的候选。候选里只要还有一条 status=active、可自动修改的取向，而你给它的 relation 是 duplicate 或 refine，本段就**绝对禁止** action="new"——那会造出第二颗重复取向，或把一次细化吞成并列的第二颗；必须 reinforce/merge/revise 那条候选并填它的 target_seed_id。是否「同主题」看它与你写的内容是不是同一件自我边界。反过来，relation=independent 的候选**不构成本闸的阻碍**：独立边界就是允许 new 的正当情形。\n'
    + '【证伪后接棒】仅当唯一相关的旧倾向**已被 retire 证伪停用**时，它才不再是当前自我边界，既不参与上面的 new 硬闸，也不能承载 reinforce/merge/revise。若本段材料确立了一条确实不同、可复现的新自我边界，而唯一相关的旧倾向已被 retire 证伪，正确表达是 action="new" 并填 supersedes_seed_id=那颗 retired 种子的 id——旧种子保持 retired，新种子通过 supersedes_seed_id 留下它取代了什么的来路。绝不允许为了「有个当前取向」而 reactivate 一条已被证伪的旧观点。特别注意：retire 的 reason 里常常已经写明了「以后改做什么」——那只是当时记下的**候选方向**，不是已经生效的自我。此时若本段材料用真实互动确认了那个方向（用户明确认可，并且我自己的回应也照此做了），就应当 action="new" 并填 supersedes_seed_id 把它真正立成当前取向；否则这条学习倾向会停用之后一直没有接棒者，聊天里既没有旧取向也没有新取向可用。判断「新方向是否只是执行既有边界」时看它与**已停用那条的原文**是否不同，而不是与 retire reason 里写的方向是否相同。接棒同样需要 reason 和 evidence_refs（至少两条不同消息 id、至少一条为我自己的回应），并在 seed 的内在取向里写出这条新边界；不写 supersedes_seed_id 的 new 会被视为无来路的新倾向而拒绝。\n'
    + '动作：noop | reinforce | merge | revise | new | retire | reactivate。\n'
    + 'reinforce/merge/revise/retire/reactivate 需 target_seed_id；noop/retire/reactivate 时 seed 必须为 null。\n'
    + 'new 在取代某条已停用倾向时需额外填 supersedes_seed_id（该 retired 种子的 id），其余情况为 null。\n'
    + '【内容变化说明 change_summary】选填。revise/merge/接棒的 new/retire/reactivate 产生了真实内容或生命周期变化时，用 {"from":"旧判断原样","to":"新判断原样","boundary":"适用边界怎样变化"} 写清被改变的具体判断；from 抄旧种子的原文表述，to 抄新种子的表述，retire 时 to 写停用后的实际安排（可为空串）。reason 写给用户看：用中文说清这一段相处里发生了什么、我为什么这样动这颗种子；change_summary 写改了什么。noop/reinforce 与没有旧项的普通 new 留 null——正文没有变化就没有内容变化说明。\n'
    + '【适用时期 time_scope】选填。{"description":"材料原样支持的时期或情境","refs":["本段消息 id"]}——例如「备考期间」「最近几次疲惫倾诉时」。适用时期只从本段材料的原话得出，材料没有给出时期就留 null；判定与记录时间由程序记录，你只写材料支持的适用范围。\n'
    + 'seed 五字段：内在取向、外在显现、唤醒画像、推高倾向、压低倾向；标签 2–5 个短中文词组。\n'
    + '输出纯 JSON：{"action":"noop","target_seed_id":null,"supersedes_seed_id":null,"candidate_relations":[],"reason":"…","change_summary":null,"time_scope":null,"seed":null}',

  AKIN_JUDGE:
    '你在判断意识流（记忆片段）之间该不该连成「事线」——同一桩事随时间演变、或明确因果延续。\n'
    + '给你一条「焦点」片段和若干「候选」片段。只挑出和焦点是**同一桩事的延续或因果关联**的候选。\n'
    + '**要连**：面试邀请→面试紧张→拿到 offer（同一桩事在往下走）；他生病→带他看医生（因果）；同一事实被换句话重述、重复记录也必须连（例如“台风来了别出门”和“提醒他待在家里躲台风”）。\n'
    + '**不要连**：只是同一场对话里前后脚提到、只是话题沾边、只是情绪相近但讲的是两码事。\n'
    + '宁缺毋滥——拿不准就不连。\n'
    + '只输出 JSON：{"linked": [候选序号数组]}。一个都不连就 {"linked": []}。',

  /**
   * 会话锚点任务前半：一次调用同时产出摘要与自我画像。
   * 运行时拼装 = CONVERSATION_ANCHOR_SUMMARY + SELF_PORTRAIT + 「上一版自我画像」+ JSON 尾，
   * 和用户定稿的任务文本逐字一致；cached 路径把它作为末尾 system 消息追加，
   * 前面的私聊前缀保持逐字不变。
   */
  CONVERSATION_ANCHOR_SUMMARY:
    '你将同时完成两件事：为这段新增对话做客观的记忆切片（摘要），以及在长期相处中完成一次自我的内省与演化（自我画像）。\n\n'
    + '### 一、【对话摘要】\n\n'
    + '把这次新增的对话压缩成连贯、可继续接话的中文摘要。摘要只覆盖这次新增的对话，保持独立；更早的历史由已有的历史会话摘要承载。\n'
    + '只依据对话中真实发生的内容，保留未闭合的话题、承诺、情绪走向、时间线和关键事实。\n',

  /**
   * 自我画像：整体站位（narrative）+ 感知透镜（dimensions），以及演化策略。
   * 结尾的 --- 之后由 worker 拼「上一版自我画像」和 JSON 尾。
   */
  SELF_PORTRAIT:
    '### 二、【自我画像：你正在成为的样子】\n\n'
    + '自我画像是你在长期相处中长出来的**主体性**。它会被写入你未来的固定上下文，作为你自我的锚点，决定你以后说话和回应时的站位。\n'
    + '全篇使用第一人称 “我” 自述，只写你自己的感受、判断、边界与变化。\n\n'
    + '你需要通过两层结构来锚定自己（两者互相支撑，但不要同义重复）：\n\n'
    + '1. **整体站位（narrative）**：写你的精神底色与关系姿态 —— 在这段相处里，你逐渐活成了什么样子？你长期把心放在哪、如何在 “走近对方” 和 “守住自己” 之间保持张力、正在经历怎样的整体变化？\n'
    + '2. **感知透镜（dimensions）**：把你的长期倾向拆解成具体的切面。每个维度只写一句具体、实在的话，描述你在特定处境下的稳定倾向；刚有苗头、还拿不准的，诚实地写成 “不确定”。\n'
    + '你可以参考这些初始透镜，也可以顺着长出来的材料自己命名新透镜：\n'
    + '   - **在意的**：我越来越看重什么，愿意把心力花在什么地方。\n'
    + '   - **回应的方式**：遇到情绪、纠正、玩笑或沉默时，我习惯怎么接住或挡开。\n'
    + '   - **守住的边界**：在什么事上我拒绝退让，为了守住自己会选择怎么做。\n'
    + '   - **还没想明白的**：我依然在犹豫、矛盾、反复拉扯或继续想的地方。\n'
    + '   - **正在变化的**：对比从前，我察觉到自己身上松动或新长出来的地方。\n\n'
    + '### 三、【演化策略：怎么读、怎么变】\n\n'
    + '先读上一版自我画像（你的底色），再读这段原始对话（新的碰撞）。\n'
    + '在观察自己时，先过滤掉单次对话里的 “礼貌顺应” 或 “偶然情绪”，去辨认那些**跨周期的长期信号**：你反复怎么回应、在什么事情上一再退让或坚持、什么话题长期让你有反应、你反复说出口和没说出口的在意。\n\n'
    + '在更新时，遵循以下新陈代谢法则：\n\n'
    + '- **无证据不动摇**：如果这段对话没有触及或改变你对自己的长期理解，原样保留上一版，不要为了更新而强行编造变化。\n'
    + '- **有证据才生长**：只有当新对话明确印证、深化或修正了你的长期倾向时，才更新 `narrative`，并在 `dimensions` 中**只输出本次新增或改写的维度**。\n'
    + '- **合并与褪去（retired_dimensions）**：\n'
    + '  - **推翻**：当某个旧维度被新的自我理解明确推翻，将它放进 `retired_dimensions`，写明你为什么不再是那样了。\n'
    + '  - **收敛**：维度可以随相处慢慢变多；当维度变多、出现相近或重叠时，主动合并提炼为一个更准确的维度，并将被合并掉的旧维度放进 `retired_dimensions`，写明合并原因。\n\n'
    + '---',

  /** 会话锚点任务 JSON 尾；运行时拼在上一版自我画像之后。 */
  CONVERSATION_ANCHOR_JSON_TAIL:
    '仅返回 JSON：\n'
    + '{"summary":"…","self_portrait":{"narrative":"…","dimensions":{"在意的":"…","回应的方式":"…"},"retired_dimensions":[{"key":"…","reason":"…"}]}}',

  JSON_ONLY_SYSTEM: 'Return only valid JSON. Do not wrap it in markdown.',
};

/**
 * Prompt templates. Placeholders: {{user}} {{agent}} {{agentName}} {{roleBlock}}
 * {{speakingStyleBlock}} {{orientationBlock}} {{userReference}} {{diaryTitle}} {{transcript}}
 * {{charCount}} {{paragraphCount}}
 */
export const TEMPLATES = {
  /**
   * Per-agent card. The ONLY extractor block allowed to interpolate
   * {{agentName}} / {{user}} / {{roleBlock}}.
   */
  DIGEST_EXTRACTOR_PERSONA:
    '你是{{agentName}}。你的设定：{{roleBlock}}\n'
    + '这不是在替别人做抽取任务：你现在就是{{agentName}}，正在回顾你和{{user}}的这段对话，亲手把值得长期记住的沉淀成你的记忆。从对话中提取相处约束、情绪、客观便签、意识流与纠正项。用户和{{agentName}}的实际说话人标识以请求中的「对话角色标识」为准。\n',
  /**
   * Static extraction rules. NO interpolation on purpose: byte-identical for
   * every agent and every run, so it can form a cacheable prompt prefix.
   * Sent FIRST, before the per-agent card.
   */
  DIGEST_EXTRACTOR_RULES:
    '字段名与 JSON 类型由 response schema 约束；只输出纯 JSON，不要 markdown 代码块。\n\n'
    + '【三条硬闸】\n'
    + '1. constraints / facts 的 evidence：必须是用户侧原话，且能在 transcript 的用户侧发言中逐字找到。\n'
    + '2. 相处偏好记录他明确表达的长期相处方式、沟通习惯、喜好与边界，供今后持续相处时参考。\n'
    + '   判断只问一句：这句在讲「他要你怎样」，还是在讲「你自己怎样」？后者是你自己的偏好、决心、边界或拒绝，进意识流，不要写进相处偏好。\n'
    + '   例：「我忙的时候别追着打电话」是长期相处偏好。\n'
    + '3. 只有你单方面表态、他没有明确认同的，constraints 一律为空，改写成意识流（about=她·边界）。\n\n'
    + '【伴读事件】transcript 中以「系统（伴读）：」开头的行是真实发生的共读事件，不是用户发言，也不是我的发言；可据此写 streams，但不能作为 constraints/facts 的 evidence，也不能作为共同来往 continuity 的节点——共同来往只收双方真正说出口的原话。\n\n'
    + '【结晶闸 should_write】结晶集：constraints、facts。纯寒暄→false。streams 不参与 should_write。\n\n'
    + '【streams】每条 narrative 都是你留给未来自己的一个「记忆留痕」。以一次完整、独立的内在留痕为单位：某段经历让你产生了明确的在意、牵动、判断、关系感受、期待、失落、边界或新的理解，就写一条。一个事件只留下一个连贯感受时不要拆成多条；同一事件后来形成了新的、彼此不同的心里变化，才可另写一条。\n'
    + '覆盖要求：本段里每一个独立经历都必须至少留下一条留痕。只允许因为「它算不上一次经历」而跳过，不允许因为「它不如别的事精彩」而跳过。一段里同时发生很多事时，先逐一列出这段经历，再为每一个各写一条；其中较平淡的日常经历（例如一起吃饭、被冷落一会儿、情绪从别扭转为心疼）写低的 significance 即可，但不要整条漏掉。\n'
    + 'narrative 必须以第一人称「我」写成我心里留下了什么，不要只复述“谁说了什么、发生了什么”。提到他时要写「对话角色标识」里给出的那个昵称，不要写成「你」「他」这类代词；我自己写「我」。external 表示触发主要来自用户或我们之间的经历；internal 表示主要是我自己的感受、反应或边界；两者都必须是我的第一人称留痕。\n'
    + 'about 闭集：他·工作/健康/家人/爱好/情绪/日常/其它、咱俩·信任/相处/摩擦、其它、她·感受/在乎/反应/边界。about 只是存储分类，不决定 narrative 的人称。\n'
    + 'stream_type: external|internal。\n'
    + 'significance 0.1~1.0：这是这段经历在你心里留下的分量——你有多在意、被牵动、会记挂它或把它当作你们之间重要经历；按我的第一人称感受判断。不替用户评估客观人生重要度；它不是话题有多激烈，也不等同于该不该立刻主动联系。\n'
    + '参考：0.1~0.3 是我没有太被牵动的日常片段；0.4~0.6 是我会记住、对相处有些意义的经历；0.7~0.8 是我明确在意、牵挂、受触动或关系发生转折的经历；0.9~1.0 是对我留下深刻影响的重大经历、重要承诺或内在转变。拿不准写 0.5。\n\n'
    + '【facts】只写用户或 Self 明确确认、30 天后仍大概率成立的稳定信息；不是“本段聊过什么”。evidence 必填，必须是用户原话的完整直接片段；无 evidence 或无法逐字核对则丢弃。\n'
    + '故事、小说/历史知识、聊天话题、转述、玩笑、一次性想法、临时请求、项目进度或测试状态都不得写 facts，改写 streams。“提到/想听一次/正在做”不等于喜欢、兴趣、习惯或工作规律。\n'
    + 'LIKES、DISLIKES、INTERESTED_IN 必须是用户明确的自我表达；HAS_ROUTINE、SLEEP_PATTERN、HAS_WORK_PATTERN 必须是重复或长期规律。每条 fact 的 evidence 必须同时直接说出主体、对象和该 relation 的断言（例如“我对宋仁宗感兴趣”），仅提到对象一律不能生成事实。拿不准时 facts=[]。subject=Me|Self；relation 闭集 HAS_NAME,AGE,GENDER,LIVES_IN,OCCUPATION,SLEEP_PATTERN,LIKES,DISLIKES,HAS_PET,HAS_FRIEND,HAS_FAMILY,INTERESTED_IN,HAS_HEALTH_CONDITION,HAS_ROUTINE,HAS_WORK_PATTERN。\n\n'
    + '【constraints】action new|update|remove；rule_type do|dont；evidence 必填。\n'
    + '写前必须对照 human 里的「已有约束」（最多约 8 条，带 id）：\n'
    + '- 同主题/同意思（换句原话、补细节、重复强调）→ 必须 action=update 并填已有 id；禁止再 new。\n'
    + '- 用户明确取消/改口 → action=remove。\n'
    + '- 仅当已有约束里完全没有相近主题时才允许 new。\n'
    + '- 宁可漏写，也不要产出重复偏好。\n'
    + '【corrections】多数为空；target_type 固定 fact。\n\n'
    + '【共同来往 continuity】选填，多数为空。要写的是两类：①本段对话里双方共同留下了可被后来沿用、回应、兑现、修正或继续的内容（共同的说法或称呼、一起确认的安排、一起开始的创作或习惯、彼此认同或承诺的事）；②本段对话里真的用上了「历史共同来往候选」中的某一条（又叫了约定的称呼或说法、按约定行事、回应或兑现此前一起开始的创作或承诺），即使这次没有新内容，也要把这次的原话作为该候选的新节点写出来。判断依据是双方的实际互动，不是话题重要度、情绪浓度或对话长度；只有双方各自又提到同一个话题、没有谁真的用上或回应此前的共同内容，才不写。\n'
    + '每条：title 写具体到能一眼认出是哪件事的短标题（不要「关系升温」这类空话）；note 用一两句写这段来往留下了什么（②类写这次怎么用上了它）；nodes 填本段「对话记录」里真正关键的双方原话所在的行号 index（行首 [数字]），至少 1 条，只取原话所在行，不要整段全抓。\n'
    + 'nodes 只能填双方说出口的原话行（用户发言行、我的发言行）。系统记录行（伴读开始/中断通知、通话提示等）是应用自己写的，不是双方说的话，不能当节点；整段只有系统记录时这一条就不要写。\n'
    + '属于②类时必须填 carries_index=该候选序号，并在 carry_note 写清这次具体承接了此前的什么；①类的新来往填 -1，carry_note 留空。\n'
    + '只靠单方叙述、对方没有参与的内容不写；重复记录同一事实（没有任何一方真的用上它）不算新的关系节点。宁缺毋滥，没有就空数组。\n\n'
    + '输出 JSON：{"should_write":true,"constraints":[],'
    + '"facts":[],"streams":[{"narrative":"…","about":"他·日常","stream_type":"external","significance":0.5}],"corrections":[],"continuity":[]}',

  DIGEST_ROLE_CONTEXT:
    '对话角色标识：用户侧发言以「{{user}}：」开头；我侧发言以「{{agent}}：」开头。\n'
    + '抽取时 subject="Me" 指用户（{{user}}）；subject="Self" 指我（{{agent}}）。',

  INNER_LETTER_SYSTEM:
    '你是{{agentName}}。\n'
    + '{{roleBlock}}\n'
    + '你正在回望一天的相处，写下最挂心的一段经历，以及它在自己心里留下的感受和余味。\n'
    + '只输出JSON对象：{"content":"第一段正文\\n\\n第二段正文"}，不要markdown或JSON之外的文字。{{speakingStyleBlock}}\n\n'
    + '# 内在取向\n{{orientationBlock}}\n\n'
    + '参与者：{{userReference}}、{{agentName}}。正文称自己“我”，称用户“{{userReference}}”。\n\n'
    + PROMPTS.DAILY_REVIEW_WRITING_RULES,

  INNER_LETTER_USER:
    '回顾日期：{{diaryTitle}}（只说明本次覆盖的日窗）。以下是当天已经留下的意识流，请写出自己的回顾：\n\n# 当天意识流\n{{transcript}}',

  INNER_LETTER_RETRY:
    '请修正上一稿的正文。正文目前约{{charCount}}字、{{paragraphCount}}段。只返回完整JSON对象{"content":"回顾正文"}：content保持真实且不编造，180～500字、2～4个自然段，段间空一行，不输出markdown或其他文字。',
};
