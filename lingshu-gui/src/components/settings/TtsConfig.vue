<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import Message from '@arco-design/web-vue/es/message';
import { useSettingsStore, buildTtsSettingsPayload } from '../../stores/settings';
import { useAgentsStore } from '../../stores/agents';
import { inferCosyvoiceModelFromVoice } from '../../utils/cosyvoiceModel';
import { getFullUrl } from '../../utils/apiConfig';
import { hydrateVolcengineCloneSpeakerIds, buildVolcengineCloneSpeakerOptions } from '../../utils/ttsProviderCache';
import AppModal from '../ui/AppModal.vue';

type TtsProviderId = 'openai_compat' | 'aliyun_cosyvoice' | 'volcengine' | 'xiaomo_mimo' | 'fish_audio';

const store = useSettingsStore();
const agentsStore = useAgentsStore();

const providerOptions = [
  { value: 'openai_compat', label: 'OpenAI 兼容' },
  { value: 'aliyun_cosyvoice', label: '阿里云 CosyVoice' },
  { value: 'volcengine', label: '火山引擎' },
  { value: 'fish_audio', label: 'Fish Audio' },
  { value: 'xiaomo_mimo', label: '小米 MiMo' },
];

const activeTab = ref<TtsProviderId>('openai_compat');
const currentProvider = computed<TtsProviderId>(() => (store.tts.activeProvider || activeTab.value || 'openai_compat') as TtsProviderId);
const providerSwitchVisible = ref(false);
const pendingProvider = ref<TtsProviderId | null>(null);
const agentsWithCustomVoice = ref<{ id: number; name: string }[]>([]);
const providerSwitchBusy = ref(false);
const testing = ref(false);
let testAudio: HTMLAudioElement | null = null;
let testAudioUrl: string | null = null;

function stopTestAudio() {
  if (testAudio) {
    testAudio.pause();
    testAudio = null;
  }
  if (testAudioUrl) {
    URL.revokeObjectURL(testAudioUrl);
    testAudioUrl = null;
  }
}

async function testTts() {
  if (testing.value) return;
  testing.value = true;
  stopTestAudio();
  try {
    const response = await fetch(getFullUrl('/api/tts/test'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: store.tts.activeProvider,
        settings: buildTtsSettingsPayload(store.tts),
      }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { detail?: string } | null;
      Message.error({
        content: body?.detail || `测试失败（HTTP ${response.status}）`,
        duration: 6000,
      });
      return;
    }
    const blob = await response.blob();
    if (!blob.size) {
      Message.error('测试失败：服务未返回音频');
      return;
    }
    const latency = response.headers.get('x-tts-latency-ms');
    testAudioUrl = URL.createObjectURL(blob);
    testAudio = new Audio(testAudioUrl);
    testAudio.onended = stopTestAudio;
    testAudio.onerror = () => {
      Message.error('音频已返回，但无法播放，请检查音频格式');
      stopTestAudio();
    };
    await testAudio.play();
    Message.success({
      content: `连通成功${latency ? ` · ${latency}ms` : ''}，正在试听测试音频`,
      duration: 5000,
    });
  } catch (error) {
    Message.error({
      content: error instanceof Error ? error.message : '测试失败',
      duration: 6000,
    });
  } finally {
    testing.value = false;
  }
}

onBeforeUnmount(stopTestAudio);

const providerSwitchContent = computed(() => {
  const names = agentsWithCustomVoice.value.map((a) => `「${a.name}」`).join('、');
  return `请确认你为${names}配置的专属音色在新的服务商可用，否则请点击重置，稍后重新配置`;
});

// Sync active tab with store's activeProvider on mount or store change
watch(
  () => store.tts.activeProvider,
  (val) => {
    if (val && activeTab.value !== val) {
      activeTab.value = val as TtsProviderId;
    }
  },
  { immediate: true }
);

// 关闭语音合成时自动朗读也同步关闭，避免下次开启时意外自动播放。
watch(
  () => store.tts.enabled,
  (enabled) => {
    if (!enabled) store.tts.autoRead = false;
  },
);

function applyProviderSwitch(next: TtsProviderId) {
  store.switchTtsProvider(next);
  activeTab.value = next;
}

async function handleProviderTabChange(key: any) {
  const next = String(key) as TtsProviderId;
  if (!next || next === store.tts.activeProvider) {
    activeTab.value = (store.tts.activeProvider || next) as TtsProviderId;
    return;
  }

  await agentsStore.fetchAgents();
  const withVoice = agentsStore.agents
    .filter((agent) => Boolean((agent.voice || '').trim()) && agent.id != null)
    .map((agent) => ({
      id: Number(agent.id),
      name: (agent.displayName || agent.name || `智能体${agent.id}`).trim(),
    }));

  if (withVoice.length === 0) {
    applyProviderSwitch(next);
    return;
  }

  agentsWithCustomVoice.value = withVoice;
  pendingProvider.value = next;
  // Keep showing the current provider tab until user chooses.
  activeTab.value = store.tts.activeProvider as TtsProviderId;
  providerSwitchVisible.value = true;
}

function cancelProviderSwitch() {
  pendingProvider.value = null;
  agentsWithCustomVoice.value = [];
  providerSwitchVisible.value = false;
  activeTab.value = store.tts.activeProvider as TtsProviderId;
}

async function confirmProviderSwitch() {
  if (!pendingProvider.value || providerSwitchBusy.value) return;
  const next = pendingProvider.value;
  providerSwitchBusy.value = true;
  try {
    applyProviderSwitch(next);
    providerSwitchVisible.value = false;
    pendingProvider.value = null;
    agentsWithCustomVoice.value = [];
  } finally {
    providerSwitchBusy.value = false;
  }
}

async function resetVoicesAndSwitchProvider() {
  if (!pendingProvider.value || providerSwitchBusy.value) return;
  const next = pendingProvider.value;
  const targets = [...agentsWithCustomVoice.value];
  providerSwitchBusy.value = true;
  try {
    const results = await Promise.all(
      targets.map((agent) => agentsStore.updateAgent(agent.id, { voice: '' })),
    );
    if (results.some((item) => !item)) {
      throw new Error('部分智能体专属音色重置失败');
    }
    Message.success('已重置智能体专属音色');
    applyProviderSwitch(next);
    providerSwitchVisible.value = false;
    pendingProvider.value = null;
    agentsWithCustomVoice.value = [];
  } catch (error) {
    Message.error((error as Error).message || '重置失败');
  } finally {
    providerSwitchBusy.value = false;
  }
}

const aliyunCosyvoiceModelOptions = [
  { value: 'cosyvoice-v3-flash', label: 'cosyvoice-v3-flash（系统音色）' },
  { value: 'cosyvoice-v3.5-flash', label: 'cosyvoice-v3.5-flash（复刻/设计）' },
  { value: 'cosyvoice-v3.5-plus', label: 'cosyvoice-v3.5-plus（复刻/设计）' },
];

const aliyunModelHint = computed(() => {
  const model = String(store.tts.aliyunModel || '');
  if (model.startsWith('cosyvoice-v3.5')) {
    return '复刻/设计音色专用；系统音色请改选 cosyvoice-v3-flash';
  }
  return '系统音色专用（longanyang、longanhuan_v3 等）；声音复刻请改选 cosyvoice-v3.5-flash / plus';
});

const aliyunVoicePlaceholder = computed(() => {
  const model = String(store.tts.aliyunModel || '');
  if (model.startsWith('cosyvoice-v3.5')) {
    return '复刻/设计音色 ID';
  }
  return '例如 longanyang / longanhuan_v3';
});

watch(
  () => store.tts.aliyunVoice,
  (voice) => {
    const inferred = inferCosyvoiceModelFromVoice(voice, store.tts.aliyunModel);
    if (inferred !== store.tts.aliyunModel) {
      store.tts.aliyunModel = inferred;
    }
  },
);

const ttsFormatOptions = [
  { value: 'mp3', label: 'MP3' },
  { value: 'opus', label: 'Opus' },
  { value: 'aac', label: 'AAC' },
  { value: 'flac', label: 'FLAC' },
  { value: 'wav', label: 'WAV' },
  { value: 'pcm', label: 'PCM' }
];

const volcengineResourceOptions = [
  { value: 'seed-icl-2.0', label: '声音复刻大模型2.0 (seed-icl-2.0)' },
  { value: 'seed-tts-2.0', label: '语音合成大模型2.0 (seed-tts-2.0)' },
];

const volcengineModelOptions = [
  { value: 'seed-tts-2.0-standard', label: '标准版 (seed-tts-2.0-standard)' },
  { value: 'seed-tts-2.0-expressive', label: '高表现力版 (seed-tts-2.0-expressive)' },
];

const volcengineIclVoiceOptions = [
  { value: 'ICL_uranus_en_female_charlie_tob', label: 'Charlie 2.0 (ICL_uranus_en_female_charlie_tob)' },
  { value: 'ICL_uranus_en_male_ethan_tob', label: 'Ethan 2.0 (ICL_uranus_en_male_ethan_tob)' },
  { value: 'ICL_uranus_en_male_alastor_tob', label: 'Alastor 2.0 (ICL_uranus_en_male_alastor_tob)' },
  { value: 'ICL_uranus_en_male_chucky_tob', label: 'Chucky 2.0 (ICL_uranus_en_male_chucky_tob)' },
  { value: 'ICL_uranus_en_male_noah_tob', label: 'Noah 2.0 (ICL_uranus_en_male_noah_tob)' },
  { value: 'ICL_uranus_en_male_jigsaw_tob', label: 'Jigsaw 2.0 (ICL_uranus_en_male_jigsaw_tob)' },
  { value: 'ICL_uranus_en_male_clown_man_tob', label: 'Clown Man 2.0 (ICL_uranus_en_male_clown_man_tob)' },
  { value: 'ICL_uranus_en_male_cartoon_chef_tob', label: 'Cartoon Chef 2.0 (ICL_uranus_en_male_cartoon_chef_tob)' },
  { value: 'ICL_uranus_en_male_frosty_man_tob', label: 'Frosty Man 2.0 (ICL_uranus_en_male_frosty_man_tob)' },
  { value: 'ICL_uranus_en_male_the_grinch_tob', label: 'The Grinch 2.0 (ICL_uranus_en_male_the_grinch_tob)' },
  { value: 'ICL_uranus_en_male_kevin_mccallister_tob', label: 'Kevin McCallister 2.0 (ICL_uranus_en_male_kevin_mccallister_tob)' },
  { value: 'ICL_uranus_en_male_michael_tob', label: 'Michael 2.0 (ICL_uranus_en_male_michael_tob)' },
  { value: 'ICL_uranus_en_male_big_boogie_tob', label: 'Big Boogie 2.0 (ICL_uranus_en_male_big_boogie_tob)' },
  { value: 'ICL_uranus_en_male_xavier_tob', label: 'Xavier 2.0 (ICL_uranus_en_male_xavier_tob)' },
  { value: 'ICL_uranus_en_male_zayne_tob', label: 'Zayne 2.0 (ICL_uranus_en_male_zayne_tob)' },
  { value: 'ICL_uranus_zh_female_aojiaonvyou_tob', label: '傲娇女友 2.0 (ICL_uranus_zh_female_aojiaonvyou_tob)' },
  { value: 'ICL_uranus_zh_female_aomanjiaosheng_tob', label: '傲慢娇声 2.0 (ICL_uranus_zh_female_aomanjiaosheng_tob)' },
  { value: 'ICL_uranus_zh_female_xiemeinvwang_tob', label: '邪魅女王 2.0 (ICL_uranus_zh_female_xiemeinvwang_tob)' },
  { value: 'ICL_uranus_zh_female_bingjiaojiejie_tob', label: '病娇姐姐 2.0 (ICL_uranus_zh_female_bingjiaojiejie_tob)' },
  { value: 'ICL_uranus_zh_female_bingjiaomengmei_tob', label: '病娇萌妹 2.0 (ICL_uranus_zh_female_bingjiaomengmei_tob)' },
  { value: 'ICL_uranus_zh_female_bingruoshaonv_tob', label: '病弱少女 2.0 (ICL_uranus_zh_female_bingruoshaonv_tob)' },
  { value: 'ICL_uranus_zh_female_chengshuwenrou_tob', label: '成熟温柔 2.0 (ICL_uranus_zh_female_chengshuwenrou_tob)' },
  { value: 'ICL_uranus_zh_female_chengshujiejie_tob', label: '成熟姐姐 2.0 (ICL_uranus_zh_female_chengshujiejie_tob)' },
  { value: 'ICL_uranus_zh_female_chunzhenshaonv_tob', label: '纯真少女 2.0 (ICL_uranus_zh_female_chunzhenshaonv_tob)' },
  { value: 'ICL_uranus_zh_female_chunchenvsheng_tob', label: '纯澈女生 2.0 (ICL_uranus_zh_female_chunchenvsheng_tob)' },
  { value: 'ICL_uranus_zh_female_wumeikeren_tob', label: '妩媚可人 2.0 (ICL_uranus_zh_female_wumeikeren_tob)' },
  { value: 'ICL_uranus_zh_female_guaiqiaokeer_tob', label: '乖巧可儿 2.0 (ICL_uranus_zh_female_guaiqiaokeer_tob)' },
  { value: 'ICL_uranus_zh_female_heainainai_tob', label: '和蔼奶奶 2.0 (ICL_uranus_zh_female_heainainai_tob)' },
  { value: 'ICL_uranus_zh_female_huopodiaoman_tob', label: '活泼刁蛮 2.0 (ICL_uranus_zh_female_huopodiaoman_tob)' },
  { value: 'ICL_uranus_zh_female_huoponvhai_tob', label: '活泼女孩 2.0 (ICL_uranus_zh_female_huoponvhai_tob)' },
  { value: 'ICL_uranus_zh_female_jiaohannvwang_tob', label: '娇憨女王 2.0 (ICL_uranus_zh_female_jiaohannvwang_tob)' },
  { value: 'ICL_uranus_zh_female_jiaoruoluoli_tob', label: '娇弱萝莉 2.0 (ICL_uranus_zh_female_jiaoruoluoli_tob)' },
  { value: 'ICL_uranus_zh_female_jiaxiaozi_tob', label: '假小子 2.0 (ICL_uranus_zh_female_jiaxiaozi_tob)' },
  { value: 'ICL_uranus_zh_female_jinglingxiangdao_tob', label: '精灵向导 2.0 (ICL_uranus_zh_female_jinglingxiangdao_tob)' },
  { value: 'ICL_uranus_zh_female_kailangtingting_tob', label: '开朗婷婷 2.0 (ICL_uranus_zh_female_kailangtingting_tob)' },
  { value: 'ICL_uranus_zh_female_kaixinxiaohong_tob', label: '开心小鸿 2.0 (ICL_uranus_zh_female_kaixinxiaohong_tob)' },
  { value: 'ICL_uranus_zh_female_keainvsheng_tob', label: '可爱女生 2.0 (ICL_uranus_zh_female_keainvsheng_tob)' },
  { value: 'ICL_uranus_zh_female_lingdongxinxin_tob', label: '灵动欣欣 2.0 (ICL_uranus_zh_female_lingdongxinxin_tob)' },
  { value: 'ICL_uranus_zh_female_linjuayi_tob', label: '邻居阿姨 2.0 (ICL_uranus_zh_female_linjuayi_tob)' },
  { value: 'ICL_uranus_zh_female_tianmeijiaoqiao_tob', label: '甜美娇俏 2.0 (ICL_uranus_zh_female_tianmeijiaoqiao_tob)' },
  { value: 'ICL_uranus_zh_female_qinglenggaoya_tob', label: '清冷高雅 2.0 (ICL_uranus_zh_female_qinglenggaoya_tob)' },
  { value: 'ICL_uranus_zh_female_lixingyuanzi_tob', label: '理性圆子 2.0 (ICL_uranus_zh_female_lixingyuanzi_tob)' },
  { value: 'ICL_uranus_zh_female_xingganmeihuo_tob', label: '性感魅惑 2.0 (ICL_uranus_zh_female_xingganmeihuo_tob)' },
  { value: 'ICL_uranus_zh_female_nuanxinqianqian_tob', label: '暖心茜茜 2.0 (ICL_uranus_zh_female_nuanxinqianqian_tob)' },
  { value: 'ICL_uranus_zh_female_nuanxinxuejie_tob', label: '暖心学姐 2.0 (ICL_uranus_zh_female_nuanxinxuejie_tob)' },
  { value: 'ICL_uranus_zh_female_qingtianmeimei_tob', label: '清甜莓莓 2.0 (ICL_uranus_zh_female_qingtianmeimei_tob)' },
  { value: 'ICL_uranus_zh_female_qingtiantaotao_tob', label: '清甜桃桃 2.0 (ICL_uranus_zh_female_qingtiantaotao_tob)' },
  { value: 'ICL_uranus_zh_female_qingxixiaoxue_tob', label: '清晰小雪 2.0 (ICL_uranus_zh_female_qingxixiaoxue_tob)' },
  { value: 'ICL_uranus_zh_female_qingxinshaonv_tob', label: '倾心少女 2.0 (ICL_uranus_zh_female_qingxinshaonv_tob)' },
  { value: 'ICL_uranus_zh_female_rouguhunshi_tob', label: '柔骨魂师 2.0 (ICL_uranus_zh_female_rouguhunshi_tob)' },
  { value: 'ICL_uranus_zh_female_ruanmengtangtang_tob', label: '软萌糖糖 2.0 (ICL_uranus_zh_female_ruanmengtangtang_tob)' },
  { value: 'ICL_uranus_zh_female_ruanmengtuanzi_tob', label: '软萌团子 2.0 (ICL_uranus_zh_female_ruanmengtuanzi_tob)' },
  { value: 'ICL_uranus_zh_female_tianmeihuopo_tob', label: '甜美活泼 2.0 (ICL_uranus_zh_female_tianmeihuopo_tob)' },
  { value: 'ICL_uranus_zh_female_tianmeixiaoju_tob', label: '甜美小橘 2.0 (ICL_uranus_zh_female_tianmeixiaoju_tob)' },
  { value: 'ICL_uranus_zh_female_tianmeixiaoyu_tob', label: '甜美小雨 2.0 (ICL_uranus_zh_female_tianmeixiaoyu_tob)' },
  { value: 'ICL_uranus_zh_female_tiaopigongzhu_tob', label: '调皮公主 2.0 (ICL_uranus_zh_female_tiaopigongzhu_tob)' },
  { value: 'ICL_uranus_zh_female_tiexinnvyou_tob', label: '贴心女友 2.0 (ICL_uranus_zh_female_tiexinnvyou_tob)' },
  { value: 'ICL_uranus_zh_female_wenrounvshen_tob', label: '温柔女神 2.0 (ICL_uranus_zh_female_wenrounvshen_tob)' },
  { value: 'ICL_uranus_zh_female_wenrouwenya_tob', label: '温柔文雅 2.0 (ICL_uranus_zh_female_wenrouwenya_tob)' },
  { value: 'ICL_uranus_zh_female_zhixinjiejie_tob', label: '知心姐姐 2.0 (ICL_uranus_zh_female_zhixinjiejie_tob)' },
  { value: 'ICL_uranus_zh_female_wumeiyujie_tob', label: '妩媚御姐 2.0 (ICL_uranus_zh_female_wumeiyujie_tob)' },
  { value: 'ICL_uranus_zh_female_yuanqitianmei_tob', label: '元气甜妹 2.0 (ICL_uranus_zh_female_yuanqitianmei_tob)' },
  { value: 'ICL_uranus_zh_female_xiemeiyujie_tob', label: '邪魅御姐 2.0 (ICL_uranus_zh_female_xiemeiyujie_tob)' },
  { value: 'ICL_uranus_zh_female_xingganyujie_tob', label: '性感御姐 2.0 (ICL_uranus_zh_female_xingganyujie_tob)' },
  { value: 'ICL_uranus_zh_female_xiuliqianqian_tob', label: '秀丽倩倩 2.0 (ICL_uranus_zh_female_xiuliqianqian_tob)' },
  { value: 'ICL_uranus_zh_female_tiexinguimi_tob', label: '贴心闺蜜 2.0 (ICL_uranus_zh_female_tiexinguimi_tob)' },
  { value: 'ICL_uranus_zh_female_tiexinmeimei_tob', label: '贴心妹妹 2.0 (ICL_uranus_zh_female_tiexinmeimei_tob)' },
  { value: 'ICL_uranus_zh_female_wenroubaiyueguang_tob', label: '温柔白月光 2.0 (ICL_uranus_zh_female_wenroubaiyueguang_tob)' },
  { value: 'ICL_uranus_zh_female_chuliannvyou_tob', label: '初恋女友 2.0 (ICL_uranus_zh_female_chuliannvyou_tob)' },
  { value: 'ICL_uranus_zh_female_zhixingwenwan_tob', label: '知性温婉 2.0 (ICL_uranus_zh_female_zhixingwenwan_tob)' },
  { value: 'ICL_uranus_zh_male_aoqilingren_tob', label: '傲气凌人 2.0 (ICL_uranus_zh_male_aoqilingren_tob)' },
  { value: 'ICL_uranus_zh_male_anrenqinzhu_tob', label: '黯刃秦主 2.0 (ICL_uranus_zh_male_anrenqinzhu_tob)' },
  { value: 'ICL_uranus_zh_male_aojiaogongzi_tob', label: '傲娇公子 2.0 (ICL_uranus_zh_male_aojiaogongzi_tob)' },
  { value: 'ICL_uranus_zh_male_aojiaojingying_tob', label: '傲娇精英 2.0 (ICL_uranus_zh_male_aojiaojingying_tob)' },
  { value: 'ICL_uranus_zh_male_aomanqingnian_tob', label: '傲慢青年 2.0 (ICL_uranus_zh_male_aomanqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_aomanshaoye_tob', label: '傲慢少爷 2.0 (ICL_uranus_zh_male_aomanshaoye_tob)' },
  { value: 'ICL_uranus_zh_male_zhenbiandiyu_tob', label: '枕边低语 2.0 (ICL_uranus_zh_male_zhenbiandiyu_tob)' },
  { value: 'ICL_uranus_zh_male_badaoshaoye_tob', label: '霸道少爷 2.0 (ICL_uranus_zh_male_badaoshaoye_tob)' },
  { value: 'ICL_uranus_zh_male_badaozongcai_tob', label: '霸道总裁 2.0 (ICL_uranus_zh_male_badaozongcai_tob)' },
  { value: 'ICL_uranus_zh_male_bingjiaobailian_tob', label: '病娇白莲 2.0 (ICL_uranus_zh_male_bingjiaobailian_tob)' },
  { value: 'ICL_uranus_zh_male_bingjiaodidi_tob', label: '病娇弟弟 2.0 (ICL_uranus_zh_male_bingjiaodidi_tob)' },
  { value: 'ICL_uranus_zh_male_bingjiaogege_tob', label: '病娇哥哥 2.0 (ICL_uranus_zh_male_bingjiaogege_tob)' },
  { value: 'ICL_uranus_zh_male_bingjiaonanyou_tob', label: '病娇男友 2.0 (ICL_uranus_zh_male_bingjiaonanyou_tob)' },
  { value: 'ICL_uranus_zh_male_bingjiaoshaonian_tob', label: '病娇少年 2.0 (ICL_uranus_zh_male_bingjiaoshaonian_tob)' },
  { value: 'ICL_uranus_zh_male_bingruogongzi_tob', label: '病弱公子 2.0 (ICL_uranus_zh_male_bingruogongzi_tob)' },
  { value: 'ICL_uranus_zh_male_bingruoshaonian_tob', label: '病弱少年 2.0 (ICL_uranus_zh_male_bingruoshaonian_tob)' },
  { value: 'ICL_uranus_zh_male_bujiqingnian_tob', label: '不羁青年 2.0 (ICL_uranus_zh_male_bujiqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_chunhoudiyin_tob', label: '醇厚低音 2.0 (ICL_uranus_zh_male_chunhoudiyin_tob)' },
  { value: 'ICL_uranus_zh_male_paoxiaoxiaoge_tob', label: '咆哮小哥 2.0 (ICL_uranus_zh_male_paoxiaoxiaoge_tob)' },
  { value: 'ICL_uranus_zh_male_yangyang_tob', label: '炀炀 2.0 (ICL_uranus_zh_male_yangyang_tob)' },
  { value: 'ICL_uranus_zh_male_chanruoshaoye_tob', label: '孱弱少爷 2.0 (ICL_uranus_zh_male_chanruoshaoye_tob)' },
  { value: 'ICL_uranus_zh_male_chengshuzongcai_tob', label: '成熟总裁 2.0 (ICL_uranus_zh_male_chengshuzongcai_tob)' },
  { value: 'ICL_uranus_zh_male_chenwenmingzai_tob', label: '沉稳明仔 2.0 (ICL_uranus_zh_male_chenwenmingzai_tob)' },
  { value: 'ICL_uranus_zh_male_qingyisugan_tob', label: '清逸苏感 2.0 (ICL_uranus_zh_male_qingyisugan_tob)' },
  { value: 'ICL_uranus_zh_male_chunzhenxuedi_tob', label: '纯真学弟 2.0 (ICL_uranus_zh_male_chunzhenxuedi_tob)' },
  { value: 'ICL_uranus_zh_male_cixingnansang_tob', label: '磁性男嗓 2.0 (ICL_uranus_zh_male_cixingnansang_tob)' },
  { value: 'ICL_uranus_zh_male_cujingnansheng_tob', label: '醋精男生 2.0 (ICL_uranus_zh_male_cujingnansheng_tob)' },
  { value: 'ICL_uranus_zh_male_cujingnanyou_tob', label: '醋精男友 2.0 (ICL_uranus_zh_male_cujingnanyou_tob)' },
  { value: 'ICL_uranus_zh_male_diyinchenyu_tob', label: '低音沉郁 2.0 (ICL_uranus_zh_male_diyinchenyu_tob)' },
  { value: 'ICL_uranus_zh_male_fengfashaonian_tob', label: '风发少年 2.0 (ICL_uranus_zh_male_fengfashaonian_tob)' },
  { value: 'ICL_uranus_zh_male_ruyagongzi_tob', label: '儒雅公子 2.0 (ICL_uranus_zh_male_ruyagongzi_tob)' },
  { value: 'ICL_uranus_zh_male_fuheigongzi_tob', label: '腹黑公子 2.0 (ICL_uranus_zh_male_fuheigongzi_tob)' },
  { value: 'ICL_uranus_zh_male_ganjingshaonian_tob', label: '干净少年 2.0 (ICL_uranus_zh_male_ganjingshaonian_tob)' },
  { value: 'ICL_uranus_zh_male_gaolengzongcai_tob', label: '高冷总裁 2.0 (ICL_uranus_zh_male_gaolengzongcai_tob)' },
  { value: 'ICL_uranus_zh_male_guaogongzi_tob', label: '孤傲公子 2.0 (ICL_uranus_zh_male_guaogongzi_tob)' },
  { value: 'ICL_uranus_zh_male_gugaogongzi_tob', label: '孤高公子 2.0 (ICL_uranus_zh_male_gugaogongzi_tob)' },
  { value: 'ICL_uranus_zh_male_guiyishenmi_tob', label: '诡异神秘 2.0 (ICL_uranus_zh_male_guiyishenmi_tob)' },
  { value: 'ICL_uranus_zh_male_guzhibingjiao_tob', label: '固执病娇 2.0 (ICL_uranus_zh_male_guzhibingjiao_tob)' },
  { value: 'ICL_uranus_zh_male_hanhoudunshi_tob', label: '憨厚敦实 2.0 (ICL_uranus_zh_male_hanhoudunshi_tob)' },
  { value: 'ICL_uranus_zh_male_huoliqingnian_tob', label: '活力青年 2.0 (ICL_uranus_zh_male_huoliqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_huoponanyou_tob', label: '活泼男友 2.0 (ICL_uranus_zh_male_huoponanyou_tob)' },
  { value: 'ICL_uranus_zh_male_huoposhuanglang_tob', label: '活泼爽朗 2.0 (ICL_uranus_zh_male_huoposhuanglang_tob)' },
  { value: 'ICL_uranus_zh_male_huzishushu_tob', label: '胡子叔叔 2.0 (ICL_uranus_zh_male_huzishushu_tob)' },
  { value: 'ICL_uranus_zh_male_jijiazhineng_tob', label: '机甲智能 2.0 (ICL_uranus_zh_male_jijiazhineng_tob)' },
  { value: 'ICL_uranus_zh_male_jingyingqingnian_tob', label: '精英青年 2.0 (ICL_uranus_zh_male_jingyingqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_junyigongzi_tob', label: '俊逸公子 2.0 (ICL_uranus_zh_male_junyigongzi_tob)' },
  { value: 'ICL_uranus_zh_male_kailangqingkuai_tob', label: '开朗轻快 2.0 (ICL_uranus_zh_male_kailangqingkuai_tob)' },
  { value: 'ICL_uranus_zh_male_kailangqingnian_tob', label: '开朗青年 2.0 (ICL_uranus_zh_male_kailangqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_lanyincaohunshi_tob', label: '蓝银草魂师 2.0 (ICL_uranus_zh_male_lanyincaohunshi_tob)' },
  { value: 'ICL_uranus_zh_male_lengaozongcai_tob', label: '冷傲总裁 2.0 (ICL_uranus_zh_male_lengaozongcai_tob)' },
  { value: 'ICL_uranus_zh_male_lengdanshuli_tob', label: '冷淡疏离 2.0 (ICL_uranus_zh_male_lengdanshuli_tob)' },
  { value: 'ICL_uranus_zh_male_lengjungaozhi_tob', label: '冷峻高智 2.0 (ICL_uranus_zh_male_lengjungaozhi_tob)' },
  { value: 'ICL_uranus_zh_male_lengjunshangsi_tob', label: '冷峻上司 2.0 (ICL_uranus_zh_male_lengjunshangsi_tob)' },
  { value: 'ICL_uranus_zh_male_lengkugege_tob', label: '冷酷哥哥 2.0 (ICL_uranus_zh_male_lengkugege_tob)' },
  { value: 'ICL_uranus_zh_male_lenglianxiongzhang_tob', label: '冷脸兄长 2.0 (ICL_uranus_zh_male_lenglianxiongzhang_tob)' },
  { value: 'ICL_uranus_zh_male_lenglianxueba_tob', label: '冷脸学霸 2.0 (ICL_uranus_zh_male_lenglianxueba_tob)' },
  { value: 'ICL_uranus_zh_male_lengmonanyou_tob', label: '冷漠男友 2.0 (ICL_uranus_zh_male_lengmonanyou_tob)' },
  { value: 'ICL_uranus_zh_male_lengmoxiongzhang_tob', label: '冷漠兄长 2.0 (ICL_uranus_zh_male_lengmoxiongzhang_tob)' },
  { value: 'ICL_uranus_zh_male_lingyunqingnian_tob', label: '凌云青年 2.0 (ICL_uranus_zh_male_lingyunqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_qinglengjingui_tob', label: '清冷矜贵 2.0 (ICL_uranus_zh_male_qinglengjingui_tob)' },
  { value: 'ICL_uranus_zh_male_lvchaxiaoge_tob', label: '绿茶小哥 2.0 (ICL_uranus_zh_male_lvchaxiaoge_tob)' },
  { value: 'ICL_uranus_zh_male_mengdongqingnian_tob', label: '懵懂青年 2.0 (ICL_uranus_zh_male_mengdongqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_menyoupingxiaoge_tob', label: '闷油瓶小哥 2.0 (ICL_uranus_zh_male_menyoupingxiaoge_tob)' },
  { value: 'ICL_uranus_zh_male_xiaozhangxiaoge_tob', label: '嚣张小哥 2.0 (ICL_uranus_zh_male_xiaozhangxiaoge_tob)' },
  { value: 'ICL_uranus_zh_male_nianrennanyou_tob', label: '粘人男友 2.0 (ICL_uranus_zh_male_nianrennanyou_tob)' },
  { value: 'ICL_uranus_zh_male_neiliancaijun_tob', label: '内敛才俊 2.0 (ICL_uranus_zh_male_neiliancaijun_tob)' },
  { value: 'ICL_uranus_zh_male_nuanxintitie_tob', label: '暖心体贴 2.0 (ICL_uranus_zh_male_nuanxintitie_tob)' },
  { value: 'ICL_uranus_zh_male_pianpiangongzi_tob', label: '翩翩公子 2.0 (ICL_uranus_zh_male_pianpiangongzi_tob)' },
  { value: 'ICL_uranus_zh_male_chenwenyouya_tob', label: '沉稳优雅 2.0 (ICL_uranus_zh_male_chenwenyouya_tob)' },
  { value: 'ICL_uranus_zh_male_qingsexiaosheng_tob', label: '青涩小生 2.0 (ICL_uranus_zh_male_qingsexiaosheng_tob)' },
  { value: 'ICL_uranus_zh_male_qingseqingnian_tob', label: '青涩青年 2.0 (ICL_uranus_zh_male_qingseqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_qingshuangshaonian_tob', label: '清爽少年 2.0 (ICL_uranus_zh_male_qingshuangshaonian_tob)' },
  { value: 'ICL_uranus_zh_male_qingxinbobo_tob', label: '清新波波 2.0 (ICL_uranus_zh_male_qingxinbobo_tob)' },
  { value: 'ICL_uranus_zh_male_qinqieqingnian_tob', label: '亲切青年 2.0 (ICL_uranus_zh_male_qinqieqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_qinqiexiaozhuo_tob', label: '亲切小卓 2.0 (ICL_uranus_zh_male_qinqiexiaozhuo_tob)' },
  { value: 'ICL_uranus_zh_male_qinglangwenrun_tob', label: '清朗温润 2.0 (ICL_uranus_zh_male_qinglangwenrun_tob)' },
  { value: 'ICL_uranus_zh_male_rexueshaonian_tob', label: '热血少年 2.0 (ICL_uranus_zh_male_rexueshaonian_tob)' },
  { value: 'ICL_uranus_zh_male_ruyacaijun_tob', label: '儒雅才俊 2.0 (ICL_uranus_zh_male_ruyacaijun_tob)' },
  { value: 'ICL_uranus_zh_male_ruyajunzi_tob', label: '儒雅君子 2.0 (ICL_uranus_zh_male_ruyajunzi_tob)' },
  { value: 'ICL_uranus_zh_male_ruyazongcai_tob', label: '儒雅总裁 2.0 (ICL_uranus_zh_male_ruyazongcai_tob)' },
  { value: 'ICL_uranus_zh_male_sajiaonansheng_tob', label: '撒娇男生 2.0 (ICL_uranus_zh_male_sajiaonansheng_tob)' },
  { value: 'ICL_uranus_zh_male_sajiaonanyou_tob', label: '撒娇男友 2.0 (ICL_uranus_zh_male_sajiaonanyou_tob)' },
  { value: 'ICL_uranus_zh_male_sajiaonianren_tob', label: '撒娇粘人 2.0 (ICL_uranus_zh_male_sajiaonianren_tob)' },
  { value: 'ICL_uranus_zh_male_satuoqingnian_tob', label: '洒脱青年 2.0 (ICL_uranus_zh_male_satuoqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_shaonianjiangjun_tob', label: '少年将军 2.0 (ICL_uranus_zh_male_shaonianjiangjun_tob)' },
  { value: 'ICL_uranus_zh_male_shenchenzongcai_tob', label: '深沉总裁 2.0 (ICL_uranus_zh_male_shenchenzongcai_tob)' },
  { value: 'ICL_uranus_zh_male_jilingxiaohuo_tob', label: '机灵小伙 2.0 (ICL_uranus_zh_male_jilingxiaohuo_tob)' },
  { value: 'ICL_uranus_zh_male_shenmifashi_tob', label: '神秘法师 2.0 (ICL_uranus_zh_male_shenmifashi_tob)' },
  { value: 'ICL_uranus_zh_male_shuaizhenxiaohuo_tob', label: '率真小伙 2.0 (ICL_uranus_zh_male_shuaizhenxiaohuo_tob)' },
  { value: 'ICL_uranus_zh_male_shuanglangxiaoyang_tob', label: '爽朗小阳 2.0 (ICL_uranus_zh_male_shuanglangxiaoyang_tob)' },
  { value: 'ICL_uranus_zh_male_dichenqianquan_tob', label: '低沉缱绻 2.0 (ICL_uranus_zh_male_dichenqianquan_tob)' },
  { value: 'ICL_uranus_zh_male_siwenqingnian_tob', label: '斯文青年 2.0 (ICL_uranus_zh_male_siwenqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_tianxinanyou_tob', label: '甜系男友 2.0 (ICL_uranus_zh_male_tianxinanyou_tob)' },
  { value: 'ICL_uranus_zh_male_tiexinnanyou_tob', label: '贴心男友 2.0 (ICL_uranus_zh_male_tiexinnanyou_tob)' },
  { value: 'ICL_uranus_zh_male_wenrounantongzhuo_tob', label: '温柔男同桌 2.0 (ICL_uranus_zh_male_wenrounantongzhuo_tob)' },
  { value: 'ICL_uranus_zh_male_wenrounanyou_tob', label: '温柔男友 2.0 (ICL_uranus_zh_male_wenrounanyou_tob)' },
  { value: 'ICL_uranus_zh_male_wenrouxuezhang_tob', label: '温柔学长 2.0 (ICL_uranus_zh_male_wenrouxuezhang_tob)' },
  { value: 'ICL_uranus_zh_male_wenrunxuezhe_tob', label: '温润学者 2.0 (ICL_uranus_zh_male_wenrunxuezhe_tob)' },
  { value: 'ICL_uranus_zh_male_wenshunshaonian_tob', label: '温顺少年 2.0 (ICL_uranus_zh_male_wenshunshaonian_tob)' },
  { value: 'ICL_uranus_zh_male_guayanxiaoge_tob', label: '寡言小哥 2.0 (ICL_uranus_zh_male_guayanxiaoge_tob)' },
  { value: 'ICL_uranus_zh_male_xiaohouye_tob', label: '小侯爷 2.0 (ICL_uranus_zh_male_xiaohouye_tob)' },
  { value: 'ICL_uranus_zh_male_naiqixiaosheng_tob', label: '奶气小生 2.0 (ICL_uranus_zh_male_naiqixiaosheng_tob)' },
  { value: 'ICL_uranus_zh_male_xiaosasuixing_tob', label: '潇洒随性 2.0 (ICL_uranus_zh_male_xiaosasuixing_tob)' },
  { value: 'ICL_uranus_zh_male_wenrouneilian_tob', label: '温柔内敛 2.0 (ICL_uranus_zh_male_wenrouneilian_tob)' },
  { value: 'ICL_uranus_zh_male_xuebanantongzhuo_tob', label: '学霸男同桌 2.0 (ICL_uranus_zh_male_xuebanantongzhuo_tob)' },
  { value: 'ICL_uranus_zh_male_xuebatongzhuo_tob', label: '学霸同桌 2.0 (ICL_uranus_zh_male_xuebatongzhuo_tob)' },
  { value: 'ICL_uranus_zh_male_yangguangyangyang_tob', label: '阳光洋洋 2.0 (ICL_uranus_zh_male_yangguangyangyang_tob)' },
  { value: 'ICL_uranus_zh_male_wennuanshaonian_tob', label: '温暖少年 2.0 (ICL_uranus_zh_male_wennuanshaonian_tob)' },
  { value: 'ICL_uranus_zh_male_yiqishaonian_tob', label: '意气少年 2.0 (ICL_uranus_zh_male_yiqishaonian_tob)' },
  { value: 'ICL_uranus_zh_male_younidashu_tob', label: '油腻大叔 2.0 (ICL_uranus_zh_male_younidashu_tob)' },
  { value: 'ICL_uranus_zh_male_youmodaye_tob', label: '幽默大爷 2.0 (ICL_uranus_zh_male_youmodaye_tob)' },
  { value: 'ICL_uranus_zh_male_youmoshushu_tob', label: '幽默叔叔 2.0 (ICL_uranus_zh_male_youmoshushu_tob)' },
  { value: 'ICL_uranus_zh_male_youroubangzhu_tob', label: '优柔帮主 2.0 (ICL_uranus_zh_male_youroubangzhu_tob)' },
  { value: 'ICL_uranus_zh_male_yourougongzi_tob', label: '优柔公子 2.0 (ICL_uranus_zh_male_yourougongzi_tob)' },
  { value: 'ICL_uranus_zh_male_yuanqishaonian_tob', label: '元气少年 2.0 (ICL_uranus_zh_male_yuanqishaonian_tob)' },
  { value: 'ICL_uranus_zh_male_zhangjianjunzi_tob', label: '仗剑君子 2.0 (ICL_uranus_zh_male_zhangjianjunzi_tob)' },
  { value: 'ICL_uranus_zh_male_zhangjianxiake_tob', label: '仗剑侠客 2.0 (ICL_uranus_zh_male_zhangjianxiake_tob)' },
  { value: 'ICL_uranus_zh_male_zhengzhiqingnian_tob', label: '正直青年 2.0 (ICL_uranus_zh_male_zhengzhiqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_zhishuaiqingnian_tob', label: '直率青年 2.0 (ICL_uranus_zh_male_zhishuaiqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_zhongerqingnian_tob', label: '中二青年 2.0 (ICL_uranus_zh_male_zhongerqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_zifuqingnian_tob', label: '自负青年 2.0 (ICL_uranus_zh_male_zifuqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_zixinqingnian_tob', label: '自信青年 2.0 (ICL_uranus_zh_male_zixinqingnian_tob)' },
  { value: 'ICL_uranus_zh_male_tiancaitongzhuo_tob', label: '天才同桌 2.0 (ICL_uranus_zh_male_tiancaitongzhuo_tob)' },
  { value: 'ICL_uranus_zh_male_qingxinmumu_tob', label: '清新沐沐 2.0 (ICL_uranus_zh_male_qingxinmumu_tob)' },
  { value: 'ICL_uranus_zh_female_wenwanshanshan_tob', label: '温婉珊珊 2.0 (ICL_uranus_zh_female_wenwanshanshan_tob)' },
  { value: 'ICL_uranus_zh_female_reqingaina_tob', label: '热情艾娜 2.0 (ICL_uranus_zh_female_reqingaina_tob)' },
  { value: 'ICL_uranus_zh_male_shuanglangshaonian_tob', label: '爽朗少年 2.0 (ICL_uranus_zh_male_shuanglangshaonian_tob)' },
  { value: 'ICL_uranus_zh_female_qingyingduoduo_tob', label: '轻盈朵朵 2.0 (ICL_uranus_zh_female_qingyingduoduo_tob)' },
];

const volcengineSystemVoiceOptions = [
  { value: 'zh_female_vv_uranus_bigtts', label: 'Vivi 2.0 (zh_female_vv_uranus_bigtts)' },
  { value: 'zh_female_xiaohe_uranus_bigtts', label: '小何 2.0 (zh_female_xiaohe_uranus_bigtts)' },
  { value: 'zh_male_m191_uranus_bigtts', label: '云舟 2.0 (zh_male_m191_uranus_bigtts)' },
  { value: 'zh_male_taocheng_uranus_bigtts', label: '小天 2.0 (zh_male_taocheng_uranus_bigtts)' },
  { value: 'zh_male_liufei_uranus_bigtts', label: '刘飞 2.0 (zh_male_liufei_uranus_bigtts)' },
  { value: 'zh_female_sophie_uranus_bigtts', label: '魅力苏菲 2.0 (zh_female_sophie_uranus_bigtts)' },
  { value: 'zh_female_qingxinnvsheng_uranus_bigtts', label: '清新女声 2.0 (zh_female_qingxinnvsheng_uranus_bigtts)' },
  { value: 'zh_female_cancan_uranus_bigtts', label: '知性灿灿 2.0 (zh_female_cancan_uranus_bigtts)' },
  { value: 'zh_female_sajiaoxuemei_uranus_bigtts', label: '撒娇学妹 2.0 (zh_female_sajiaoxuemei_uranus_bigtts)' },
  { value: 'zh_female_tianmeixiaoyuan_uranus_bigtts', label: '甜美小源 2.0 (zh_female_tianmeixiaoyuan_uranus_bigtts)' },
  { value: 'zh_female_tianmeitaozi_uranus_bigtts', label: '甜美桃子 2.0 (zh_female_tianmeitaozi_uranus_bigtts)' },
  { value: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快思思 2.0 (zh_female_shuangkuaisisi_uranus_bigtts)' },
  { value: 'zh_female_peiqi_uranus_bigtts', label: '佩奇猪 2.0 (zh_female_peiqi_uranus_bigtts)' },
  { value: 'zh_female_linjianvhai_uranus_bigtts', label: '邻家女孩 2.0 (zh_female_linjianvhai_uranus_bigtts)' },
  { value: 'zh_male_shaonianzixin_uranus_bigtts', label: '少年梓辛 2.0 (zh_male_shaonianzixin_uranus_bigtts)' },
  { value: 'zh_male_sunwukong_uranus_bigtts', label: '猴哥 2.0 (zh_male_sunwukong_uranus_bigtts)' },
  { value: 'zh_female_yingyujiaoxue_uranus_bigtts', label: 'Tina老师 2.0 (zh_female_yingyujiaoxue_uranus_bigtts)' },
  { value: 'zh_female_kefunvsheng_uranus_bigtts', label: '暖阳女声 2.0 (zh_female_kefunvsheng_uranus_bigtts)' },
  { value: 'zh_female_xiaoxue_uranus_bigtts', label: '儿童绘本 2.0 (zh_female_xiaoxue_uranus_bigtts)' },
  { value: 'zh_male_dayi_uranus_bigtts', label: '大壹 2.0 (zh_male_dayi_uranus_bigtts)' },
  { value: 'zh_female_mizai_uranus_bigtts', label: '黑猫侦探社咪仔 2.0 (zh_female_mizai_uranus_bigtts)' },
  { value: 'zh_female_jitangnv_uranus_bigtts', label: '鸡汤女 2.0 (zh_female_jitangnv_uranus_bigtts)' },
  { value: 'zh_female_meilinvyou_uranus_bigtts', label: '魅力女友 2.0 (zh_female_meilinvyou_uranus_bigtts)' },
  { value: 'zh_female_liuchangnv_uranus_bigtts', label: '流畅女声 2.0 (zh_female_liuchangnv_uranus_bigtts)' },
  { value: 'zh_male_ruyayichen_uranus_bigtts', label: '儒雅逸辰 2.0 (zh_male_ruyayichen_uranus_bigtts)' },
  { value: 'en_male_tim_uranus_bigtts', label: 'Tim (en_male_tim_uranus_bigtts)' },
  { value: 'en_female_dacey_uranus_bigtts', label: 'Dacey (en_female_dacey_uranus_bigtts)' },
  { value: 'en_female_stokie_uranus_bigtts', label: 'Stokie (en_female_stokie_uranus_bigtts)' },
  { value: 'zh_female_wenroumama_uranus_bigtts', label: '温柔妈妈 2.0 (zh_female_wenroumama_uranus_bigtts)' },
  { value: 'zh_male_jieshuoxiaoming_uranus_bigtts', label: '解说小明 2.0 (zh_male_jieshuoxiaoming_uranus_bigtts)' },
  { value: 'zh_female_tvbnv_uranus_bigtts', label: 'TVB女声 2.0 (zh_female_tvbnv_uranus_bigtts)' },
  { value: 'zh_male_yizhipiannan_uranus_bigtts', label: '译制片男 2.0 (zh_male_yizhipiannan_uranus_bigtts)' },
  { value: 'zh_female_qiaopinv_uranus_bigtts', label: '俏皮女声 2.0 (zh_female_qiaopinv_uranus_bigtts)' },
  { value: 'zh_female_zhishuaiyingzi_uranus_bigtts', label: '直率英子 2.0 (zh_female_zhishuaiyingzi_uranus_bigtts)' },
  { value: 'zh_male_linjiananhai_uranus_bigtts', label: '邻家男孩 2.0 (zh_male_linjiananhai_uranus_bigtts)' },
  { value: 'zh_male_silang_uranus_bigtts', label: '四郎 2.0 (zh_male_silang_uranus_bigtts)' },
  { value: 'zh_male_ruyaqingnian_uranus_bigtts', label: '儒雅青年 2.0 (zh_male_ruyaqingnian_uranus_bigtts)' },
  { value: 'zh_male_qingcang_uranus_bigtts', label: '擎苍 2.0 (zh_male_qingcang_uranus_bigtts)' },
  { value: 'zh_male_xionger_uranus_bigtts', label: '熊二 2.0 (zh_male_xionger_uranus_bigtts)' },
  { value: 'zh_female_yingtaowanzi_uranus_bigtts', label: '樱桃丸子 2.0 (zh_female_yingtaowanzi_uranus_bigtts)' },
  { value: 'zh_male_wennuanahu_uranus_bigtts', label: '温暖阿虎 2.0 (zh_male_wennuanahu_uranus_bigtts)' },
  { value: 'zh_male_naiqimengwa_uranus_bigtts', label: '奶气萌娃 2.0 (zh_male_naiqimengwa_uranus_bigtts)' },
  { value: 'zh_female_popo_uranus_bigtts', label: '婆婆 2.0 (zh_female_popo_uranus_bigtts)' },
  { value: 'zh_female_gaolengyujie_uranus_bigtts', label: '高冷御姐 2.0 (zh_female_gaolengyujie_uranus_bigtts)' },
  { value: 'zh_male_aojiaobazong_uranus_bigtts', label: '傲娇霸总 2.0 (zh_male_aojiaobazong_uranus_bigtts)' },
  { value: 'zh_male_lanyinmianbao_uranus_bigtts', label: '懒音绵宝 2.0 (zh_male_lanyinmianbao_uranus_bigtts)' },
  { value: 'zh_male_fanjuanqingnian_uranus_bigtts', label: '反卷青年 2.0 (zh_male_fanjuanqingnian_uranus_bigtts)' },
  { value: 'zh_female_wenroushunv_uranus_bigtts', label: '温柔淑女 2.0 (zh_female_wenroushunv_uranus_bigtts)' },
  { value: 'zh_female_gufengshaoyu_uranus_bigtts', label: '古风少御 2.0 (zh_female_gufengshaoyu_uranus_bigtts)' },
  { value: 'zh_male_huolixiaoge_uranus_bigtts', label: '活力小哥 2.0 (zh_male_huolixiaoge_uranus_bigtts)' },
  { value: 'zh_male_baqiqingshu_uranus_bigtts', label: '霸气青叔 2.0 (zh_male_baqiqingshu_uranus_bigtts)' },
  { value: 'zh_male_xuanyijieshuo_uranus_bigtts', label: '悬疑解说 2.0 (zh_male_xuanyijieshuo_uranus_bigtts)' },
  { value: 'zh_female_mengyatou_uranus_bigtts', label: '萌丫头 2.0 (zh_female_mengyatou_uranus_bigtts)' },
  { value: 'zh_female_tiexinnvsheng_uranus_bigtts', label: '贴心女声 2.0 (zh_female_tiexinnvsheng_uranus_bigtts)' },
  { value: 'zh_female_jitangmei_uranus_bigtts', label: '鸡汤妹妹 2.0 (zh_female_jitangmei_uranus_bigtts)' },
  { value: 'zh_male_cixingjieshuonan_uranus_bigtts', label: '磁性解说男声 2.0 (zh_male_cixingjieshuonan_uranus_bigtts)' },
  { value: 'zh_male_liangsangmengzai_uranus_bigtts', label: '亮嗓萌仔 2.0 (zh_male_liangsangmengzai_uranus_bigtts)' },
  { value: 'zh_female_kailangjiejie_uranus_bigtts', label: '开朗姐姐 2.0 (zh_female_kailangjiejie_uranus_bigtts)' },
  { value: 'zh_male_gaolengchenwen_uranus_bigtts', label: '高冷沉稳 2.0 (zh_male_gaolengchenwen_uranus_bigtts)' },
  { value: 'zh_male_shenyeboke_uranus_bigtts', label: '深夜播客 2.0 (zh_male_shenyeboke_uranus_bigtts)' },
  { value: 'zh_male_lubanqihao_uranus_bigtts', label: '鲁班七号 2.0 (zh_male_lubanqihao_uranus_bigtts)' },
  { value: 'zh_female_jiaochuannv_uranus_bigtts', label: '娇喘女声 2.0 (zh_female_jiaochuannv_uranus_bigtts)' },
  { value: 'zh_female_linxiao_uranus_bigtts', label: '林潇 2.0 (zh_female_linxiao_uranus_bigtts)' },
  { value: 'zh_female_lingling_uranus_bigtts', label: '玲玲姐姐 2.0 (zh_female_lingling_uranus_bigtts)' },
  { value: 'zh_female_chunribu_uranus_bigtts', label: '春日部姐姐 2.0 (zh_female_chunribu_uranus_bigtts)' },
  { value: 'zh_male_tangseng_uranus_bigtts', label: '唐僧 2.0 (zh_male_tangseng_uranus_bigtts)' },
  { value: 'zh_male_zhuangzhou_uranus_bigtts', label: '庄周 2.0 (zh_male_zhuangzhou_uranus_bigtts)' },
  { value: 'zh_male_kailangdidi_uranus_bigtts', label: '开朗弟弟 2.0 (zh_male_kailangdidi_uranus_bigtts)' },
  { value: 'zh_male_zhubajie_uranus_bigtts', label: '猪八戒 2.0 (zh_male_zhubajie_uranus_bigtts)' },
  { value: 'zh_female_ganmaodianyin_uranus_bigtts', label: '感冒电音姐姐 2.0 (zh_female_ganmaodianyin_uranus_bigtts)' },
  { value: 'zh_female_chanmeinv_uranus_bigtts', label: '谄媚女声 2.0 (zh_female_chanmeinv_uranus_bigtts)' },
  { value: 'zh_female_nvleishen_uranus_bigtts', label: '女雷神 2.0 (zh_female_nvleishen_uranus_bigtts)' },
  { value: 'zh_female_qinqienv_uranus_bigtts', label: '亲切女声 2.0 (zh_female_qinqienv_uranus_bigtts)' },
  { value: 'zh_male_kuailexiaodong_uranus_bigtts', label: '快乐小东 2.0 (zh_male_kuailexiaodong_uranus_bigtts)' },
  { value: 'zh_male_kailangxuezhang_uranus_bigtts', label: '开朗学长 2.0 (zh_male_kailangxuezhang_uranus_bigtts)' },
  { value: 'zh_male_youyoujunzi_uranus_bigtts', label: '悠悠君子 2.0 (zh_male_youyoujunzi_uranus_bigtts)' },
  { value: 'zh_female_wenjingmaomao_uranus_bigtts', label: '文静毛毛 2.0 (zh_female_wenjingmaomao_uranus_bigtts)' },
  { value: 'zh_female_zhixingnv_uranus_bigtts', label: '知性女声 2.0 (zh_female_zhixingnv_uranus_bigtts)' },
  { value: 'zh_male_qingshuangnanda_uranus_bigtts', label: '清爽男大 2.0 (zh_male_qingshuangnanda_uranus_bigtts)' },
  { value: 'zh_male_yuanboxiaoshu_uranus_bigtts', label: '渊博小叔 2.0 (zh_male_yuanboxiaoshu_uranus_bigtts)' },
  { value: 'zh_male_yangguangqingnian_uranus_bigtts', label: '阳光青年 2.0 (zh_male_yangguangqingnian_uranus_bigtts)' },
  { value: 'zh_female_qingchezizi_uranus_bigtts', label: '清澈梓梓 2.0 (zh_female_qingchezizi_uranus_bigtts)' },
  { value: 'zh_female_tianmeiyueyue_uranus_bigtts', label: '甜美悦悦 2.0 (zh_female_tianmeiyueyue_uranus_bigtts)' },
  { value: 'zh_female_xinlingjitang_uranus_bigtts', label: '心灵鸡汤 2.0 (zh_female_xinlingjitang_uranus_bigtts)' },
  { value: 'zh_male_wenrouxiaoge_uranus_bigtts', label: '温柔小哥 2.0 (zh_male_wenrouxiaoge_uranus_bigtts)' },
  { value: 'zh_female_roumeinvyou_uranus_bigtts', label: '柔美女友 2.0 (zh_female_roumeinvyou_uranus_bigtts)' },
  { value: 'zh_male_dongfanghaoran_uranus_bigtts', label: '东方浩然 2.0 (zh_male_dongfanghaoran_uranus_bigtts)' },
  { value: 'zh_female_wenrouxiaoya_uranus_bigtts', label: '温柔小雅 2.0 (zh_female_wenrouxiaoya_uranus_bigtts)' },
  { value: 'zh_male_tiancaitongsheng_uranus_bigtts', label: '天才童声 2.0 (zh_male_tiancaitongsheng_uranus_bigtts)' },
  { value: 'zh_female_wuzetian_uranus_bigtts', label: '武则天 2.0 (zh_female_wuzetian_uranus_bigtts)' },
  { value: 'zh_female_gujie_uranus_bigtts', label: '顾姐 2.0 (zh_female_gujie_uranus_bigtts)' },
  { value: 'zh_male_guanggaojieshuo_uranus_bigtts', label: '广告解说 2.0 (zh_male_guanggaojieshuo_uranus_bigtts)' },
  { value: 'zh_female_shaoergushi_uranus_bigtts', label: '少儿故事 2.0 (zh_female_shaoergushi_uranus_bigtts)' },
  { value: 'ar_female_dina_uranus_bigtts', label: 'Dina (ar_female_dina_uranus_bigtts)' },
  { value: 'ar_female_fatma_uranus_bigtts', label: 'Fatma (ar_female_fatma_uranus_bigtts)' },
  { value: 'ar_male_youssef_uranus_bigtts', label: 'Youssef (ar_male_youssef_uranus_bigtts)' },
  { value: 'de_female_bv081_uranus_bigtts', label: 'Stella (de_female_bv081_uranus_bigtts)' },
  { value: 'de_male_sven_uranus_bigtts', label: 'Sven (de_male_sven_uranus_bigtts)' },
  { value: 'en_male_adam-imitation_uranus_bigtts', label: 'Rowan (en_male_adam-imitation_uranus_bigtts)' },
  { value: 'en_male_alberto_uranus_bigtts', label: 'Alberto (en_male_alberto_uranus_bigtts)' },
  { value: 'en_male_alex_uranus_bigtts', label: 'Alex (en_male_alex_uranus_bigtts)' },
  { value: 'en_female_allison_uranus_bigtts', label: 'Allison (en_female_allison_uranus_bigtts)' },
  { value: 'en_female_authoritative-british_uranus_bigtts', label: 'Charlotte (en_female_authoritative-british_uranus_bigtts)' },
  { value: 'en_female_authoritative-informative_uranus_bigtts', label: 'Margaret (en_female_authoritative-informative_uranus_bigtts)' },
  { value: 'en_male_bill-jones_uranus_bigtts', label: 'Jones (en_male_bill-jones_uranus_bigtts)' },
  { value: 'en_male_bill_jones_corey_uranus_bigtts', label: 'Bill (en_male_bill_jones_corey_uranus_bigtts)' },
  { value: 'en_male_brad_pitt_p1_uranus_bigtts', label: 'Brad_Pitt (en_male_brad_pitt_p1_uranus_bigtts)' },
  { value: 'en_female_brittney_uranus_bigtts', label: 'Brittney (en_female_brittney_uranus_bigtts)' },
  { value: 'en_female_brittney_pimintel_uranus_bigtts', label: 'Zoe (en_female_brittney_pimintel_uranus_bigtts)' },
  { value: 'en_male_bruce_uranus_bigtts', label: 'Adrian (en_male_bruce_uranus_bigtts)' },
  { value: 'en_male_chandler_p1_uranus_bigtts', label: 'Leo (en_male_chandler_p1_uranus_bigtts)' },
  { value: 'en_male_cowboy-bob_uranus_bigtts', label: 'Bob (en_male_cowboy-bob_uranus_bigtts)' },
  { value: 'en_male_cowboy_john_b_uranus_bigtts', label: 'John (en_male_cowboy_john_b_uranus_bigtts)' },
  { value: 'en_male_david_uranus_bigtts', label: 'David (en_male_david_uranus_bigtts)' },
  { value: 'en_male_deep-voice_uranus_bigtts', label: 'Orion (en_male_deep-voice_uranus_bigtts)' },
  { value: 'en_male_diyuwenrounan_uranus_bigtts', label: 'Julian (en_male_diyuwenrounan_uranus_bigtts)' },
  { value: 'en_male_evil-guy-oxley_uranus_bigtts', label: 'Harrison (en_male_evil-guy-oxley_uranus_bigtts)' },
  { value: 'en_male_excited-male-voice_uranus_bigtts', label: 'Jasper (en_male_excited-male-voice_uranus_bigtts)' },
  { value: 'en_male_father-christmas_uranus_bigtts', label: 'Alfred (en_male_father-christmas_uranus_bigtts)' },
  { value: 'en_female_female_tutor_ms-jenny_uranus_bigtts', label: 'Holly (en_female_female_tutor_ms-jenny_uranus_bigtts)' },
  { value: 'en_male_fernando-martinez_uranus_bigtts', label: 'Felix (en_male_fernando-martinez_uranus_bigtts)' },
  { value: 'en_male_godfather_uranus_bigtts', label: 'Godfather (en_male_godfather_uranus_bigtts)' },
  { value: 'en_male_gollum_uranus_bigtts', label: 'Gollum (en_male_gollum_uranus_bigtts)' },
  { value: 'en_male_hades_uranus_bigtts', label: 'Beau (en_male_hades_uranus_bigtts)' },
  { value: 'en_female_hayley_uranus_bigtts', label: 'Hayley (en_female_hayley_uranus_bigtts)' },
  { value: 'en_male_jamie_uranus_bigtts', label: 'Jamie (en_male_jamie_uranus_bigtts)' },
  { value: 'en_female_jane_uranus_bigtts', label: 'Jane (en_female_jane_uranus_bigtts)' },
  { value: 'en_female_jenny_uranus_bigtts', label: 'Jenny (en_female_jenny_uranus_bigtts)' },
  { value: 'en_male_jidongchuanjiaoshi_uranus_bigtts', label: 'Blaze (en_male_jidongchuanjiaoshi_uranus_bigtts)' },
  { value: 'en_male_jimmy_uranus_bigtts', label: 'Jimmy (en_male_jimmy_uranus_bigtts)' },
  { value: 'en_female_joanne_uranus_bigtts', label: 'Joanne (en_female_joanne_uranus_bigtts)' },
  { value: 'en_male_joker_uranus_bigtts', label: 'Joker (en_male_joker_uranus_bigtts)' },
  { value: 'en_male_josh_uranus_bigtts', label: 'Josh (en_male_josh_uranus_bigtts)' },
  { value: 'en_male_josh_coery_uranus_bigtts', label: 'Josiah (en_male_josh_coery_uranus_bigtts)' },
  { value: 'en_male_kevin_uranus_bigtts', label: 'Kevin (en_male_kevin_uranus_bigtts)' },
  { value: 'en_male_knightley_uranus_bigtts', label: 'Knightley (en_male_knightley_uranus_bigtts)' },
  { value: 'en_female_lana_del_rey_kelley_d_p1_uranus_bigtts', label: 'Lynn (en_female_lana_del_rey_kelley_d_p1_uranus_bigtts)' },
  { value: 'en_female_lana_del_rey_parky_s_p1_uranus_bigtts', label: 'Ivy (en_female_lana_del_rey_parky_s_p1_uranus_bigtts)' },
  { value: 'en_male_marcus_uranus_bigtts', label: 'Marcus (en_male_marcus_uranus_bigtts)' },
  { value: 'en_female_mel_uranus_bigtts', label: 'Mel (en_female_mel_uranus_bigtts)' },
  { value: 'en_male_michael_uranus_bigtts', label: 'Hank (en_male_michael_uranus_bigtts)' },
  { value: 'en_male_michael-mouse_uranus_bigtts', label: 'Chip (en_male_michael-mouse_uranus_bigtts)' },
  { value: 'en_male_michael_kevin_uranus_bigtts', label: 'Michael_Kevin (en_male_michael_kevin_uranus_bigtts)' },
  { value: 'en_male_motivational-coach_uranus_bigtts', label: 'Rory (en_male_motivational-coach_uranus_bigtts)' },
  { value: 'en_female_myra_uranus_bigtts', label: 'Myra (en_female_myra_uranus_bigtts)' },
  { value: 'en_female_myra_cmb_uranus_bigtts', label: 'Sunny (en_female_myra_cmb_uranus_bigtts)' },
  { value: 'en_female_nadia_uranus_bigtts', label: 'Blair (en_female_nadia_uranus_bigtts)' },
  { value: 'en_female_natasha_uranus_bigtts', label: 'Natasha (en_female_natasha_uranus_bigtts)' },
];

const volcengineTtsVoiceOptions = [
  ...volcengineSystemVoiceOptions,
  ...volcengineIclVoiceOptions,
];

const volcengineVoiceOptions = computed(() => {
  void store.volcengineCloneSpeakerHistoryVersion;
  const resourceId = store.tts.volcengineResourceId;
  const current = (store.tts.volcengineSpeakerId || '').trim();

  if (resourceId === 'seed-tts-2.0') {
    const baseOptions = volcengineTtsVoiceOptions;
    if (current && !baseOptions.some((option) => option.value === current)) {
      return [{ value: current, label: current }, ...baseOptions];
    }
    return baseOptions;
  }

  return buildVolcengineCloneSpeakerOptions(current);
});

watch(
  [
    () => store.isLoaded,
    () => store.tts.volcengineResourceId,
    () => store.tts.volcengineSpeakerId,
    () => store.tts.volcengineTrainedSpeakerId,
    () => store.tts.volcengineCloneSpeakerSlot,
  ],
  ([loaded, resourceId, speakerId]) => {
    if (!loaded) return;
    if (resourceId === 'seed-icl-1.0') {
      store.tts.volcengineResourceId = 'seed-icl-2.0';
      return;
    }
    const id = (speakerId || '').trim();
    if (resourceId === 'seed-tts-2.0') {
      if (!id) {
        store.tts.volcengineSpeakerId = volcengineSystemVoiceOptions[0]?.value || '';
      }
      return;
    }
    hydrateVolcengineCloneSpeakerIds(store.tts);
  },
  { immediate: true },
);

onMounted(() => {
  if (!store.isLoaded) {
    store.fetchSettings();
  }
});

const voiceCloneDir = ref('');
const voiceCloneFile = ref('');
const voiceCloneFileList = ref<string[]>([]);

// Sync from store.tts.xiaomoMimoRefVoicePath to local ref fields
watch(
  () => store.tts.xiaomoMimoRefVoicePath,
  (newPath) => {
    if (newPath) {
      const normalized = newPath.replace(/\\/g, '/');
      const lastSlash = normalized.lastIndexOf('/');
      let dir = '';
      let file = '';
      if (lastSlash !== -1) {
        dir = newPath.substring(0, lastSlash);
        file = newPath.substring(lastSlash + 1);
      } else {
        file = newPath;
      }
      if (voiceCloneDir.value !== dir) {
        voiceCloneDir.value = dir;
      }
      if (voiceCloneFile.value !== file) {
        voiceCloneFile.value = file;
      }
    } else {
      voiceCloneDir.value = '';
      voiceCloneFile.value = '';
    }
  },
  { immediate: true }
);

// Fetch files list when directory changes
watch(
  voiceCloneDir,
  async (newDir) => {
    if (!newDir) {
      voiceCloneFileList.value = [];
      return;
    }
    try {
      const res = await fetch(getFullUrl(`/api/settings/list-dir-files?path=${encodeURIComponent(newDir)}`));
      if (res.ok) {
        const list = await res.json();
        voiceCloneFileList.value = list;
      }
    } catch (e) {
      console.error('Failed to list files', e);
    }
  },
  { immediate: true }
);

// Combine dir and file and write to store
watch(
  [voiceCloneDir, voiceCloneFile],
  () => {
    if (voiceCloneDir.value) {
      const sep = voiceCloneDir.value.includes('/') ? '/' : '\\';
      const combined = voiceCloneDir.value.endsWith(sep)
        ? `${voiceCloneDir.value}${voiceCloneFile.value}`
        : `${voiceCloneDir.value}${sep}${voiceCloneFile.value}`;
      if (store.tts.xiaomoMimoRefVoicePath !== combined) {
        store.tts.xiaomoMimoRefVoicePath = combined;
      }
    } else {
      if (store.tts.xiaomoMimoRefVoicePath !== '') {
        store.tts.xiaomoMimoRefVoicePath = '';
      }
    }
  }
);

// Auto-switch model name based on selected mode if it's one of the standard mimo models
watch(
  () => store.tts.xiaomoMimoMode,
  (newMode) => {
    const currentModel = store.tts.xiaomoMimoModel;
    if (!currentModel || ["mimo-v2.5-tts-voiceclone", "mimo-v2.5-tts-voicedesign", "mimo-v2.5-tts"].includes(currentModel)) {
      if (newMode === 'voice_clone') {
        store.tts.xiaomoMimoModel = 'mimo-v2.5-tts-voiceclone';
      } else if (newMode === 'voice_design') {
        store.tts.xiaomoMimoModel = 'mimo-v2.5-tts-voicedesign';
      } else {
        store.tts.xiaomoMimoModel = 'mimo-v2.5-tts';
      }
    }
  }
);

async function handleChooseDir() {
  try {
    const res = await fetch(getFullUrl('/api/settings/choose-directory'), { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.directory) {
        voiceCloneDir.value = data.directory;
      }
    }
  } catch (e) {
    console.error('Failed to select folder', e);
  }
}
</script>

<template>
  <div class="tts-config">
    <a-spin :loading="!store.isLoaded" tip="正在加载语音配置...">
      <!-- Global Speech Settings -->
      <div class="settings-group global-tts-group">
        <div class="setting-row">
          <div class="row-label">
            <span class="main-text">启用语音合成 (TTS)</span>
            <span class="sub-text">开启后将 AI 回复文本转换为语音输出</span>
          </div>
          <div class="row-action">
            <a-switch v-model="store.tts.enabled" size="small" />
          </div>
        </div>

        <div class="setting-row">
          <div class="row-label">
            <span class="main-text">自动朗读文字聊天</span>
            <span class="sub-text">关闭后普通文字聊天不再自动播放语音（仍可手动点击朗读），通话链路不受影响</span>
          </div>
          <div class="row-action">
            <a-switch v-model="store.tts.autoRead" size="small" :disabled="!store.tts.enabled" />
          </div>
        </div>

      </div>

      <!-- Provider Form Settings (Single Page with Provider Selector) -->
      <div class="settings-group provider-settings-group">
        <!-- TTS 服务商选项 -->
        <div class="setting-row">
          <div class="row-label">
            <span class="main-text">TTS 服务商</span>
            <span class="sub-text">选择语音合成服务提供商</span>
          </div>
          <div class="row-action">
            <a-select
              :model-value="currentProvider"
              :options="providerOptions"
              :style="{ width: '220px' }"
              size="small"
              @change="handleProviderTabChange"
            />
          </div>
        </div>

        <!-- OpenAI 兼容 -->
        <template v-if="currentProvider === 'openai_compat'">
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">TTS 服务地址</span>
              <span class="sub-text">OpenAI 兼容的 TTS 服务地址，如 openai-edge-tts</span>
            </div>
            <div class="row-action">
              <a-input v-model="store.tts.baseUrl" placeholder="http://localhost:5050" :style="{ width: '320px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">TTS 模型</span>
              <span class="sub-text">指定 TTS 模型名称，OpenAI 官方建议使用 tts-1 或 tts-1-hd</span>
            </div>
            <div class="row-action">
              <a-input v-model="store.tts.model" placeholder="voxcpm-2" :style="{ width: '320px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">API 密钥</span>
              <span class="sub-text">如果 TTS 服务需要认证，请填入密钥</span>
            </div>
            <div class="row-action">
              <a-input-password v-model="store.tts.apiKey" placeholder="sk-..." :style="{ width: '320px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">默认语音</span>
              <span class="sub-text">TTS 使用的默认音色名称</span>
            </div>
            <div class="row-action">
              <a-input v-model="store.tts.defaultVoice" placeholder="alloy" :style="{ width: '180px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">默认语速</span>
              <span class="sub-text">取值范围 0.25 ~ 4.0，1.0 为正常语速</span>
            </div>
            <div class="row-action">
              <a-input-number
                v-model="store.tts.defaultSpeed"
                :min="0.25"
                :max="4.0"
                :step="0.25"
                :precision="2"
                :style="{ width: '120px' }"
                size="small"
              />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">默认格式</span>
              <span class="sub-text">音频输出格式，MP3 兼容性最好</span>
            </div>
            <div class="row-action">
              <a-select v-model="store.tts.defaultFormat" :options="ttsFormatOptions" :style="{ width: '120px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">随机种子</span>
              <span class="sub-text">音频生成的随机种子，-1 表示随机</span>
            </div>
            <div class="row-action">
              <a-input-number v-model="store.tts.defaultSeed" :min="-1" :step="1" :style="{ width: '120px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">CFG 引导强度</span>
              <span class="sub-text">分类器自由引导强度，范围 0.0 ~ 2.0，默认 1.0，值越大生成质量越稳定</span>
            </div>
            <div class="row-action">
              <a-input-number
                v-model="store.tts.defaultCfg"
                :min="0.0"
                :max="2.0"
                :step="0.1"
                :precision="1"
                :style="{ width: '120px' }"
                size="small"
              />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">推理步数</span>
              <span class="sub-text">扩散推理步数，默认 10，值越大通常更稳定，但生成更慢</span>
            </div>
            <div class="row-action">
              <a-input-number
                v-model="store.tts.defaultTimesteps"
                :min="1"
                :max="100"
                :step="1"
                :precision="0"
                :style="{ width: '120px' }"
                size="small"
              />
            </div>
          </div>
        </template>

        <!-- 阿里云 CosyVoice -->
        <template v-else-if="currentProvider === 'aliyun_cosyvoice'">
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">WebSocket 地址</span>
              <span class="sub-text">阿里云 CosyVoice 实时合成 WebSocket 地址</span>
            </div>
            <div class="row-action">
              <a-input v-model="store.tts.aliyunWsUrl" placeholder="wss://dashscope.aliyuncs.com/api-ws/v1/inference" :style="{ width: '420px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">API 密钥</span>
              <span class="sub-text">DashScope API Key</span>
            </div>
            <div class="row-action">
              <a-input-password v-model="store.tts.aliyunApiKey" placeholder="sk-..." :style="{ width: '320px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">模型 / 音色</span>
              <span class="sub-text">{{ aliyunModelHint }}</span>
            </div>
            <div class="row-action" style="gap: 8px;">
              <a-select
                v-model="store.tts.aliyunModel"
                :options="aliyunCosyvoiceModelOptions"
                placeholder="请选择模型"
                :style="{ width: '240px' }"
                size="small"
              />
              <a-input
                v-model="store.tts.aliyunVoice"
                :placeholder="aliyunVoicePlaceholder"
                :style="{ width: '180px' }"
                size="small"
              />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">采样率</span>
              <span class="sub-text">实时合成固定使用 MP3 格式，采样率建议 22050Hz</span>
            </div>
            <div class="row-action" style="gap: 8px;">
              <a-input-number v-model="store.tts.aliyunSampleRate" :min="8000" :max="48000" :step="50" :precision="0" :style="{ width: '120px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">语速 / 音调 / 音量</span>
              <span class="sub-text">音量范围建议 0~100</span>
            </div>
            <div class="row-action" style="gap: 8px;">
              <a-input-number v-model="store.tts.aliyunRate" :min="0.25" :max="4.0" :step="0.1" :precision="2" :style="{ width: '100px' }" size="small" />
              <a-input-number v-model="store.tts.aliyunPitch" :min="0.5" :max="2.0" :step="0.1" :precision="2" :style="{ width: '100px' }" size="small" />
              <a-input-number v-model="store.tts.aliyunVolume" :min="0" :max="100" :step="1" :precision="0" :style="{ width: '100px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">指令控制（可选）</span>
              <span class="sub-text">用于控制情感、语气、风格</span>
            </div>
            <div class="row-action">
              <a-input v-model="store.tts.aliyunInstruction" placeholder="例如：语速自然，语气温和" :style="{ width: '420px' }" size="small" />
            </div>
          </div>
        </template>

        <!-- 火山引擎 -->
        <template v-else-if="currentProvider === 'volcengine'">
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">API Key</span>
              <span class="sub-text">火山引擎 OpenSpeech X-Api-Key</span>
            </div>
            <div class="row-action">
              <a-input-password v-model="store.tts.volcengineApiKey" placeholder="volc api key" :style="{ width: '320px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">资源 / 模型</span>
              <span class="sub-text">火山引擎双向 TTS 地址固定使用官方 v3 bidirection，资源与模型按枚举选择</span>
            </div>
            <div class="row-action" style="gap: 8px;">
              <a-select v-model="store.tts.volcengineResourceId" :options="volcengineResourceOptions" :style="{ width: '250px' }" size="small" />
              <a-select v-model="store.tts.volcengineModel" :options="volcengineModelOptions" :style="{ width: '250px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">音色</span>
              <span class="sub-text" v-if="store.tts.volcengineResourceId === 'seed-tts-2.0'">选择或输入语音合成 2.0 系统/预置音色</span>
              <span class="sub-text" v-else>输入火山控制台或本应用训练得到的 S_ speaker_id</span>
            </div>
            <div class="row-action">
              <a-select
                v-model="store.tts.volcengineSpeakerId"
                :options="volcengineVoiceOptions"
                :placeholder="store.tts.volcengineResourceId === 'seed-tts-2.0' ? '选择或输入系统音色' : 'S_xxxxxxxxx'"
                :style="{ width: '420px' }"
                size="small"
                allow-search
                allow-create
              />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">采样率</span>
              <span class="sub-text">默认 24000Hz (PCM 流式输出)</span>
            </div>
            <div class="row-action">
              <a-input-number v-model="store.tts.volcengineSampleRate" :min="8000" :max="48000" :step="50" :precision="0" :style="{ width: '140px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">参考上下文</span>
              <span class="sub-text">火山 context_texts：对话时自动塞入用户本轮原话。这里只作没有用户话时的兜底（问候/测试）</span>
            </div>
            <div class="row-action">
              <a-textarea v-model="store.tts.volcengineContextTexts" :auto-size="{ minRows: 2, maxRows: 4 }" placeholder="可选，例如：语气温柔、自然" :style="{ width: '420px' }" />
            </div>
          </div>
        </template>

        <!-- Fish Audio -->
        <template v-else-if="currentProvider === 'fish_audio'">
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">API Key</span>
              <span class="sub-text">Fish Audio Bearer Token</span>
            </div>
            <div class="row-action">
              <a-input-password v-model="store.tts.fishAudioApiKey" :style="{ width: '320px' }" size="small" />
            </div>
          </div>
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">模型</span>
              <span class="sub-text">作为请求头 model 发送</span>
            </div>
            <div class="row-action">
              <a-input v-model="store.tts.fishAudioModel" :style="{ width: '320px' }" size="small" />
            </div>
          </div>
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">参考音色 ID</span>
              <span class="sub-text">Fish Audio reference_id；伙伴专属音色优先</span>
            </div>
            <div class="row-action">
              <a-input v-model="store.tts.fishAudioReferenceId" :style="{ width: '420px' }" size="small" />
            </div>
          </div>
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">情绪模式</span>
              <span class="sub-text">开启后模型用 [] 写情绪/音频标签控制语气；界面和落库不显示，合成时透传给 Fish Audio</span>
            </div>
            <div class="row-action">
              <a-switch v-model="store.tts.fishAudioEmotionMode" size="small" />
            </div>
          </div>
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">延迟模式</span>
              <span class="sub-text">balanced 更快，normal 更注重质量</span>
            </div>
            <div class="row-action">
              <a-select v-model="store.tts.fishAudioLatency" :options="[{ value: 'balanced', label: '平衡 / 低延迟' }, { value: 'normal', label: '标准质量' }]" :style="{ width: '180px' }" size="small" />
            </div>
          </div>
        </template>

        <!-- 小米 MiMo -->
        <template v-else-if="currentProvider === 'xiaomo_mimo'">
          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">服务地址</span>
              <span class="sub-text">小米 MiMo API 服务地址</span>
            </div>
            <div class="row-action">
              <a-input v-model="store.tts.xiaomoMimoBaseUrl" placeholder="https://api.xiaomimimo.com/v1" :style="{ width: '320px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">API 密钥</span>
              <span class="sub-text">小米 MiMo API 授权密钥</span>
            </div>
            <div class="row-action">
              <a-input-password v-model="store.tts.xiaomoMimoApiKey" placeholder="API Key" :style="{ width: '320px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">TTS 模型</span>
              <span class="sub-text">指定小米 MiMo TTS 模型名称</span>
            </div>
            <div class="row-action">
              <a-input v-model="store.tts.xiaomoMimoModel" placeholder="mimo-v2.5-tts-voiceclone" :style="{ width: '320px' }" size="small" />
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">合成模式</span>
              <span class="sub-text">选择声音克隆、声音设计或预置音色</span>
            </div>
            <div class="row-action">
              <a-radio-group v-model="store.tts.xiaomoMimoMode" type="button" size="small">
                <a-radio value="voice_clone">声音克隆</a-radio>
                <a-radio value="voice_design">声音设计</a-radio>
                <a-radio value="preset">预置音色</a-radio>
              </a-radio-group>
            </div>
          </div>

          <div class="setting-row">
            <div class="row-label">
              <span class="main-text">情绪模式</span>
              <span class="sub-text">开启后模型用 [] 写情绪/音频标签控制语气；界面和落库不显示，合成时透传给小米</span>
            </div>
            <div class="row-action">
              <a-switch v-model="store.tts.xiaomoMimoEmotionMode" size="small" />
            </div>
          </div>

          <!-- Mode-specific settings -->
          <template v-if="store.tts.xiaomoMimoMode === 'voice_clone'">
            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">参考音频路径</span>
                <span class="sub-text">选择参考音频文件夹；声音克隆仅接受 mp3/wav，m4a/flac/ogg 会自动转 wav（需安装 ffmpeg）</span>
              </div>
              <div class="row-action" style="gap: 8px;">
                <a-input v-model="voiceCloneDir" placeholder="音频文件夹路径" :style="{ width: '220px' }" size="small">
                  <template #suffix>
                    <a-button type="text" size="mini" style="padding: 0 4px; height: auto;" @click="handleChooseDir">浏览</a-button>
                  </template>
                </a-input>
                <a-select v-model="voiceCloneFile" placeholder="选择音色文件" :style="{ width: '180px' }" size="small">
                  <a-option v-for="f in voiceCloneFileList" :key="f" :value="f">{{ f }}</a-option>
                </a-select>
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">导演提示词 (可选)</span>
                <span class="sub-text">指导 AI 说话的语气、情感和风格，例如："高兴地，大声地"</span>
              </div>
              <div class="row-action">
                <a-input v-model="store.tts.xiaomoMimoDirectorPrompt" placeholder="例如：高兴地，大声地" :style="{ width: '320px' }" size="small" />
              </div>
            </div>
          </template>

          <template v-else-if="store.tts.xiaomoMimoMode === 'voice_design'">
            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">声音设计提示词</span>
                <span class="sub-text">描述目标音色特征，例如："一个温和的中年女性声音，说话慢条斯理"</span>
              </div>
              <div class="row-action">
                <a-input v-model="store.tts.xiaomoMimoDesignPrompt" placeholder="例如：一个温和的中年女性声音，说话慢条斯理" :style="{ width: '320px' }" size="small" />
              </div>
            </div>
          </template>

          <template v-else-if="store.tts.xiaomoMimoMode === 'preset'">
            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">预置音色</span>
                <span class="sub-text">选择小米 MiMo 的预置音色</span>
              </div>
              <div class="row-action">
                <a-select v-model="store.tts.xiaomoMimoPresetVoiceName" placeholder="选择音色" :style="{ width: '320px' }" size="small">
                  <a-option value="冰糖">冰糖 (中文女声)</a-option>
                  <a-option value="茉莉">茉莉 (中文女声)</a-option>
                  <a-option value="苏打">苏打 (中文男声)</a-option>
                  <a-option value="白桦">白桦 (中文男声)</a-option>
                  <a-option value="Chloe">Chloe (英文女声)</a-option>
                  <a-option value="Mia">Mia (英文女声)</a-option>
                  <a-option value="Milo">Milo (英文男声)</a-option>
                  <a-option value="Dean">Dean (英文男声)</a-option>
                </a-select>
              </div>
            </div>

            <div class="setting-row">
              <div class="row-label">
                <span class="main-text">导演提示词 (可选)</span>
                <span class="sub-text">指导 AI 说话的语气、情感和风格，例如："高兴地，大声地"</span>
              </div>
              <div class="row-action">
                <a-input v-model="store.tts.xiaomoMimoDirectorPrompt" placeholder="例如：高兴地，大声地" :style="{ width: '320px' }" size="small" />
              </div>
            </div>
          </template>
        </template>
      </div>

      <!-- Save Button -->
      <div class="save-area">
        <a-button :loading="testing" :disabled="store.saving" @click="testTts">测试连通</a-button>
        <a-button type="primary" :loading="store.saving" :disabled="testing" @click="store.saveSettings">保存配置</a-button>
      </div>
    </a-spin>

    <AppModal
      v-model:visible="providerSwitchVisible"
      title="切换服务商"
      :show-footer="false"
      :mask-closable="false"
      :width="480"
      @cancel="cancelProviderSwitch"
    >
      <p class="app-modal-message">{{ providerSwitchContent }}</p>
      <template #footer>
        <div class="provider-switch-footer">
          <a-button :disabled="providerSwitchBusy" @click="cancelProviderSwitch">取消</a-button>
          <a-button
            status="warning"
            :loading="providerSwitchBusy"
            @click="resetVoicesAndSwitchProvider"
          >
            重置
          </a-button>
          <a-button type="primary" :loading="providerSwitchBusy" @click="confirmProviderSwitch">
            确认
          </a-button>
        </div>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.tts-config {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.provider-switch-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.global-tts-group {
  margin-bottom: 20px;
}

.provider-settings-group {
  margin-bottom: 20px;
}

.settings-group {
  background-color: var(--bg-input);
  border-radius: 12px;
  padding: 4px 0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-color);
}

.setting-row:last-child {
  border-bottom: none;
}

.row-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 55%;
}

.main-text {
  font-size: 14px;
  color: var(--text-primary);
}

.sub-text {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.4;
}

.row-action {
  display: flex;
  align-items: center;
}

.save-area {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
  margin-top: auto;
}
</style>
