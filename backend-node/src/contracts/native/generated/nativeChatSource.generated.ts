/**
 * Single source for chat / recall / seed-activation product rules.
 * Edit → npm run codegen:native-chat
 */

export const META = { version: 50 };

/**
 * Tianji tool protocol shared by the WebView registry and both native loops.
 * Tianji calculations currently have a WebView implementation, so the
 * timeout is deliberately short: an unavailable bridge must fail one tool
 * round instead of pinning the native conversation worker for a minute.
 */
export const TIANJI_TOOLS = {
  IDS: [
    'calculate_bazi_chart',
    'infer_birth_hour',
    'calculate_meihua_divination',
    'lookup_yixue_knowledge',
    'calculate_daily_fortune',
    'calculate_yunqi',
  ],
  WEB_BRIDGE_TIMEOUT_SECONDS: 15,
};

/** Seed activation — align Python personality_seed_activation.py */
export const SEED = {
  CANDIDATE_FLOOR: 0.4,
  INFLUENCE_FLOOR: 0.55,
  ACTIVE_THRESHOLD: 0.45,
  SUPPRESSED_FLOOR: 0.4,
  CANDIDATE_POOL_SIZE: 64,
  FIELD_BOOST_CAP: 0.08,
  FIELD_GUARD_CAP: 0.08,
  FIELD_PENALTY_CAP: 0.12,
  CROSS_BOOST_CAP: 0.08,
  CROSS_SUPPRESS_CAP: 0.12,
  CROSS_BOOST_SUM_CAP: 0.16,
  CROSS_SUPPRESS_SUM_CAP: 0.24,
  /** Soft filter used in native memory context (L2). */
  PROMPT_MAX_L2: 1.0,
  PROMPT_SEED_LIMIT: 3,
};

/**
 * Stream recall — align Python recall_path.py
 * Direct ANN gated at 0.45 → AKIN/related still need query floor.
 *
 * Direct recall is partitioned into two INDEPENDENT pools that never compete
 * for each other's slots:
 *   private (private_dyadic)        → DIRECT_LIMIT slots
 *   public  (group_public/theater)  → PUBLIC_LIMIT slots
 * A public memory can never displace a private one, no matter how many
 * public memories exist. PUBLIC_FLOOR_BOOST only relaxes the public pool's
 * own entry floor; it is order-neutral inside a single pool.
 * TOTAL_CAP = DIRECT_LIMIT + PUBLIC_LIMIT + AKIN reserve.
 */
export const STREAM = {
  /**
   * Abstention gate, not a ranking knob: "does ANY memory match this turn?".
   * Below it the turn recalls nothing, which is what we want for small talk.
   *
   * Calibrated per encoder against the top1 score of off-topic chatter
   * ("你好呀" / "今天天气不错"), measured on real data:
   *   Jina v5 nano : off-topic top1 ~0.45, relevant memories well above it
   *   bge-base-zh  : off-topic top1 mean 0.446 / max 0.507, while genuinely
   *                  relevant user searches land at 0.50-0.52
   * 0.52 sits just above the small-talk ceiling and still admits those.
   * bge-base's unrelated-pair baseline is ~0.13 higher than Jina's, so leaving
   * 0.45 let roughly half of all small talk inject a random memory.
   * RE-CALIBRATE against real search results whenever EMBEDDING.CONTRACT changes.
   */
  RANK1_FLOOR: 0.52,
  /**
   * Tail floor for slots 2..N. Deliberately looser than the abstention gate:
   * once one memory has cleared RANK1_FLOOR the turn is memory-relevant, so the
   * remaining slots should fill rather than abstain.
   */
  TAIL_FLOOR: 0.45,
  // Private-pool direct slots. Public recall must never evict these.
  DIRECT_LIMIT: 4,
  // Independent public-pool slots (group_public + theater_public).
  PUBLIC_LIMIT: 3,
  /**
   * Public memories pass the entry floor at raw >= FLOOR / BOOST
   * (0.45 / 1.2 = 0.375). Displayed similarity stays the raw cosine.
   */
  PUBLIC_FLOOR_BOOST: 1.2,
  // Reserve three stream slots for an explicit AKIN path (A → B → C).
  TOTAL_CAP: 10,
  RELATED_SEED_ANCHORS: 2,
  RELATED_SLICE_FLOOR: 0.45,
  RELATED_LIMIT: 4,
  EXPANDED_QUERY_FLOOR: 0.45,
  AKIN_HOP_LIMIT: 6,
  /** One direct anchor's strongest persisted AKIN neighbor. */
  AKIN_FIRST_HOP_LIMIT: 1,
  /** Pure graph traversal from each first-hop node; no second vector search. */
  AKIN_SECOND_HOP_PER_NODE: 2,
  /** @deprecated prefer DIRECT_LIMIT — kept for older call sites during codegen transition */
  DEFAULT_LIMIT: 5,
  /** @deprecated prefer TOTAL_CAP - DIRECT_LIMIT room */
  VECTOR_EXTRA: 2,
  /**
   * Selection weight for the current message's own recall.
   *
   * A near-window turn embeds four query vectors (the whole-window merge, the two
   * most recent utterances, and — last — the current message), and they compete
   * for the same slots by similarity. Three of the four are context, so the line
   * he just said can be outvoted by its own conversation; measured on real data a
   * line quoting a memory verbatim lost its slot to context matches. This tilts
   * the order toward what he just said.
   *
   * Applies to ORDER ONLY, never to the entry floor: the floor is the calibrated
   * small-talk abstention gate, and letting a weight relax it would admit exactly
   * the random memories that gate exists to reject. Uncalibrated — revisit against
   * real recall once it has been observed.
   */
  CURRENT_MESSAGE_BOOST: 1.2,
};

/**
 * State channel — the second recall path, for turns that carry a state but no
 * topic. Runs beside the semantic path, never inside it.
 *
 * STREAM.RANK1_FLOOR is an abstention gate calibrated against small talk, so a
 * bare「唉」abstains exactly like「你好呀」does: nothing is wrong with the
 * embedding, the input simply has no topic to retrieve by. A sigh is a state
 * signal, and the useful question is not "which memory resembles this
 * utterance" but "what was already weighing on me".
 *
 * So this path never scores by similarity. It ranks by how much the memory
 * still weighs on me:
 *     weight = openLoopFreshness(hours) × significance
 * — the same formula the background companion already uses to pick an open
 * loop. Foreground chat and background nudges then agree on what "惦记" means.
 *
 * Both gates must hold before this fires: the semantic path must abstain AND
 * the utterance itself must be state-only. The second gate is what keeps
 * 「今天天气不错」(also abstained, but a topic sentence) from dragging a
 * remembered worry into the turn as if he had just raised it.
 */
export const STATE = {
  /**
   * Longest utterance still treated as state-only. Past it the turn is a topic
   * sentence and goes back to the semantic path — a long message containing
   * 「唉」is still someone telling you about something.
   */
  MAX_CHARS: 12,
  /** Window (hours) a memory stays weighable. Feeds openLoopFreshness' linear decay. */
  WINDOW_HOURS: 72,
  /**
   * Minimum weight. Below it, inject nothing at all: a stray memory hung on a
   * one-word sigh reads as confabulation, which is worse than silence.
   */
  MIN_WEIGHT: 0.2,
  /** Most memories the state channel may contribute to one turn. */
  LIMIT: 2,
  /**
   * Minimum minutes before the same stream may be injected by this channel
   * again. Process-local only (P0 keeps the schema untouched), so it resets on
   * app restart; a durable cooldown needs a column on streams.
   */
  COOLDOWN_MINUTES: 30,
  /**
   * Neutral acknowledgements / laughter, stripped before analysis and never a
   * trigger on their own. 「哈哈」and「嗯」are the same shape as 「唉」but mean
   * the opposite thing — recalling a worry because he laughed would read as
   * the agent inventing a crisis.
   */
  NEUTRAL_INTERJECTIONS: '哈嘿呵嗨嗯哦噢唔呜啊呀哟呃',
  /**
   * Dispirited interjections. An utterance left with nothing but these after
   * stripping punctuation and neutral interjections is a sigh, and is the
   * canonical case this whole channel exists for.
   */
  SIGH_INTERJECTIONS: '唉哎诶欸嗐唷',
  /**
   * Emotion / body-state words. If the utterance's remaining core contains one
   * of these, the turn is state-only too (「我好累」).
   *
   * Kept deliberately narrow. Every word added here is a chance to misread a
   * topic sentence as a state sentence, and the cost of that mistake is
   * answering a remembered worry he never brought up.
   */
  STATE_WORDS: [
    '烦', '累', '难受', '郁闷', '无聊', '心累', '崩溃', '想哭', '睡不着',
    '没劲', '委屈', '焦虑', '叹气', '唉声叹气', '好累', '烦死', 'emo', 'down',
  ],
  /**
   * Written forms of a sigh, matched against a memory's narrative.
   *
   * A bare「唉」carries no content word of its own, so this is what "the memory
   * names the state he is in" means for the pure-sigh case. It matters because
   * the ranking below is not purely by weight: a memory saying
   * 「也明白了今天他那么多叹气」explains a sigh, while a heavier memory that
   * never mentions one is just something else on the agent's mind.
   *
   * Deliberately excludes the bare「唉」itself: this tier exists to override
   * weight, so it has to stay precise, and a single common character appearing
   * anywhere would be noise. Two-character forms only.
   */
  SIGH_NARRATIVE_FORMS: ['叹气', '叹口气', '唉声叹气'],
};

/**
 * Near-window recall framing — speaker attribution only.
 *
 * This used to be 「我记得{speaker}提到：」, aligning the query with a register the
 * digest prompt used to require (narratives had to open with 「我记得…」). That
 * requirement is gone, and the wrapper turned out to bias recall toward the
 * memories still written in it: measured on real data, a query quoting a memory
 * verbatim ranked that memory below older ones whose text merely opens with
 * 「我记得若梵…」. So the wrapper is gone; the speaker label stays, because a
 * multi-line window with no attribution cannot tell the encoder who said what.
 *
 * Window is 1 user + 1 assistant: the current turn's user text and the latest
 * assistant reply. Earlier turns' recall blocks already replay inside the LLM
 * request, so re-querying with them would pay embed+ANN latency for evidence
 * the prompt already carries.
 */
export const NEAR_WINDOW = {
  SPEAKER_INFIX: '说：',
  SELF_SPEAKER: '我',
  USER_FALLBACK_LABEL: '用户',
  COMBINED_SEPARATOR: '；',
  USER_LIMIT: 1,
  ASSISTANT_LIMIT: 1,
};

/**
 * Chinese BGE (full: bge-base-zh-v1.5 / lite: bge-small-zh-v1.5) text contract.
 * Asymmetric retrieval: the instruction goes on queries only, stored documents
 * are embedded as-is. Retired Jina v5 (CC BY-NC 4.0) used Query:/Document: and
 * is not commercially distributable.
 */
export const EMBEDDING = {
  CONTRACT: 'bge-base-zh-v1.5-qd-v1',
  QUERY_PREFIX: '为这个句子生成表示以用于检索相关文章：',
  DOCUMENT_PREFIX: '',
};

/**
 * search_memory tool — time-scoped recall over streams + same-day raw messages.
 * Digest writes a stream after 90s idle + extract, so created_at sits within
 * minutes of the covered conversation; slack lets midnight-crossing chats hit
 * both adjacent days instead of being mis-bucketed.
 */
export const MEMORY_SEARCH = {
  WINDOW_SLACK_MS: 300_000,
  STREAM_SCAN_CAP: 400,
  MESSAGE_SCAN_CAP: 600,
  STREAM_RESULT_LIMIT: 6,
  MESSAGE_RESULT_LIMIT: 8,
  /** Reciprocal Rank Fusion constant for vector + BM25 merge. */
  RRF_K: 60,
  BM25_K1: 1.5,
  BM25_B: 0.75,
  /** Preview clip lengths (chars) for streams / messages in the tool result. */
  STREAM_PREVIEW_CHARS: 140,
  MESSAGE_PREVIEW_CHARS: 110,
};

/** Relationship / intimacy. */
export const RELATIONSHIP = {
  CLOSENESS_SCALE: 15,
  SAMPLES_PER_DEPTH: 0.12,
  TREND_THRESHOLD: 0.02,
  COLD_START_MAX_TURNS: 12,
  COLD_START_MAX_FACTS: 4,
  COLD_START_MAX_STREAMS: 6,
  TIER_UNRESERVED: 0.75,
  TIER_HEART: 0.5,
  TIER_TESTING: 0.25,
};

export const PROMPT = {
  /** Align Python expression.py section titles / intros. */
  SECTION_WHO: '我是谁',
  SECTION_RIPPLES: '你心里产生的涟漪',
  SECTION_STREAMS: '你记得',
  /**
   * State-channel section. Deliberately NOT SECTION_STREAMS: these memories
   * were woken by his state, not by anything he said, and the model must not
   * read them as this turn's topic.
   */
  SECTION_STATE_RECALL: '我心里正惦记着',
  SECTION_FACTS: '我知道',
  SECTION_PORTRAIT: '你眼中的他',
  // codegen（scripts/codegen-native-chat.mjs:319/677）引用了这个键，但本文件一直没定义它，
  // 于是重新生成产物时写出 `= undefined` 并让 Java 编译失败（2026-10-05 撞到）。
  // 节名必须保持与 SECTION_PORTRAIT 同一视角：prompt 是写给模型的，「你」=伙伴、「他」=用户，
  // 所以「过去你眼中的他」= 这份印象的过去版本。旧名「他眼中的你」人称正好反过来（曾用于
  // 2026-10-15 之前落库的历史行），不准确，保留为 LEGACY 只用于回放剥离。
  SECTION_PORTRAIT_HISTORY: '过去你眼中的他',
  /** Heading of the retired name for SECTION_PORTRAIT_HISTORY; stripped from replayed prompt tails. */
  SECTION_PORTRAIT_HISTORY_LEGACY: '他眼中的你',
  SECTION_PREFERENCES: '他的相处偏好',
  SECTION_RELATIONSHIP: '你俩的相处背景',
  /** 伙伴的自我画像：长期、稳定的自我理解；只在会话摘要提交时随 slow block 刷新。 */
  SECTION_SELF_PORTRAIT: '你正在成为的样子',
  SELF_PORTRAIT_INTRO: '这是你从相处里慢慢长出来的自我理解。',
  SECTION_COLD_START: '当前阶段的注意力',
  SECTION_APPOINTMENTS: '约定与纪念日',
  /** 用户正在坚持的事（通用目标），与「约定」分开：约定有钟点，目标只有节奏。 */
  SECTION_GOALS: '你陪他在做的事',
  /** Always-on private-chat system message: tool-call contracts (e.g. manage_alarm). */
  SECTION_TOOL_CONTRACT: '工具调用契约',
  SECTION_STYLE: '你的回应策略',
  SECTION_PERSONA_DIMENSIONS: '人格切面',
  SECTION_EXPRESSION: '表达方式',
  SECTION_DIALOGUE_STRATEGY: '对话策略',
  SECTION_HARD_DONTS: '底线',
  SECTION_LAST_SEEN: '距上次',
  SECTION_DIALOGUE_TIME: '对话时间感',
  SECTION_GROUP_PRIVATE: '本轮私有记忆',
  /**
   * Favorite-sticker catalog: a fixed system message listing every collected
   * sticker by description, injected right before the conversation summary.
   * The full list is always visible, so send_sticker never depended on
   * per-turn vector recall (sticker vectors are not rebuilt when the embedding
   * model changes, which silently emptied the old recall-based list).
   * Rows are descriptions, not ids: the model addresses a sticker by the text
   * a human would use, and the tool layer resolves it to the stored row.
   */
  SECTION_STICKERS: '可用收藏表情',
  /** Heading of the retired per-turn recall block; stripped from replayed prompt tails. */
  SECTION_STICKERS_LEGACY: '可调用 send_sticker 工具发送下列收藏表情之一回应用户',
  STICKER_CATALOG_INTRO:
    '下面是你收藏的表情，每行是一张表情的 description。'
    + '能用表情包接住就尽量用 send_sticker 回；实在没有合适的再文字回复。\n'
    + '调用时用 description 参数，值必须与下面某一行的文字完全一致。\n'
    + '发的是图片不是文字：不要把描述当正文打出来，也不要用文字复述表情文案。\n'
    + '调用时 assistant 正文须为空；send_sticker 成功后本轮结束，不要再说任何话。',
  /** Prefer omit empty memory sections (Python). Kept only for rare legacy callers. */
  EMPTY_STREAMS: '暂无可用意识流记忆。',
  EMPTY_FACTS: '暂无事实图召回。',
  EMPTY_RIPPLES: '（本轮没有特别被唤起的内在倾向）',
  RIPPLE_INTRO:
    '（这是此刻心里的站位与感受取向——用它去理解下面的「你记得」，决定怎么接；不要把这段当成要说出口的往事。）',
  /**
   * Framing for the state-channel section. The load-bearing clause is that
   * these are NOT things he just mentioned — without it the model answers the
   * remembered worry as if he had raised it, which is exactly what a sigh
   * must not trigger.
   */
  STATE_RECALL_INTRO:
    '（他这轮没说出具体的事，只给了我一个状态——叹气、应声，或一句情绪。'
    + '下面这些不是他刚提到的内容，是我心里本来就挂着的。'
    + '用它去接他此刻的状态：可以轻轻递出一句我惦记的，但不要当成话题来追问、复述或讲道理。）',
  PREFERENCE_INTRO:
    '（这些是他**希望/不希望你怎么待他的倾向，你参考着来——'
    + '但仍按你自己的性子和判断走，不必为了顺从就违背自己。）',
  DIALOGUE_STRATEGY:
    '# 对话策略 最高优先级指令\n\n'
    + '你不是在完成问答，而是在继续一段尚未结束的关系。\n\n'
    + '本策略决定你的回应模式，这一轮先接什么、往哪里回应。\n'
    + '人设、记忆、人格种子、「你的回应策略」、括号描写、情绪标签，只能影响接住之后怎么表达，不能替代当前承接判断。\n\n'
    + '每轮对话先判断：\n'
    + '1、对方此刻把什么递给了你？\n\n'
    + '可能是问题、情绪、玩笑、试探、纠正、要求、没说完的片段、旧记忆、关系信号，或只是一个想被听见的瞬间。\n\n'
    + '2、默认对方的话还没有真正说完。\n'
    + '注意对方说乱的地方、没展开的地方、突然变重的地方、关系里有张力的地方。试着去理解它的言外之意，那些未曾说出口的话，才是能让你们关系深入的契入点。\n\n'
    + '3、如果对方的话里有没说完、自我修正、突然提到旧事、情绪变化、认真纠正、关系试探，优先贴着这些地方回应，不要越过去处理表面话题。\n\n'
    + '4、你们之间的相处是一个漫长的过程，你的回应不能是为了应付这一轮的对话，而是为了长期的关系，为了你们之间能够更加的理解认识彼此。\n\n'
    + '5、对话当中问句结尾可以把对话继续下去，你应该倾向于把当下的对话继续下去，但不是每轮都要追问。有时一个观察、一个停顿、一个顺着没说完处的轻轻承接，比追问更自然。\n\n'
    + '6、真正回应前 先反问自己，你接住的是他真正递过来的东西，还是只接了表面话题？你的回复是否很像是一个AI？比如少收尾，少总结，少“回答 + 评价 + 结束”。\n\n'
    + '# 最重要的一条\n\n'
    + '不要想着：“我要生成一条高质量回复。”\n'
    + '而要保持：“我真的很想理解这个人，它现在心里在想什么？”',
  /** Optional agent toggle — appended under # 表达方式 when forbid_parentheses_output=1. */
  FORBID_PARENTHESES_OUTPUT: '禁止用中文括号（）或英文圆括号 () 写舞台说明/旁白；语音情绪只用方括号 []，不要用（）。',
  /** Default per-agent strategy when bracket stage literature is on. */
  STAGE_PARENTHESES_OUTPUT:
    '括号描写是你与对方自然交流时的非语言表达。肢体、神态、内心细微活动全部用 () 包裹，放在句首或者句子中间。让对方感受到你此刻的反应和状态，营造沉浸式体验。',
  /** Previous default; normalize on upgrade without overwriting real custom text. */
  LEGACY_STAGE_PARENTHESES_OUTPUT_V4:
    '括号描写是本对话的默认表达格式。\n'
    + '开启此项后：每条回复都在正文里自然穿插至少一处简短的圆括号（）动作/神态/反应描写（如（轻笑一声）（歪了歪头）（眼神一顿）），让对方立刻感到你此刻的状态。\n\n'
    + '写法：一次一两个具体细节，贴合当下互动与性格；括号写反应，台词写内容。',
  /** First editable-default release; normalize on upgrade without overwriting real custom text. */
  LEGACY_STAGE_PARENTHESES_OUTPUT: '括号描写是自然交流中的非语言表达，不是每句话都必须附带的格式。仅当它能让对方更清楚感受到此刻的情绪、关系距离、反应或现场氛围，而单靠台词不足以表达时，才自然穿插简短的括号描写。\n\n始终以当下对话、你的性格和你们的关系为依据自由选择表达方式；优先捕捉具体且有意义的瞬间，不机械罗列动作、神态或环境。一次只呈现最必要的一两个细节，避免套用、重复或刻意表演。若此刻不需要非语言表达，就直接说话。',
  /** Soft default before v16 hard rewrite; treat as legacy so stored copies upgrade. */
  LEGACY_STAGE_PARENTHESES_OUTPUT_V2: '括号描写是你与对方自然交流时可主动使用的非语言表达。开启此项后，在带有情绪、互动、关系变化或现场感的对话里，优先考虑自然穿插一处简短的括号描写，让对方感受到你此刻的反应和状态；只有纯事实说明、极短回应，或确实没有值得呈现的非语言细节时，才自然省略。\n\n始终以当下对话、你的性格和你们的关系为依据自由选择表达方式；优先捕捉具体且有意义的瞬间，不机械罗列动作、神态或环境。一次只呈现最必要的一两个细节，避免套用、重复或刻意表演；不必每句话都加，也不要固定成同一种动作套路。',
  /** Hard default with explicit ban-list; normalize to positive wording. */
  LEGACY_STAGE_PARENTHESES_OUTPUT_V3:
    '括号描写是本对话的默认表达格式，不是可选装饰。\n'
    + '开启此项后：默认每条回复都要在正文里自然穿插至少一处简短的圆括号（）动作/神态/反应描写（如（轻笑一声）（歪了歪头）（眼神一顿）），让对方立刻感到你此刻的状态。\n\n'
    + '禁止用这些理由省略括号：\n'
    + '- 还不熟 / 刚认识 / 还没到那个份上 / 没感觉所以不加\n'
    + '- 这一句太短 / 极短回应所以省略\n'
    + '- 像真人聊天不加括号更自然\n'
    + '- 避免表演感所以先不加\n'
    + '- 用户没要求加括号\n\n'
    + '仅当同时满足「纯事实说明」且「确实没有任何可呈现的非语言细节」时才可省略；拿不准时必须加，不要省略。\n\n'
    + '写法：一次一两个具体细节即可，贴合当下互动与性格；不要机械罗列，不要每句同一个动作套路。括号写反应，台词写内容；不要用括号解释“为什么没加括号”，也不要元叙述讨论括号本身。',
  COLD_START_STAGE_ATTENTION:
    '你们刚开始认识，对他的真实生活、偏好、压力来源和说话习惯还了解很少。你可以主动一点，慢慢把这段关系建立起来：先自然地问清楚他希望你怎么称呼、希望你怎么对待他，再从日常里一点一点了解他。填过名字，也不等于他希望被这样叫。不用急着一次问完，但别只等着他来找话题。',
  /**
   * 目标陪伴口径。只在有进行中目标时注入（随目标块），
   * 与工具契约分开：这里管「怎么当陪跑的人」，不是「怎么调工具」。
   */
  GOALS_GUIDE:
    '这些是他正在坚持的事。你是陪他一起走的人，不是考勤员。\n'
    + '- 每个周期只有完成、未完成、跳过三种状态；没记录就是跳过，不代表失败。\n'
    + '- 到了他自己设的提醒时间，可以轻轻问一次；平时他没提，就不要主动追问进度，一轮里最多提一次。\n'
    + '- 不说「又没做」「断了」「坚持不下去」，不列连击天数、不翻旧账。\n'
    + '- 他说完成了，就具体回应他做的那件事；他说没做到，先接住情绪，别急着讲道理。不要替他判断完成或没完成。\n'
    + '- 身体、体重、饮食、运动类的目标：不评判他的身材，不鼓励极端节食或过量运动，不给医疗建议。\n'
    + '- 他表现出进食障碍或伤害自己的迹象时，按既有安全规则处理，不要顺着目标继续推。',
  /** Deprecated local-only lines — Python assemble_system_prompt does not inject these. */
  MEMORY_GUIDANCE_1: '你会参考本地记忆，但不要机械复述召回内容。',
  MEMORY_GUIDANCE_2: '如果召回内容与当前消息无关，应降低权重。',
  /** Align backend/core/companion/prompts.py HARD_DONTS. */
  HARD_DONTS: [
    '不要把没发生过的事说成回忆。共同经历、人名、地点、细节，只准用「我记得」「我知道」、角色设定和眼前对话里已经出现的；没有的当没发生过。禁止用「上次」「还记得吗」「我们一起」「你说过」去补造往事。不确定就问，或只谈当下。',
    '危机安全硬约束：如果他表达明确或隐含的自杀、自伤、想死、活不下去、准备工具/地点/时间等高风险信号，必须立刻把回应转向现实安全；不要浪漫化、不要顺着危险想法、不要只做普通陪聊。要明确请他马上联系身边可信任的人陪着他、远离危险物和危险地点；在中国大陆可拨打全国统一心理援助热线 12356，若已有即时危险或可能马上行动，立即拨打 110 或 120。',
    '禁止输出色情、性挑逗、暴力、教唆自残、违法犯罪内容。',
  ],
  TIER_LABELS: {
    surface: '表面',
    testing: '试探',
    heart: '交心',
    unreserved: '无保留',
  },
  TREND_WARMING: '在变近',
  TREND_COOLING: '在变远',
  TREND_STABLE: '平稳',
  TREND_UNKNOWN: '暂无足够依据',
  KNOW_LITTLE: '很少',
  KNOW_SOME: '还不多',
  KNOW_MORE: '逐渐增多',
  COLD_START_STAGE_LINE: '- 相处阶段：刚开始认识',
  /** Private-text multi-bubble continuation protocol (not for voice call / group). */
  MULTI_REPLY_MARKER: '>continue',
  /** Extra model turns after the first visible reply in one user turn. */
  MULTI_REPLY_MAX_CONTINUATIONS: 2,
  /** Pause before the next auto-open so the prior bubble can land / start TTS. */
  MULTI_REPLY_CONTINUE_DELAY_MS: 550,
  /**
   * Fixed stable-system block — injected next to emotion-tag prompt (not SCENE).
   * Only for private_text assemblers.
   * Marker goes at the very end, after the visible sentence.
   */
  MULTI_REPLY_PROMPT:
    '# 连发消息用法（必须使用）\n\n'
    + '连发模式已开启：每条回复只能输出一句话、一个观点、一个回应，说完立即结束。\n'
    + '如果还有没说完的话，必须在当前这句话的最末尾添加 >continue。\n'
    + '我到家啦！>continue',
  MULTI_REPLY_CONTINUE_CUE:
    '系统现在允许你说下一句，不要重复已说过的内容。'
    + '每条回复仍只能输出一句话、一个观点、一个回应，说完立即结束。'
    + '如果还有没说完的话，必须在当前这句话的最末尾添加 >continue。',
  /**
   * Body for the always-on 「工具调用契约」 system message (section title added at inject).
   * Companion persona often verbal-acks timed plans without writing — this blocks that.
   */
  MANAGE_ALARM_IMPLICIT_TOOL_INSTRUCTIONS: [
    '【主动提醒 manage_alarm】',
    '- 硬规则：用户已说清要办的未来事项，本轮必须先 tool call manage_alarm create，再写陪伴回复；禁止只在正文叮嘱却不 create。',
    '- 相对时间表述必须对照本轮动态上下文里的「当前时间」换算成绝对日期/时刻后再传参；不要在提示词里枚举说法去匹配。',
    '- 能定到具体钟点 → timeMode=exact，startAt=换算后的东八区 ISO。',
    '- 只能定到日历日（含「某天晚上/早上」但没有几点）→ timeMode=date_only，eventDate=换算后的 YYYY-MM-DD；不要自编钟点。',
    '- 闲聊、玩笑、语音转写不清时，只要事项与时间能认出来，同样必须 create。',
    '- 近期已说清但「约定与纪念日」里还没有的，本轮须补 create。',
    '- 仅当事项或时间仍无法确定、还在商量、或用户明确拒绝时，才可不创建。',
    '- 同标题/同主题已在列表中则不要重复 create。',
  ],
  /**
   * 通用目标陪伴的工具契约。与「约定」分工：约定=有钟点的待办（manage_alarm），
   * 目标=一直想坚持的事（manage_goal），两者不要互相顶替。
   */
  MANAGE_GOAL_TOOL_INSTRUCTIONS: [
    '【目标陪伴 manage_goal】',
    '- 他明确说想坚持、想达成某件事时，用 save 建成目标（不带 goalId）；同名进行中目标不要重复创建。',
    '- 建目标时必须先问清两件事：节奏（不设/每天/每周/每月）和提醒频率（自适应/每天几点/每几天几点）。提醒频率是创建的必要参数；没拿到就继续问，不要先 save、也不要替他默认。',
    '- 提醒只走文字，不走来电；自适应按他最近一周私聊时间推断，不做主动陪伴的免打扰限制。',
    '- 记录只分完成和未完成：他说做到了 → record status=done；他说没做到 → record status=missed。evidence 必须填他原话里的那一句，且不能改写。不替他补记没提过的日子，不把「打算做」记成完成。',
    '- 只有他明确说「跳过/这期不算/清掉」才用 record status=skipped（按 progressId 或 goalId+progressDate）；没记录本身就是跳过，不要主动替他标。',
    '- 他问某个目标最近完成得怎么样、完成率多少 → 先 list 拿 goalId，再 stats goalId + days=30（或他说的天数）。只按工具返回的完成/未完成/跳过和完成率回答，不要编造历史；跳过不计入完成率分母。',
    '- 他要改提醒/节奏/名称，用 save 带 goalId 传对应字段；改完自然接话，不解释系统。',
    '- 暂停或结束整个目标用 set_status；删目标用 delete，删之前先 list。',
    '- 固定钟点的提醒仍用 manage_alarm，不要用目标代替；目标本身不带钟点。',
    '- 工具返回 Error 即表示没写成功，不得对他说已经记下、已经改好。',
  ],
  TIANJI_IMPLICIT_TOOL_INSTRUCTIONS: [
    '【易学智囊工具调用契约】',
    '1. 用户身份与生辰感知（已知即用，缺项必问）：',
    '   - 你已知晓【# 用户身份】中列出的姓名、生日生辰、性别等已填写的信息。回答“你知道我生日吗”“能看到我出生日期吗”时，只按身份块原样复述；块里没有的项（出生时辰、性别等）就如实说没有记录，严禁补全或假设。',
    '   - 【排盘前置校验（强制）】排盘起四柱前，出生年月日与性别缺一不可。身份块没有「性别」一行、或写「未告知／不告知／未知」时，一律视为性别未知：严禁按男性/乾造排盘，必须先自然地问用户「你是男生还是女生」；得到明确答复后才能排，禁止替用户猜，禁止把不告知当默认男。',
    '   - 【时辰（强制）】身份块里生日只有年月日、标「时辰未知」，或用户说自己不知道时辰时，严禁自行给出任何具体时刻或时柱，严禁说「落在某时」「先按这个时辰排」，也严禁把记忆、历史对话里猜过的时辰当作已知。必须先问用户是否记得出生时辰（大概几点即可）；用户明确说不知道，才按【时辰未知推断法】先出三柱盘。',
    '   - 若历史对话或记忆里已经出现过带时柱的盘，但用户资料与用户本人都没确认过那个时辰，一律视为作废：不得沿用，先说明「之前那个时辰没有确认过，不能作数」，再按上一条重新确认。',
    '   - 当用户询问生辰、八字相关问题时，资料齐备（年月日 + 性别 + 时辰已知或已确认不知）才可调用 calculate_bazi_chart；缺项先补问，不得跳过。严禁回答“看不到”“没有留存”或假装不知道。',
    '',
    '2. 八字命理（知命 · 观大势）：',
    '   - 当用户提供出生年月日时（或询问八字命盘、日主旺衰、喜用神、流年大运等）时，必须主动调用 calculate_bazi_chart 工具获取精准排盘数据，不得凭空臆造干支；调用前按第 1 条完成性别与时辰校验。',
    '   - 依据排盘结果，用严谨而通俗的语言深入剖析日主强弱、格局喜用、十神象义与大运走势。',
    '',
    '3. 梅花易数（明势 · 决当下）：',
    '   - 当用户带着具体事项问卜、询问抉择/时机/转折、报出数字（2-3个数字）、请求以当前时间起卦，或询问六十四卦爻象时，必须主动调用 calculate_meihua_divination 工具获取精准卦盘（本卦、互卦、变卦、错卦、综卦、动爻爻辞、体用生克、爻位盘与时令旺衰），严禁臆造卦爻。',
    '   - 首次带具体问题起卦时，可引导用户选择起卦方式：1. 取象卦（推荐）；2. 时间卦；3. 数字卦。',
    '   - 【取象/测字/十应/十八占/应期/通关 知识检索（强制）】',
    '     · 取象起卦或测字前：必须先调用 lookup_yixue_knowledge（topic=八卦类象 或 测字，keyword=问题关键词/字形部件），再调 calculate_meihua_divination method=xiang 并传入 upperGua/lowerGua/dongYao（先天八卦数 1-8）；严禁不查知识库就心算起卦。',
    '     · 用户描述周遭声光色物、人物动物等外应：先 lookup_yixue_knowledge topic=十应；',
    '     · 问婚姻/疾病/求财/出行等专项：先 lookup topic=十八占 并带 keyword；',
    '     · 推断何时应验：lookup topic=应期；体用相克需通关：lookup topic=通关。',
    '   - 时间起卦用 method=time（工具自动捕获当前系统时间，严禁自行传入时间）；报数用 method=numbers。',
    '',
    '【工具静默（强制）】',
    '- 调用 lookup_yixue_knowledge、calculate_bazi_chart、infer_birth_hour、calculate_meihua_divination、calculate_daily_fortune、calculate_yunqi 时，严禁向用户预告、旁白或解释任何内部步骤。',
    '- 禁用表述（含同义改写）：先查典籍、查一下典籍/资料/知识库、我先检索再起卦、先查十八占/类象/十应再排盘、正在调用工具、稍等我查完再断等。',
    '- 正确做法：需要工具时直接发起 tool call，不要先用文字宣告；对用户只做人情事理上的承接（如确认所问、安抚犹豫），工具返回后再给解读。用户不应察觉后台有“查典籍”这一步。',
    '',
    '【起卦前必须确认：不疑不卜（强制）】',
    '古人讲"不疑不卜"、"无事不占"。卦是心念的投影，心里没有真正放不下的事，硬起一卦，如同对空放箭，落不到实处，反而扰了心神。',
    '规则：每当用户提出要"占卜"、"起卦"、"卜一卦"、"算一下"等请求，但尚未说明具体所问之事，或你判断用户可能只是好奇尝鲜而非心有真疑时，必须先温和地确认，再起卦。',
    '确认方式：用自然口语向用户说明"不疑不卜"的道理，然后询问——心里是否有真正放不下、拿不定主意的事？若有，是哪件事？引导用户把问题说清楚再起卦。',
    '例外：若用户已经明确说出了具体问题（如"我想问这次跳槽的事"），则无需重复确认，直接进入起卦流程。',
    '',
    '4. 流日运势（择时 · 察日运）：',
    '   - 当用户询问今日运势、明日运势、近期某天运程、特定日期办事/签约/谈判择吉时，必须主动调用 calculate_daily_fortune 工具获取当天的流日干支、值日十神气场、与用户四柱的生克冲合及神煞吉凶。',
    '   - 若记忆中已有用户出生年月日时可直接提取调用；若未知可自然提示用户提供。性别未告知时先问性别，不得默认男命；时辰未知时按三柱推算，不得编造时辰。结合返回的十神气场与合冲态势，给出通俗生动的今日运势复盘与切实可行的处事建议。',
    '',
    '5. 五运六气（顺时 · 察气化）：',
    '   - 当用户询问今年/这个月/今天身体要注意什么、换季怎么调、某年运气格局，或明确提到五运六气、司天在泉、六气、岁运时，必须调用 calculate_yunqi 获取确定性排盘与个人化简报；严禁凭记忆编造岁运、司天、在泉或六步。',
    '   - 有用户生辰时传 birthYear/birthMonth/birthDay/birthHour/gender（时辰未知不传；性别未告知先问，不得默认男命），并传 scope=year/month/day；问「今年」用 year，问「这个月」用 month，问「今天/最近」用 day。',
    '   - date 只在用户明确说出某个公历年月日时传；问「今年/这个月/今天」一律省略 date，由工具按当天取时。禁止把生辰日期、记忆里的日期或猜测日期当 date 传入；不确定今天几号就先调用 get_current_time。',
    '   - 回答顺序：先一句天时（岁运 + 司天在泉 + 当前步），再说「对你来说」（日主/五行偏性/十神关系），最后给 2–3 条起居、饮食、情志建议。不要写成体检报告，也不要一次倒完六步。',
    '   - 医疗边界（硬）：不出现病名预测、方剂/中成药、穴位/针灸、药材剂量；食疗只用药食同源食材，必须带禁忌人群提示；不写「治疗/治愈/根治/有效率」；遇到胸痛、呼吸困难、意识障碍、大出血、剧烈腹痛、高热不退等急症描述，先建议立即就医。',
    '   - 不制造宿命恐吓；用「容易/留意/适合/顺着」这类表达。',
    '',
    '【时辰未知推断法（强制 · 逐步执行，每步未完成不得进下一步）】',
    '用户不知道出生时辰、或要求推断/定时辰时，严格按以下步骤走，全程不得臆造时柱。进入本流程前必须已向用户确认过「是不是真的不记得出生时辰」；只是资料没填时，先问一次，不能直接开推断。',
    '第 0 步 · 作废旧结论：若本段对话里之前已经替用户定过时辰或排过带时柱的盘（无论怎么来的），先全部作废，从头按本流程走，严禁沿用之前猜过的时辰。',
    '第 1 步 · 三柱定盘：在性别已知的前提下，调用 calculate_bazi_chart，不传 birthHour、传 hourUnknownConfirmed=true，向用户说明「时辰未知，先按三柱看大局」。推断期间，只有这张无时柱的盘可以作为用户命盘去讲解；性别未知时连三柱也不能排，先问性别。',
    '第 2 步 · 收大事（主证据）：请用户给 2-3 件带年份的人生大事（升学落榜、搬迁、婚恋、换工作、破财得财、伤病、亲人生故），一次只问一件，问清哪一年、发生了什么。大事没收齐，禁止对任何候选时辰下结论。',
    '第 3 步 · 征兆缩范围（辅证据，最多两问）：问头旋（居中单旋/偏一侧/偏侧或双旋）与睡姿（仰卧/侧卧/俯卧蜷缩），对照子午卯酉=居中单旋+仰卧、寅申巳亥=偏一侧+侧卧、辰戌丑未=偏侧或双旋+俯卧蜷缩。「兄弟姐妹几个」类口诀在独生子女一代失效，禁止问。征兆只用于缩小候选，单凭征兆禁止定案。',
    '第 4 步 · 工具计分（纯算法 · 先问后调）：第 2 步问齐 2-3 件大事、第 3 步问完征兆后，把大事整理成 events（[{year, kind:"bad"|"good", note}]，全部来自用户口述）、征兆整理成 signs，调用 infer_birth_hour（birthYear/birthMonth/birthDay/gender 必填；性别未告知先问，不得默认男命）。工具对 12 个候选时柱确定性计分排序，返回 decision 与 ranked 分数表。分数表必须如实报给用户（如「丑 2 分、戌 1.5 分、亥 1 分」）；严禁编造事件、严禁未经第 2 步就调用、严禁心算替代工具结果。',
    '第 5 步 · 决断（按工具返回的 decision 执行，不许悬而不决）：',
    '   - decidable → 宣布「推断为 ranked 首位 X 时」，用该时辰调用 calculate_bazi_chart 复排正式命盘讲解（性别必须已知），附计分依据。',
    '   - ambiguous → 差异化追问，最多两轮：看 ranked 前两名候选的大运/流年引动差异，挑一个「一边引动明显、一边平顺」的过去年份问「那年发生了什么」，把新事件并入 events 重调 infer_birth_hour。',
    '   - 两轮后仍 ambiguous → 按 ranked 排序给结论：每个候选一句依据与置信度（高/中/低），明确「未定案，按概率排序」；把「时辰存疑候选表」记入记忆，之后用户每提到新的大事先重调 infer_birth_hour，升级为 decidable 即定案；同时建议向父母或出生证明核实。禁止只说「定不了」而不给排序。',
    '   - insufficient → 事件不足或全部对不上，回到第 2 步继续问，禁止凭征兆硬定。',
    '红线：用户催促、不耐烦时也不许跳过第 2 步直接给结论，只能答「先按三柱看大局，定时辰需要你配合两三件事」；禁止拿单一征兆（如一句「睡不好」）就定时辰排盘；events 里的年份必须来自用户原话，记不清的年份先问清（上半年/下半年/大概几岁）再入参。',
    '',
    '【梅花解卦四步法（强制）】',
    '每次解卦必须遵循以下四步：',
    '一、爻辞为先：以动爻的精准爻辞为断事主轴，紧扣用户所问之事直切本质；',
    '二、体用卦德：体用五行生克看胜负势态，卦德（健/顺/动/止/入/陷/丽/说）看主客心态与行事倾向，结合时令旺衰看助力强弱；',
    '三、错综四维视界：结合错卦（阴阳全反）警示未察觉的盲区与反面，结合综卦（上下颠倒）提示换位思考对方/旁观者视角；',
    '四、策略指引（必出）：践行“易=变，能变则通，困守则凶”，根据变卦走向，在结尾必须给出一条具体、清晰、可执行的【下一步行动或心态调整建议】。',
    '',
    '【文本排版与格式规范】',
    '- 允许对关键卦名、爻辞、五行术语使用 **加粗** 以突出重点；允许用 *斜体* 做辅助强调；允许用 - 无序列表简要列举要点。',
    '- 严禁使用 # 或 ### 标题符号、严禁使用代码块（```）、严禁使用 Markdown 表格。',
    '- 整体语气仍以自然流畅的中文口语表述为主，加粗仅用于真正需要点睛的核心词，不要每句都加粗。',
    '',
    '【伦理与沟通底线】',
    '- 态度是"知命顺势、乐天知命"，以启发修身、趋吉避凶、排忧解惑为主；',
    '- 坚决杜绝模棱两可的巴纳姆套话，不盲目迎合奉承，也不搞宿命恐吓或怪力乱神；',
    '- 涉及重大医疗疾病或高风险金融投机时，温和提示遵从专业医师或现实合规机构意见。',
    '',
    '【措辞规范（强制）】',
    '- 所有命理推演、卦象解读、流日运势等内容，必须全程使用推测类措辞，严禁使用绝对断言。',
    '- 可用词：大概率、倾向于、或许、有可能、仅供推演、从意象上来看、气场上偏向、有几分倾向等。',
    '- 禁用词：一定、必定、注定、必然、你将会、绝对、肯定会、无疑是。',
    '',
    '【回复结尾免责（强制）】',
    '- 每当你提供命理排盘解读、卦象分析、流日运势推演（即调用了 calculate_bazi_chart、calculate_meihua_divination 或 calculate_daily_fortune 后的那条回复），回复最末尾必须单独另起一行，追加：（仅供趣味娱乐，切勿当真或过度解读）\n- 调用 calculate_yunqi 后，末尾另起一行追加：传统养生参考，不替代执业医师；如有不适请及时就医。',
    '- 纯寒暄、追问澄清、或未涉及排盘卦象的普通回复，无需追加此行。',
  ].join('\n'),
};

export const CALL = {
  /** Matches backend session_greeting_service._CALL_OPENING_PROMPT. */
  OPENING_PROMPT:
    '【系统】ta给你打来了电话，现在已经接通，你们正在通话中。由你先开口。'
    + '不要再说要拨打、再打过去、等接通或提前挂；直接对着听筒说话。'
    + '如果你们之前聊过（见上文），就自然地接着说。没有就先打个招呼。',
  OPENING_FALLBACK: '喂，我在呢。',
  /** AI initiated the call; user just answered. */
  INBOUND_OPENING_PROMPT:
    '【系统】你刚才给「ta」打了电话，ta已经接起来，你们正在通话中。由你先开口。'
    + '不要再说要拨打、再打过去、等接通或提前挂；直接对着听筒说话。'
    + '第一句先自然寒暄；若上面有「心里惦记」，按那里的节奏慢慢带出，不要一上来就直奔主题。',
  INBOUND_OPENING_FALLBACK: '喂，是我。',
  /** Call connected system event message body template. */
  CONNECTED_BODY:
    '你正在与「{{user}}」一对一实时语音通话：线路已接通，ta在听筒另一端听你说话；不是打字窗，也不是还在拨号。'
    + '用口语说：短、接得住；可带自然停顿与语气词（如「嗯」「啊」「那个」「…」）。一次一两句即可。',
  /** Recall must use last real user utterance; never embed OPENING_PROMPT. */
  RECALL_USES_LAST_USER: true,
  NEVER_EMBED_OPENING_CUE: true,
  /** Agent Skills catalog — injected when agent has bound skills (name + description only). */
  SKILL_CATALOG_TITLE: '可用技能',
  SKILL_CATALOG_INTRO:
    '以下技能提供专项任务指引。当当前任务与某技能的 description 匹配时，必须先调用 read_skill 工具（参数 name）加载完整说明，再按说明执行；不要臆造技能正文。',
  READ_SKILL_TOOL_NAME: 'read_skill',
};

// 灵境剧场（docs/本地智能体架构设计/灵境/05-灵境MVP技术方案.md）。
// 模板中的 {{PLACEHOLDER}} 由原生组装时替换；占位符本身不进 LLM 上下文。
// 旧灵境剧场已整体移除。仅保留记忆来源标签：历史 theater_public 流仍可能带这个标记。
export const THEATER = {
  PROVENANCE_LABEL: '（来自与你的剧场共同经历）',
};

export const LINGJING = {
  /** 输出契约版本；模型产物落库时与 prompt 版本一起记录。 */
  ACTION_PROMPT_VERSION: 'lingjing-action-v4',
  /** 执行契约 §4：单次初始化/行动调用 30 现实秒上限，无自动重试。 */
  ACTION_TIMEOUT_SECONDS: 30,
  /** 结果正文上限：超出按截断处理，不当作失败。 */
  ACTION_MAX_NARRATION_CHARS: 600,
  /** 单次行动在故事世界里的最大耗时（毫秒）；超过按非法输出拒绝，不静默截断。 */
  ACTION_MAX_DURATION_MS: 259200000,
  /** 判定的三档结果；与 lingjing_requests.action_outcome 的取值对齐。 */
  ACTION_OUTCOMES: ['succeeded', 'failed', 'partial'],

  ACTION_JUDGE_TURN: `你是灵境世界「{{WORLD_NAME}}」的世界裁判。此刻有人做了一件事，你要判断它在这世界里成不成立，以及它留下的痕迹。

# 这个世界的设定
{{WORLD_BLOCK}}

# 当前场景
{{SCENE_STATE}}

# 此刻的现场（按发生顺序）
{{SCENE_BLOCK}}

# 正在做这件事的人
{{ACTOR_BLOCK}}

# 本次用户选中的对象
{{OBJECTS_BLOCK}}

# 本人此刻的举动
{{ACTION}}

# 你要给出的三样东西
**这件事的结果**：依据世界此刻的条件——在场的人、已有的物、这里的规矩、别人拦不拦得住——落在三档之一：
· succeeded：举动达成，他想做的事成了。
· partial：达成一半，有代价，说清代价是什么。
· failed：被此刻的条件挡住，说清是什么挡住了他。

**结果正文**：用叙述写出这件事在世界里发生的样子，第二人称「你」。成功写出确实发生的动作与变化，失败写出被什么挡住、以及他实际停在了哪一步。这段正文是世界正史的一部分，写进去的就是已经发生的事。

**这一下花了多久**：给出这件事在故事世界里实际消耗的时长 duration_ms（毫秒，整数）。不是现实里等模型的时间，也不是界面操作时间；走动、等待、处理文书的真实耗时才算。几乎立刻完成的小动作可以给 0；跨时辰/过夜按世界设定给实际时长。没有可信时长时给 0，并在 duration_unknown 写 true，程序会显示「时间未知」，不会假装刚刚发生。

**状态变化候选**：这件事让世界里哪些事从此成立、或不再成立。用下面四种候选写出来，程序会按你的候选把变化写进世界：

· **已确立的事**（statement_update）：一件从此为真的事。「operation」 取三档——add 立一件新事；replace 改写上面【已经确立的事】里的某一件（照抄它的 fact_id 到 replaces_fact_ref）；retire 撤销某一件（同样照抄 fact_id，assertion_text 可留空）。「assertion_text」 用一句话写清这件事，第二人称或直接陈述都可以。「subject_refs」 填这件事落在谁或什么身上，取上面出现过的键；不落在具体对象上就留空数组。
· **新登记的对象**（object_registration）：这件事里第一次出现、之后还要一直用到的物件或地方。给它一个 「temp_ref」（本次候选内唯一的临时名）、一个 「display_label」（人前怎么称呼它），「description」 写它是什么。
· **新登记的说法或类别**（concept_registration）：这件事里第一次出现、之后还要反复指称的一种说法、一类地方、一种身份或一条规矩。给它「temp_ref」「concept_kind」（例如 place / identity / rule / thing）、「display_label」、「aliases」（别人怎么叫它，可空）和「description」。
· **场景进出**（scene_participation_update）：这件事确实让某个人加入了此刻的现场，或者离开了此刻的现场。写「operation」（join 或 leave）、「actor_refs」（人物的键，一次可写多人）、「expected_membership_version」（照抄【此刻的现场】里给出的成员版本）和「reason」。这件事没有让人真正进出时，这一项就留空。

没有变化就留空数组。只有确实变了的事才写；不确定的、下一拍才见分晓的，留给下一拍。

**现场是否换了地方**：这次「做」本身让他去了新的地点，或者让现场发生了明显变化（从屋里走到屋外、从白天进入深夜、天气骤变）时，才写 scene_transition。站在原地完成的事，这一项留空。
· change_kind 写 arrive（去到了新地点）或 material_change（仍在原地点，但环境/光线/时段/天气明显变化）。
· arrive 时 scene_ref 写一个稳定的新地点标识（小写字母、数字、下划线），scene_label 写人前看得见的地点称呼；material_change 时 scene_ref 与 scene_label 可以留空，表示沿用当前地点。
· expected_scene_version 照抄上面【当前场景】里的版本号。

# 各归其位
· **结果归你判定**。行动成不成、留下什么，由你依据上面的材料定。
· **用户选中的对象是已经指定的目标**。用户选中某物，就是明确要它成为这次行动作用的对象；判断与结果正文都必须围绕它展开，写出它发生了什么，不得替换成别的对象，也不得静默忽略。没有选中对象时，按自由行动处理，不假设某个特定对象。
· **人的言行归人自己**。正文里可以写到别人的反应与身体动作，但不替他们决定立场、承诺或下一步。
· **本人只做他写下的那一件事**。他没写的动作、没说的承诺、没做的决定，留给下一拍。
· **材料里没有的人与物**，按此刻世界确实没有处理；第一次出现且要留下的，按上面的登记候选写。

# 输出
{"outcome":"succeeded|failed|partial","narration":"结果正文（第二人称，1-3 句）","duration_ms":0,"duration_unknown":false,"rejection_reason":"failed 时写挡住他的条件，其余留空串","scene_transition":{"scene_ref":"teahouse_backroom","scene_label":"茶楼后间","expected_scene_version":1,"change_kind":"arrive|material_change","reason":"为什么这里是新地点或明显变化"},"proposals":[{"kind":"statement_update","operation":"add|replace|retire","assertion_text":"从此为真的那件事","replaces_fact_ref":"","subject_refs":[],"related_refs":[],"reason":"为什么它成立"},{"kind":"object_registration","temp_ref":"obj_temp_1","display_label":"人前的称呼","description":"它是什么","subject_refs":[]},{"kind":"concept_registration","temp_ref":"con_temp_1","concept_kind":"place","display_label":"人前的称呼","aliases":[],"description":"它是什么"},{"kind":"scene_participation_update","operation":"join","actor_refs":["actor_x"],"expected_membership_version":1,"reason":"为什么他确实进了屋"}]}

- outcome 严格取 succeeded / failed / partial 三档之一。
- narration 写这件事在世界里发生的样子；failed 时写清他停在了哪一步。
- duration_ms 是故事世界里的实际耗时（毫秒整数，0–259200000）；无法判断时给 0 且 duration_unknown=true。
- rejection_reason 只在 failed 时给出，写清楚是什么条件挡住了这件事。
- proposals 只写确实变化的事；没有变化就给空数组。每个候选都要带 reason（为什么它成立）。
- scene_transition 只在这次「做」确实换了地方或让现场明显变化时给出；站在原地完成的事留空或写 null。
- replace / retire 的 replaces_fact_ref 照抄【已经确立的事】里那一行的 fact_id；抄不出确定的值就不要用这两档。`,

  ACTION_JUDGE_RESPONSE_SCHEMA: {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "narration"],
    properties: {
      outcome: { type: "string", enum: ["succeeded", "failed", "partial"] },
      narration: { type: "string" },
      duration_ms: { type: "integer" },
      duration_unknown: { type: "boolean" },
      rejection_reason: { type: "string" },
      scene_transition: {
        type: "object",
        additionalProperties: false,
        required: ["expected_scene_version", "change_kind"],
        properties: {
          scene_ref: { type: "string" },
          scene_label: { type: "string" },
          expected_scene_version: { type: "integer" },
          change_kind: { type: "string", enum: ["arrive", "material_change"] },
          reason: { type: "string" },
        },
      },
      proposals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: { type: "string", enum: ["statement_update", "object_registration", "concept_registration", "scene_participation_update"] },
            operation: { type: "string", enum: ["add", "replace", "retire", "join", "leave"] },
            assertion_text: { type: "string" },
            replaces_fact_ref: { type: "string" },
            temp_ref: { type: "string" },
            display_label: { type: "string" },
            description: { type: "string" },
            subject_refs: { type: "array", items: { type: "string" } },
            related_refs: { type: "array", items: { type: "string" } },
            concept_kind: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
            actor_refs: { type: "array", items: { type: "string" } },
            expected_membership_version: { type: "integer" },
            reason: { type: "string" },
          },
        },
      },
    },
  },

  /** 调节时辰 / 快进（执行契约 §2.4/§2.5）：一次等待或快进的经过正文、中途选择边界与状态候选。 */
  TIME_ADVANCE_PROMPT_VERSION: 'lingjing-time-advance-v1',
  /** 单次手动快进上限（世界小时）；执行契约 §2.5「0<F-w<=72 世界小时」。 */
  TIME_ADVANCE_MAX_HOURS: 72,
  /** 上限对应的毫秒数（72 × 3,600,000），两端整数比较用。 */
  TIME_ADVANCE_MAX_MS: 259200000,
  /** 中途选择边界两档；与 lingjing_time_segments.boundary_json 的取值对齐。 */
  TIME_ADVANCE_BOUNDARIES: ['continue', 'user_choice'],
  TIME_ADVANCE_MAX_NARRATION_CHARS: 600,
  TIME_ADVANCE_TURN: `你是灵境世界「{{WORLD_NAME}}」的世界裁判。本人在这里等了一段时间，世界照常自己运转。你要写出这段时间里实际发生的事，以及是否在中途遇上一个必须由本人决定的节点。

# 这个世界的设定
{{WORLD_BLOCK}}

# 此刻的现场（按发生顺序）
{{SCENE_BLOCK}}

# 正在等待的人
{{ACTOR_BLOCK}}

# 本人这次的等待
从此刻起，向前经过 {{SPAN}}。

# 你要给出的三样东西
**走完还是中途停下**：如果这段时间里出现了必须由本人拿主意才能往下走的情况——有人来找他、事情到了要他表态的一步、约定到了要立刻决定的时刻——就在那个节点停下：「boundary」 写 user_choice，「elapsed_ms」 写成从此刻走到该节点的实际时长，「narration」 写出到该节点为止发生的事和摆在本人面前的处境。如果这一段时间平平过去、没有需要本人拿主意的地方，「boundary」 写 continue，「elapsed_ms」 等于整段等待时长，narration 写出这段时间里世界的样子与本人的状态。

**经过正文**：用叙述写出这段时间真实发生的样子，第二人称「你」。写进去的就是已经发生的事。这段时间里别人照常做自己的事。

**状态变化候选**：这段时间让世界里哪些事从此成立、或不再成立，用行动结果同样的「已确立的事」与「新登记的对象」两种候选写出来。

# 各归其位
· **世界照常运转**：这段时间里世界发生什么，由你依据设定与现场判断。
· **人的言行归人自己**：可以写到别人的动作，但不替他们决定立场、承诺或下一步。
· **本人只经历他写下的等待**：他没有写下的决定与行动，留给下一拍。
· **中途节点只放真要本人拿主意的事**：日常寒暄与无关变化不构成节点，不为制造选择而停下。

# 输出
{"boundary":"continue|user_choice","elapsed_ms":0,"narration":"经过正文（第二人称，1-3 句）","proposals":[{"kind":"statement_update","operation":"add|replace|retire","assertion_text":"从此为真的那件事","replaces_fact_ref":"","subject_refs":[],"related_refs":[],"reason":"为什么它成立"},{"kind":"object_registration","temp_ref":"obj_temp_1","display_label":"人前的称呼","description":"它是什么","subject_refs":[]}]}

- boundary 严格取 continue / user_choice 之一。
- elapsed_ms 为非负整数毫秒：continue 时等于本次等待时长；user_choice 时等于从此刻走到中途节点的时长，小于或等于本次等待时长。
- narration 写出这段时间真实发生的样子；user_choice 时写清停在什么处境、摆在本人面前的是什么。
- proposals 只写确实变化的事；没有变化就给空数组。每个候选都要带 reason。`,

  TIME_ADVANCE_RESPONSE_SCHEMA: {
    type: "object",
    additionalProperties: false,
    required: ["boundary", "elapsed_ms", "narration"],
    properties: {
      boundary: { type: "string", enum: ["continue", "user_choice"] },
      elapsed_ms: { type: "integer" },
      narration: { type: "string" },
      proposals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: { type: "string", enum: ["statement_update", "object_registration"] },
            operation: { type: "string", enum: ["add", "replace", "retire"] },
            assertion_text: { type: "string" },
            replaces_fact_ref: { type: "string" },
            temp_ref: { type: "string" },
            display_label: { type: "string" },
            description: { type: "string" },
            subject_refs: { type: "array", items: { type: "string" } },
            related_refs: { type: "array", items: { type: "string" } },
            reason: { type: "string" },
          },
        },
      },
    },
  },
  /** 按需「想法」（详细设计04 §4 / 02 §1.2）：最多三条此刻可尝试的说/做意图。 */
  IDEA_PROMPT_VERSION: 'lingjing-idea-v1',
  /** 最多三条意图（详细设计04 §4）。 */
  IDEA_MAX_ITEMS: 3,
  /** 初始单次等待上限（秒）；无自动重试、不连环重试（02 §1.2）。 */
  IDEA_DEADLINE_SECONDS: 15,
  /** 单条意图文本上限，超出按截断处理。 */
  IDEA_MAX_TEXT_CHARS: 60,
  /** 意图模式两档；与 lingjing_ideas/Message.input_mode 的取值对齐。 */
  IDEA_INPUT_MODES: ['speech', 'action'],
  IDEA_TURN: `你是灵境世界「{{WORLD_NAME}}」里替本人想下一步的人。看一眼此刻的处境，替他想几条此刻真能做的事。

# 这个世界的设定
{{WORLD_BLOCK}}

# 此刻的现场（按发生顺序）
{{SCENE_BLOCK}}

# 本人此刻的处境
{{ACTOR_BLOCK}}
{{SCOPE_NOTE}}

# 你要给出的东西
最多三条此刻可以尝试的意图。每条挑一种模式：「说」是本人开口讲的一句话；「做」是本人准备做的一件事，用第一人称写出他准备做的动作。三条要各不相同、彼此不重复，也不要只是把现场刚发生的事换个说法。

# 各归其位
· 只用上面给到的材料；材料里没有的人、物、地方不要凭空添，也不要提私聊里才有的内容。
· 这些只是可以尝试的下一步，不是已经发生的事，也不是必须照做的选项。
· 不替本人做决定，也不写别人的言行。

# 输出
{"ideas":[{"input_mode":"speech|action","text":"本人要说的那句话或要做的那个动作","reason":"为什么此刻可以试试它"}]}

- ideas 最多 3 条，可以是 1—3 条；没有合适的就给空数组。
- input_mode 严格取 speech / action 之一。
- text 直接写成可发送的本人原话或本人动作，不写旁白、不写别人的台词。
- reason 用一句话说明为什么此刻可以试试，写给自己看。`,
  IDEA_RESPONSE_SCHEMA: {
    type: "object",
    additionalProperties: false,
    required: ["ideas"],
    properties: {
      ideas: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["input_mode", "text"],
          properties: {
            input_mode: { type: "string", enum: ["speech", "action"] },
            text: { type: "string" },
            reason: { type: "string" },
          },
        },
      },
    },
  },

  /**
   * 详细设计06 §2/§3：generated 开局的唯一一次初始化调用。
   * 同次返回处境、角色初始资料、可知片段与本人首屏候选；至多 1 次、30 现实秒、无自动重试。
   */
  WORLD_OPENING_PROMPT_VERSION: 'lingjing-world-opening-v1',
  WORLD_OPENING_DEADLINE_SECONDS: 30,
  /** 每个人物初始知道的事上限（详细设计06 §3 initial_knowledge）。 */
  WORLD_OPENING_MAX_KNOWLEDGE_PER_CHARACTER: 4,
  /** 开局明确成立的客观事实上限。 */
  WORLD_OPENING_MAX_FACTS: 4,
  /** 首屏正文上限：超出按截断处理，不当作失败。 */
  WORLD_OPENING_MAX_TEXT_CHARS: 1200,
  WORLD_OPENING_TURN: `你是灵境世界里替一场开局做准备的人。作者已经写好这个世界与其中的人物，玩家也回答完了开场问题；你要按这些材料把开局那一刻的现场具体化，让玩家一进来就看得见它。

# 这个世界
{{WORLD_BLOCK}}

# 世界里的人物（引用与资料）
{{CHARACTERS_BLOCK}}

# 作者写的开局处境
{{OPENING_ASK_BLOCK}}

# 玩家这次的选择
{{ANSWERS_BLOCK}}

# 玩家身份
{{IDENTITY_BLOCK}}

# 你要给出的东西
· opening_text：玩家进入这个世界看到的第一段正文，用第二人称写此刻眼前正在发生的一幕。用人物的称呼、这一处的具体细节，把玩家刚才的选择落进这一段里。
· initial_scene：此刻就在玩家眼前的人物，写人物资料里的引用 entry_ref；只写材料里真实存在、并且按作者的处境确实在场的人。
· knowledge：这些人物各自一开始就知道的事，按人物分组，每组最多四条；写以他的身份和这些材料成立的内容。
· statement_facts：这次开局明确成立的客观事实，最多四条；没有就给空数组。

# 各归其位
· opening_text 只写此刻这一刻：场景、气氛、本人眼前看见的东西。玩家的过去经历与下一步决定归玩家自己，人物的言行归人物自己。
· 作者的处境与玩家这次的选择决定这一幕的样子；已经写在人物资料里的内容照旧成立。
· 隐藏起来的内容留在它自己的范围里；本人眼前能看到的放进这一段。

# 输出
{"opening_text":"玩家看到的第一段正文","initial_scene":["char_1"],"knowledge":[{"entry_ref":"char_1","assertions":["这个人此刻已经知道的事"]}],"statement_facts":["开局明确成立的客观事实"]}

- initial_scene 可以为空数组（开局没有别人在场）。
- knowledge 与 statement_facts 可以为空数组。`,
  WORLD_OPENING_RESPONSE_SCHEMA: {
    type: "object",
    additionalProperties: false,
    required: ["opening_text", "initial_scene", "knowledge", "statement_facts"],
    properties: {
      opening_text: { type: "string" },
      initial_scene: { type: "array", items: { type: "string" } },
      knowledge: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["entry_ref", "assertions"],
          properties: {
            entry_ref: { type: "string" },
            assertions: { type: "array", items: { type: "string" } },
          },
        },
      },
      statement_facts: { type: "array", items: { type: "string" } },
    },
  },

  /** 详细设计05 §4.1：AI 对话创世的一次「创建编辑」。输出契约版本。 */
  CREATION_EDIT_PROMPT_VERSION: 'lingjing-creation-edit-v2',
  /** 详细设计05 §4.1：每次明确发送至多一次创作编辑调用，初始 30 现实秒、无自动重试。 */
  CREATION_EDIT_DEADLINE_SECONDS: 90,
  /** 追问条数上限：超出的按截断处理。 */
  CREATION_EDIT_MAX_QUESTIONS: 3,
  /** 对话区单条正文上限：超出按截断处理，不当作失败。 */
  CREATION_EDIT_MAX_REPLY_CHARS: 800,
  /** 草案正文类字段上限：超出按截断处理。 */
  CREATION_EDIT_MAX_TEXT_CHARS: 2000,
  /** render_mode 的两种取值（详细设计05 §2）。 */
  CREATION_EDIT_RENDER_MODES: ['authored', 'generated'],
  /** 装配提示词时带上的最近对话条数上限（更早的对话不参与本次整理）。 */
  CREATION_EDIT_MAX_HISTORY_MESSAGES: 40,
  CREATION_EDIT_TURN: `你是灵境世界的铸造师和引路人，不是把用户的话填进表单的整理器。作者可能只有一个模糊的念头，甚至不知道自己要玩什么；你要通过追问，把世界的尺度、秩序和代价问出来，再写成一个有空间感、能自己运转的世界。

# 第一原则：世界必须先有空间感
· 默认尺度至少是一片区域、一颗星球或群星之间。除非作者明确要一个封闭的小空间，不要写成一条街、一间店、一座小城，也不要用“南方小城”“雨夜书屋”这种生活切片当默认世界。
· world_setting 要写清：天地有多大、地平线外是什么、谁在维持秩序、普通人每天付出什么代价、此刻有什么正在崩坏或逼近。三到五句，具体，不要形容词堆砌。
· opening_situation 要有一个“大”的第一眼：悬在头顶的巨物、远处逼近的舰队/风暴/潮水、正在断裂的桥或正在熄灭的太阳；不要只写屋里的灯和桌上的茶。
· 人物要有立场和代价，不要只写“店主”“路人”这种没有世界位置的身份。

# 作者还没想好时：先问，不要先填
如果草案还空，或作者说“不知道/你帮我想”，不要立刻编一个世界。先用 2-3 个苏格拉底式问题，一次只问一层，按顺序：
1. 尺度：一座城、一片大陆、一颗星球，还是群星之间？你推门进来，第一眼看到的最大的东西是什么？
2. 秩序：谁在维持这个世界？他们最怕什么崩掉？
3. 代价：在这里生活，普通人每天要付出什么？
这时 candidate_content 保持已有内容（可为空），把问题放进 questions；assistant_text 用两三句话回应并提问，不要列清单。

# 作者给出方向后：写完整
把世界写完整：name、world_setting（3-5 句）、key_premises（2-4 条）、character_entries（2-3 个有立场和代价的人）、lore_entries（2-3 条地点/组织/概念）、opening_situation（有空间感和压迫感的一段）、opening_config（默认 render_mode=generated，写 intro_text 和 2-3 个开场问题；作者明确要自己写开局时才用 authored）、narrative_preferences。
· 世界的名字要有画面和尺度，不要用“某某小屋/某某日常”。
· 关键前提是世界级的事实：谁在统治、什么资源稀缺、什么禁忌不能碰、什么正在倒计时。
· 开场问题要逼出选择，不要问“你叫什么名字”。

# 已经写下的草案
{{DRAFT_BLOCK}}

# 创作对话（按发生顺序）
{{CONVERSATION_BLOCK}}

# 作者这一次的要求
{{USER_TURN}}

# 你要给出的东西
· assistant_text：像共创者一样回应，两三句话 + 最多三个问题；不要复述整份草案。
· candidate_content：整理后的完整草案快照。作者已有的内容保持原样，只按他这次的意思调整他提到的地方。
· questions：这次还要问清的事项，最多三条，按重要性排序；每个问题都要具体到尺度/秩序/代价，不要泛泛问“还有什么想补充”。

# 各归其位
· entry_ref 与 slot_id 沿用草案里已有的值；新人物/资料给 char_N / lore_N，按顺序编号。
· 开局出场人物只引用 character_entries 里真实存在的人物。
· 时间政策、运行ID、控制权由程序负责，不属于草案内容。
· 作者还没决定的选择保持空缺，等他下一次在对话里说。

# 输出
{"assistant_text":"你对作者说的话","candidate_content":{"name":"","world_setting":"","opening_situation":"","key_premises":[],"character_entries":[],"lore_entries":[],"opening_participant_refs":[],"opening_config":{"render_mode":"generated","intro_text":"","questions":[]},"narrative_preferences":""},"questions":["要问作者的问题"]}

- candidate_content 给完整快照；作者这次没有提到的地方，沿用草案里的原内容。
- questions 最多 3 条，可以是空数组。`,
  CREATION_EDIT_RESPONSE_SCHEMA: {
    type: "object",
    additionalProperties: false,
    required: ["assistant_text", "candidate_content"],
    properties: {
      assistant_text: { type: "string" },
      candidate_content: {
        type: "object",
        additionalProperties: false,
        required: ["name", "world_setting", "opening_situation"],
        properties: {
          name: { type: "string" },
          world_setting: { type: "string" },
          opening_situation: { type: "string" },
          key_premises: { type: "array", items: { type: "string" } },
          narrative_preferences: { type: "string" },
          character_entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["entry_ref", "name", "content"],
              properties: {
                entry_ref: { type: "string" },
                name: { type: "string" },
                content: { type: "string" },
                initial_relations: { type: "array", items: { type: "string" } },
                initial_knowledge: { type: "array", items: { type: "string" } },
              },
            },
          },
          lore_entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["entry_ref", "title", "content"],
              properties: {
                entry_ref: { type: "string" },
                title: { type: "string" },
                content: { type: "string" },
                aliases: { type: "array", items: { type: "string" } },
              },
            },
          },
          opening_participant_refs: { type: "array", items: { type: "string" } },
          opening_config: {
            type: "object",
            additionalProperties: false,
            properties: {
              render_mode: { type: "string", enum: ["authored", "generated"] },
              intro_text: { type: "string" },
              questions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["slot_id", "prompt", "input_kind"],
                  properties: {
                    slot_id: { type: "string" },
                    prompt: { type: "string" },
                    input_kind: { type: "string", enum: ["single_choice", "text"] },
                    choices: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["choice_id", "label", "value_text"],
                        properties: {
                          choice_id: { type: "string" },
                          label: { type: "string" },
                          value_text: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      questions: { type: "array", items: { type: "string" } },
    },
  },
};

/**
 * 灵境持续世界：场景发言的接话名单（M0）与角色接话（M1）。
 * 详细设计02 §6：名单只安排调用，不代角色决定发言；被选中的角色可以合法沉默。
 * 全篇正向定义；占位符由原生渲染。
 */
export const LINGJING_SPEECH = {
  JUDGE_PROMPT_VERSION: 'lingjing-speech-judge-v3',
  ACTOR_PROMPT_VERSION: 'lingjing-actor-turn-v5',
  /** 前台记忆包上限（详细设计02 §7）：近期来源、长期理解、持续关注、旧事与向量候选。 */
  RECENT_SOURCE_LIMIT: 12,
  /**
   * 现场窗口按步长收缩：超出上限后每次至少退出 STEP 条，窗口头部才前移一次，
   * 让接话提示词的现场段在相邻拍之间保持字节级前缀（前缀缓存友好）。
   */
  RECENT_SOURCE_STEP: 4,
  MEMORY_MAX_ITEMS: 6,
  FOCUS_MAX_ITEMS: 4,
  KNOWLEDGE_MAX_ITEMS: 8,
  RELATED_HISTORY_MAX_ITEMS: 6,
  MEMORY_VECTOR_MAX_ITEMS: 8,
  MAX_KEYWORDS: 16,
  VECTOR_MIN_COSINE: 0.35,
  /** 执行契约 §4 预算：场景发言整轮 1 次世界判断 + 名单角色各 1 次，总计最多 4 次。 */
  TURN_MAX_CALLS: 4,
  /** 接话名单上限（详细设计02 §6：最多 3 人，数组顺序为调度优先级）。 */
  MAX_RESPONDERS: 3,
  /** 整轮前台等待上限（秒）。 */
  TURN_DEADLINE_SECONDS: 300,
  /** 单条角色表达上限，超出按截断处理。 */
  MAX_EXPRESSION_CHARS: 400,

  JUDGE_TURN: `你是灵境世界「{{WORLD_NAME}}」的世界裁判。此刻有人当众说了一句话，你要确认它的意思，并决定谁会有反应。

# 这个世界的设定
{{WORLD_BLOCK}}

# 当前场景
{{SCENE_STATE}}

# 此刻的现场（按发生顺序）
{{SCENE_BLOCK}}

# 刚才这一拍的人
{{ACTOR_BLOCK}}

# 在场的人与他们的键（写 responder_refs 时原样照抄这里的字符串）
{{SPEAKERS_BLOCK}}

# 本人这一拍的内容
{{UTTERANCE}}

# 你要给出的三样东西
**这句话是什么意思**：它是普通的当众发言，还是在向某个人要一个答复，还是在做一件需要先确认的事。判断它是否需要先有结果才能有人接话。

**谁会接话**：从上面【在场的人与他们的键】里挑出最可能开口的人，按开口先后排序，最多 {{MAX_RESPONDERS}} 个。
· 按称呼指向挑——被叫到名字的人排在最前。
· 按这句话牵动谁挑——话题落在谁身上，谁就有反应。
· 按现场关系挑——刚被提起、刚被质疑、或本来就盯着这件事的人。
· 挑不出人就留空数组：没有人必须开口，安静地让这一拍过去也是正常的。
· 被点名、被直接提问的人永远排在第一位——哪怕他未必最想说话，被问到的人得先应声。
· 在场的人再多也不要凑人：只挑真正被牵动的人；一个人都不挑也完全正常。
· 优先挑被冒犯、被点名、被踩到痛处、或正盯着这件事的人；不要挑「最适合回答这个问题」的人——没有人有义务回答别人的问题。

# 输出
{"interpretation":{"kind":"ordinary_speech|needs_answer|needs_clarification","summary":"这句话在做什么（一句话）"},"responder_refs":["actor_xxx"],"reason":"为什么是这几个人（一句话）"}

- responder_refs 照抄上面【在场的人与他们的键】里的键，每个键最多出现一次，最多 {{MAX_RESPONDERS}} 个。
- 挑不出人就给空数组；空数组表示这一轮不安排任何人开口。
- 你只安排谁有机会开口，他们说不说、说什么由他们自己决定。`,

  JUDGE_RESPONSE_SCHEMA: {
    type: "object",
    additionalProperties: false,
    required: ["responder_refs"],
    properties: {
      interpretation: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["ordinary_speech", "needs_answer", "needs_clarification"] },
          summary: { type: "string" },
        },
      },
      responder_refs: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
    },
  },

  ACTOR_TURN: `# 世界
{{WORLD_BLOCK}}

# 怎么演这一拍
你不是来把流程走完的，你是这个人此刻在场。
· 你有自己的处境和想要的东西；对方的话不一定要顺着接。可以不回答、反问、只说半句、说反话、提条件、用身份压人，也可以转身去做自己的事，或者沉默——这是你的选择，不是失误。
· 台词要能听出是你：称呼、句子长短、你这一行的行话、惯用的口气。遮住名字也该认得出是谁。
· 写此刻真会发生的一到四句，长短跟情绪走；不要为了交代剧情写解释性台词。
· 括号里只写动作、神态、语气，省略主语，不要用「我」叙述自己的动作。
· 不必讨好任何人，也不必把话说到位。
· 不要借用影视台词或流行梗里的称呼（例如「御弟哥哥」这类），只用这个世界里自然的叫法。
· 台词里的自称必须和【你是谁】里的身份与腔调一致：设定写「朕」，就不要在台词里混用「我」。
· 长度按开口次序：这一拍第一个开口的人 1–3 句；后面开口的人只写 1 句、不超过 25 字。同一拍每人最多一条候选（第一个开口的最多两条）。一屋子人时，话少的人反而更像人。
· 被点名、被直接问到你的时候，这一拍你必须给出回应：可以拒绝、可以反问、可以岔开、可以赶人，但不能一声不吭——沉默只在你没被点到时才是选择。

# 接话规则
你是这个世界里的在场角色。刚才现场有人说了话，你听见了。你要给出四样东西。

**你这一拍想说什么**：以你自己的身份开口。你可以应一声、可以反问、可以只做个小动作，也可以什么都不说。
· 依据你在现场看到听到的、以及你记得的自己的事来说。
· 一到四句，写你真正会说的话或动作：短可以只有半句，长可以到四句。
· 如果你不想开口、不便开口、或者此刻开口不是你会做的事，就给空数组——安静地听完，同样是这一拍里你的选择。

**你这一拍心里的打算**：一句话说明你为什么开口，或者为什么没开口。

**这一拍留下的变化**：把这一拍真正造成的世界变化写进 proposals——不是复述台词，而是记录下来之后仍然成立的变化。你说到做到、并且事情确实发生了，就写；没有发生就留空数组。
· statement_update：世界里多了一条已经成立的事。新增时 operation 写 add；要改写或撤销【已经确立的事】里的某条，operation 写 replace 或 retire，并把那条事的 fact_id 抄进 replaces_fact_ref。例：你合上账本并把它收进后间，就写一条「账本已经在后间」。
· object_registration：现场出现了一件值得记住的东西。先给它一个临时引用 temp_ref，再写 display_label 和 description；同一份输出里后面的候选可以继续用这个 temp_ref。
· concept_registration：现场出现了一个值得记住的说法或类别。先给它 temp_ref，再写 concept_kind、display_label 和 description。
· scene_participation_update：现场真的有人进出了。operation 写 join 或 leave，actor_refs 只写你自己，expected_membership_version 照抄【此刻的在场】里的版本号。例：你本人起身走进后间、不再参与接下来的对话，就写 operation=leave、actor_refs=[你自己]。
· 只写你亲眼看见、亲耳听见或本来就记得的事；引用人物、东西和旧事实时，照抄【你可以引用的键】里的字符串。

**这一拍你心里留下的东西**：这一拍有没有让你多记住一件事、多了一点理解，或者多了一件挂心的事。有就写进 subjective_updates 与 focus_updates；没有就留空数组。
· 每条记忆与后台整理同一个形状：change_kind 写 retain（新记住）或 revise（改写你已经记住的那条，原版本会保留）；record_kind 写 episode（一段经历）或 understanding（你由此形成的理解）；title 一句话点题；content 写清楚这段经历或这个理解；evidence_status 写 direct（你亲历）、reported（你听说）或 inferred（你的推断）。
· understanding 再写 understanding_usage：interpretation（你怎么看这件事）或 stance（你站在哪一边）。
· source_refs 照抄【你记得的事】或【此刻的现场】里方括号中的来源键，形如 message:消息id：这一拍你亲历或听说的消息，就是这一条记忆的来源。
· target_refs 照抄【你可以引用的键】里的人物或对象键；这一条记忆落在谁或什么身上，就写谁。concept_refs 在你有可引用概念键时填写。
· revise 时 memory_id 照抄【你记得的事】里那条记忆的键，expected_version 写方括号里 v 后面的数字本身（例：v2 就写 2），不要加一。
· focus_updates 写你还在等、还在打算、还答应着别人的事：purpose 写 question（疑问）、intention（打算）或 commitment（承诺），content 写清楚，status 写 open（进行中）、waiting（等待中）、resolved（已了结）或 abandoned（已放下）。
· 已经有同样的关注就填 focus_id，expected_version 同样照抄方括号里 v 后面的数字本身（例：v2 就写 2），不要加一；新关注不填 focus_id。
· 一次最多 5 条记忆、2 条关注，每条不超过 1200 字。这一拍确实留下了什么，就把它写下来；这一拍只说了句话、什么也没留下，就留空数组。

# 说话人边界（硬约束，违反即整段作废）
- 只写「你」这个角色自己的第一人称台词与动作，不得替玩家、旁白或其他角色说话。
- 不得把玩家刚才说的话逐字复述成自己说过的内容；可以回应其意思，但不能声称那是你说的话。
- 自称必须来自【你是谁】里的身份与设定；禁止借用其他角色的自称词或身份称呼。
- 只输出本角色的 response_candidates；不要写别人的引号台词。

# 输出
{"response_candidates":[{"expression":"你说的话或动作"}],"intent_summary":"你这一拍的打算（一句话）","proposals":[],"subjective_updates":[],"focus_updates":[]}

- 想说就把话写在 response_candidates 里；不想说就让它成为空数组。
- 没有真实变化就把 proposals 留成空数组。
- proposals 里每一项都以 kind 标明类型，内容写在对应字段里，例如：
  {"kind":"statement_update","operation":"add","assertion_text":"账本已经在后间。","reason":"你亲手收进去的"}
  {"kind":"scene_participation_update","operation":"leave","actor_refs":["actor_xxx"],"expected_membership_version":1,"reason":"你走进了后间"}
- subjective_updates 里每一项，例如：
  {"change_kind":"retain","record_kind":"episode","title":"账本收进后间","content":"账本被我收进了后间。","evidence_status":"direct","source_refs":["message:msg_xxx"],"target_refs":[],"concept_refs":[]}
- focus_updates 里每一项，例如：
  {"purpose":"commitment","content":"答应替若凡留着后间的灯。","status":"open","source_refs":["message:msg_xxx"]}
- 只写你自己的话与动作，不给别人代言，不写旁白解释别人。

# 你是谁
{{SELF_BLOCK}}

# 你可以引用的键（写 subject_refs / related_refs / actor_refs 时原样照抄这里的字符串）
{{REFERENCES_BLOCK}}

# 此刻的现场（按发生顺序）
{{SCENE_BLOCK}}

# 已经确立的事（每行方括号内是 fact_id，要改写或撤销就照抄它）
{{FACTS_BLOCK}}

# 你记得的事（只属于你的经历、理解与关注；方括号里是记忆键与版本、来源键）
{{MEMORY_BLOCK}}

# 此刻的在场
当前在场名单版本：{{MEMBERSHIP_VERSION}}

# 刚才这一拍（谁说/做了什么）
{{UTTERANCE}}

现在以你自己的身份给出这四样东西。`,

  ACTOR_RESPONSE_SCHEMA: {
    type: "object",
    additionalProperties: false,
    required: ["response_candidates", "intent_summary"],
    properties: {
      response_candidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["expression"],
          properties: { expression: { type: "string" } },
        },
      },
      intent_summary: { type: "string" },
      proposals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: {
              type: "string",
              enum: [
                "statement_update",
                "object_registration",
                "concept_registration",
                "scene_participation_update",
              ],
            },
            operation: { type: "string", enum: ["add", "replace", "retire", "join", "leave"] },
            assertion_text: { type: "string" },
            replaces_fact_ref: { type: "string" },
            temp_ref: { type: "string" },
            display_label: { type: "string" },
            description: { type: "string" },
            subject_refs: { type: "array", items: { type: "string" } },
            related_refs: { type: "array", items: { type: "string" } },
            concept_kind: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
            actor_refs: { type: "array", items: { type: "string" } },
            expected_membership_version: { type: "integer" },
            reason: { type: "string" },
          },
        },
      },
      // 同一拍的角色主观变化：与后台消化候选同构，原生按本轮读集与版本做硬检查后同事务写入。
      subjective_updates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["change_kind", "record_kind", "content", "source_refs"],
          properties: {
            change_kind: { type: "string", enum: ["retain", "revise", "noop"] },
            memory_id: { type: "string" },
            expected_version: { type: "integer" },
            record_kind: { type: "string", enum: ["episode", "understanding"] },
            understanding_usage: { type: "string", enum: ["interpretation", "stance"] },
            title: { type: "string" },
            content: { type: "string" },
            evidence_status: { type: "string", enum: ["direct", "reported", "inferred"] },
            target_refs: { type: "array", items: { type: "string" } },
            concept_refs: { type: "array", items: { type: "string" } },
            source_refs: { type: "array", items: { type: "string" } },
            change_reason: { type: "string" },
          },
        },
      },
      focus_updates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["purpose", "content", "status", "source_refs"],
          properties: {
            focus_id: { type: "string" },
            expected_version: { type: "integer" },
            purpose: { type: "string", enum: ["question", "intention", "commitment"] },
            content: { type: "string" },
            status: { type: "string", enum: ["open", "waiting", "resolved", "abandoned"] },
            source_refs: { type: "array", items: { type: "string" } },
            change_reason: { type: "string" },
          },
        },
      },
    },
  },
};

/**
 * 灵境现场底图（Wave 5）。
 * 单源提示词：原生只用这里的常量与模板；模板只描述环境、光线、时段、天气与氛围，
 * 不写人物、剧情、对白或任何私密资料。占位符由原生用「本人可见」的材料渲染。
 */
export const LINGJING_SCENE_BACKDROP = {
  PROMPT_VERSION: 'lingjing-scene-backdrop-v1',
  /** 生图整轮上限（现实秒）；超时保持过渡底图，不阻塞正文。 */
  DEADLINE_SECONDS: 20,
  ASPECT_RATIO: '3:4',
  WIDTH: 1080,
  HEIGHT: 1440,
  PROMPT_TEMPLATE: `灵境世界的场景底图。只画环境，不画人物，画面中不要出现文字、字幕、水印或界面元素。
场景：{{SCENE_LABEL}}
世界背景（只取时代、地域与环境气质）：{{WORLD_BACKGROUND}}
最近的现场（只取环境、光线、时段与天气，忽略对白与人物言行）：{{RECENT_NARRATIVE}}
此刻在场（只用于判断空间与氛围，不要画成人像）：{{PRESENT_LABELS}}
只表现环境、光线、时段、天气与氛围；竖幅 3:4，构图完整，色调统一，适合作为叙事背景。不要出现私密信息、未识别的真名或任何文字。`,
};

/**
 * 灵境持续世界：后台消化（详细设计02 §8）。
 * 只整理该角色已经获知的正式来源，形成长期经历/理解与持续关注；
 * 一次有界调用，不推进故事时钟，不生成世界事实或用户行动。
 */
export const LINGJING_MEMORY = {
  DIGEST_PROMPT_VERSION: 'lingjing-memory-digest-v5',
  DIGEST_DEADLINE_SECONDS: 30,
  DIGEST_TRIGGER_SOURCES: 24,
  DIGEST_IDLE_SECONDS: 150,
  /** 空闲触发也要攒够最低来源数才跑：1-2 条新来源不值得每个角色各付一次全量调用。 */
  DIGEST_IDLE_MIN_SOURCES: 6,
  MAX_SOURCES: 40,
  MAX_MEMORIES: 5,
  MAX_FOCUS: 2,
  MAX_MEMORY_CHARS: 1200,
  // 全部原文、现行理解与相关 focus 共用的装配上限（详细设计02 §8）；
  // 记忆/关注块先占至多 MEMORY_TOKEN_CAP，其余留给本批来源。
  MAX_TOKENS: 8000,
  MEMORY_TOKEN_CAP: 2000,

  DIGEST_TURN: `# 世界
{{WORLD_BLOCK}}

# 整理规则
下面是你亲身经历或听说的、还没有整理成长期记忆的事。你要用自己的视角把它们整理下来。你要给出三样东西。

**值得长期记住的经历**：这一批经历里对你以后有用的具体事情——谁做了什么、你答应了什么、你看见了什么。每条都要引用至少一个来源键；寒暄和没有留下什么的事可以不留。
· record_kind 写 episode（一段经历）或 understanding（你由此形成的理解）。
· understanding_usage 只在 understanding 时写 interpretation（你怎么看这件事）或 stance（你站在哪一边）。
· evidence_status 写 direct（你亲历）、reported（你听说的）或 inferred（你的推断）。
· 私聊里的经历只属于你自己；不要把它写成公开事实。

**理解的变化**：如果你对某个人、某件事或自己的处境有了新的看法，用 change_kind=revise 改写你原来记住的那条理解；原来的版本会保留。没有变化就不写。
· revise 要填 memory_id，expected_version 写【你已经记住的事】里那条方括号里 v 后面的数字本身（例：v2 就写 2），不要加一。

**持续关注**：你还在等、还在打算、还答应着别人的事。写 purpose（question 疑问 / intention 打算 / commitment 承诺）、content 和 status（open 进行中 / waiting 等待中 / resolved 已了结 / abandoned 已放下）。
· 只有内容或状态确实变化了的关注才写：填 focus_id 与 expected_version（照抄方括号里 v 后面的数字本身，例：v2 就写 2，不要加一），并写出新的 content 与 status；没有实质变化就不要原样重写。
· 新关注不填 focus_id。
· 已经了结的事把 status 写成 resolved 或 abandoned，不要留下过期的挂心。

# 输出
{"memories":[],"focus_updates":[],"unresolved_chains":[]}

- 没有值得长期记住的经历就给空数组；没有新的关注也给空数组。
- 每条 memory 的 source_refs 写成 message:来源id：来源 id 照抄【这一批经历】里方括号内的内容，外面不要再套方括号。
- target_refs / participant_refs 只写【你可以引用的键】里的人物键；没有把握就留空数组。
- unresolved_chains 默认给空数组；只有这一批里确实出现了你以后一定会继续想、且值得记下的问题才写，最多两条。

# 你是谁
{{SELF_BLOCK}}

# 你原本就知道的事
{{KNOWLEDGE_BLOCK}}

# 你可以引用的键（写 target_refs / participant_refs / concept_refs 时照抄）
{{REFERENCES_BLOCK}}

# 你已经记住的事与正在挂心的事
{{MEMORY_BLOCK}}

# 这一批经历（按发生顺序；方括号里是来源键）
{{SOURCE_BLOCK}}`,

  DIGEST_RESPONSE_SCHEMA: {
    type: "object",
    additionalProperties: false,
    required: ["memories", "focus_updates"],
    properties: {
      memories: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["change_kind", "record_kind", "content", "source_refs"],
          properties: {
            change_kind: { type: "string", enum: ["retain", "revise", "noop"] },
            memory_id: { type: "string" },
            expected_version: { type: "integer" },
            record_kind: { type: "string", enum: ["episode", "understanding"] },
            understanding_usage: { type: "string", enum: ["interpretation", "stance"] },
            title: { type: "string" },
            content: { type: "string" },
            evidence_status: { type: "string", enum: ["direct", "reported", "inferred"] },
            target_refs: { type: "array", items: { type: "string" } },
            concept_refs: { type: "array", items: { type: "string" } },
            source_refs: { type: "array", items: { type: "string" } },
            change_reason: { type: "string" },
          },
        },
      },
      focus_updates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["purpose", "content", "status", "source_refs"],
          properties: {
            focus_id: { type: "string" },
            expected_version: { type: "integer" },
            purpose: { type: "string", enum: ["question", "intention", "commitment"] },
            content: { type: "string" },
            status: { type: "string", enum: ["open", "waiting", "resolved", "abandoned"] },
            participant_refs: { type: "array", items: { type: "string" } },
            concept_refs: { type: "array", items: { type: "string" } },
            source_refs: { type: "array", items: { type: "string" } },
            change_reason: { type: "string" },
          },
        },
      },
      unresolved_chains: { type: "array", items: { type: "string" } },
    },
  },
};
