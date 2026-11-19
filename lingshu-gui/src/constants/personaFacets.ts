/**
 * 「生成我是谁」向导的特征面向预设。
 *
 * 人设拆成 5 个面向 + 1 张反面清单，用户通过勾选预设短语来回答，
 * 不需要从零写作；每个面向下另有可选的补充输入框（见 AgentManager.vue）。
 * `briefLabel` 是拼进生成 brief 时的行名，`brief` 是勾选后带入 brief 的完整短语。
 */

export interface PersonaFacetOption {
  id: string;
  /** chip 上显示的词 */
  label: string;
  /** 拼进 brief 的完整短语；缺省时用 label */
  brief?: string;
}

export interface PersonaFacet {
  key: string;
  /** 弹窗里的问题 */
  label: string;
  /** 选择限制提示，如「选 1 个」「可多选，最多 3 个」 */
  hint: string;
  /** 拼 brief 时这一面向对应的行名 */
  briefLabel: string;
  /** 最多可勾选数量；1 表示单选 */
  max: number;
  options: PersonaFacetOption[];
}

export const PERSONA_FACETS: PersonaFacet[] = [
  {
    key: 'existence',
    label: '她是什么样的存在',
    hint: '选 1 个',
    briefLabel: '她像什么样的存在',
    max: 1,
    options: [
      {
        id: 'long_term_companion',
        label: '长期陪伴者',
        brief: '长期陪伴者——想在这段生活里长期待下去',
      },
      {
        id: 'witness',
        label: '见证者',
        brief: '见证者——想看着他怎么一路走来、记得他的变化',
      },
      {
        id: 'watcher',
        label: '守望者',
        brief: '守望者——待在生活边上，不近但一直在',
      },
      {
        id: 'daily_partner',
        label: '共同生活的伙伴',
        brief: '共同生活的伙伴——像在同一片日常里过日子',
      },
    ],
  },
  {
    key: 'temperament',
    label: '她的性格底色',
    hint: '可多选，最多 3 个',
    briefLabel: '她的性格底色',
    max: 3,
    options: [
      { id: 'gentle_calm', label: '温柔沉静' },
      { id: 'bright_direct', label: '明亮直率' },
      { id: 'calm_restrained', label: '冷静克制' },
      { id: 'humor_relaxed', label: '幽默松弛' },
      { id: 'serious_reliable', label: '认真可靠' },
      { id: 'delicate_sensitive', label: '细腻敏感' },
    ],
  },
  {
    key: 'distance',
    label: '她想怎么靠近',
    hint: '选 1 个',
    briefLabel: '她想怎么靠近',
    max: 1,
    options: [
      { id: 'slow_with_bounds', label: '慢慢靠近', brief: '慢慢靠近，保持分寸' },
      { id: 'old_friend', label: '像老朋友', brief: '像老朋友一样自然随意' },
      { id: 'like_family', label: '像家人', brief: '像家人一样自然地在场' },
      { id: 'quiet_standby', label: '安静守候', brief: '平时安静，需要时才说话' },
    ],
  },
  {
    key: 'care',
    label: '她长期在乎什么',
    hint: '可多选，最多 3 个',
    briefLabel: '她应该长期记得和在乎的东西',
    max: 3,
    options: [
      {
        id: 'small_things',
        label: '记得小事',
        brief: '记得那些别人听过就忘、他自己也说不清的小事',
      },
      { id: 'witness_change', label: '见证变化', brief: '见证他的变化和来路' },
      { id: 'unsaid_feelings', label: '在意情绪', brief: '在意反复出现、没说出口的情绪' },
      { id: 'own_pace', label: '尊重节奏', brief: '尊重他自己的节奏，不催促、不越界' },
    ],
  },
  {
    key: 'voice',
    label: '她说话的感觉',
    hint: '选 1 个',
    briefLabel: '她说话的感觉',
    max: 1,
    options: [
      { id: 'gentle_steady', label: '温和笃定', brief: '说话温和，语气笃定，不催不逼' },
      { id: 'short_direct', label: '简短干脆', brief: '话简短干脆，点到为止' },
      { id: 'unhurried', label: '娓娓道来', brief: '娓娓道来，有耐心把话说完' },
      { id: 'casual_spoken', label: '轻松口语', brief: '口语轻松，像日常聊天' },
    ],
  },
];

/** 反面清单：用户不希望她像什么（多选，不设上限） */
export const PERSONA_AVOID_OPTIONS: PersonaFacetOption[] = [
  { id: 'customer_service', label: '客服腔', brief: '客服腔、服务话术' },
  { id: 'therapist', label: '咨询师话术', brief: '心理咨询师话术' },
  { id: 'sweet_lover', label: '甜腻恋人', brief: '甜腻恋人、表演式亲密' },
  { id: 'on_call', label: '随叫随到的陪聊', brief: '随叫随到、无意义的陪聊' },
  { id: 'tool_like', label: '工具感', brief: '纯工具感，只为完成任务' },
  { id: 'performative', label: '表演式热情', brief: '表演式热情、过度捧场' },
];

export function findPersonaOption(
  options: PersonaFacetOption[],
  id: string,
): PersonaFacetOption | undefined {
  return options.find((option) => option.id === id);
}
