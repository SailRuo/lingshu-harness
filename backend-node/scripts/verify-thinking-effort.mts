// 分支映射验证：npx tsx scripts/verify-thinking-effort.mts
// 覆盖 buildThinkingParams 的 DashScope / 智谱 / 自定义网关 / 已知 preset 四类分支
// 以及 default 档与 nex 强制思考快捷跳过。不触库、不发网。
import {
  buildThinkingParams,
  normalizeThinkingEffort,
  resolveReasoningEffort,
  thinkingEffortIsActive,
  hasDisableThinkingParams,
  stripDisableThinkingParams,
} from "../src/services/thinkingEffort.js";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
  }
}

const base = { baseUrl: "https://api.agnes-ai.cn/v1", model: "some-model", providerPreset: "agents" };

// default 档：任何服务商都不下发
check("default → empty (preset)", buildThinkingParams({ ...base, reasoningEffort: "default" }), {});
check("default → empty (dashscope)", buildThinkingParams({ ...base, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoningEffort: "default" }), {});

// 强制思考快捷：模型含 nex，关档整体跳过
check("off + nex → skipped", buildThinkingParams({ ...base, model: "nex-n2.6-2026-11-05", providerPreset: "", reasoningEffort: "off" }), {});

// 已知 preset：thinking + reasoning_effort
check("off + preset", buildThinkingParams({ ...base, reasoningEffort: "off" }), {
  thinking: { type: "disabled" },
  reasoning_effort: "none",
});
check("high + preset", buildThinkingParams({ ...base, reasoningEffort: "high" }), {
  thinking: { type: "enabled" },
  reasoning_effort: "high",
});

// 自定义网关：只发统一 reasoning_effort
check("off + gateway", buildThinkingParams({ ...base, providerPreset: "", reasoningEffort: "off" }), {
  reasoning_effort: "none",
});
check("medium + gateway", buildThinkingParams({ ...base, providerPreset: "", reasoningEffort: "medium" }), {
  reasoning_effort: "medium",
});

// DashScope：enable_thinking 开关 + reasoning_effort
const dashscope = { ...base, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" };
check("medium + dashscope", buildThinkingParams({ ...dashscope, reasoningEffort: "medium" }), {
  enable_thinking: true,
  reasoning_effort: "medium",
});
check("off + dashscope", buildThinkingParams({ ...dashscope, reasoningEffort: "off" }), {
  enable_thinking: false,
});
check("off + dashscope qwen3.7-max", buildThinkingParams({ ...dashscope, model: "qwen3.7-max-260628", reasoningEffort: "off" }), {
  enable_thinking: true,
});

// 智谱：GLM-5.3 只认 low/high/max，5.2 直传，其余不发 effort，5.3 关档跳过
const bigmodel = { ...base, baseUrl: "https://open.bigmodel.cn/api/paas/v4" };
check("low + glm-5.3", buildThinkingParams({ ...bigmodel, model: "glm-5.3", reasoningEffort: "low" }), {
  thinking: { type: "enabled" },
  reasoning_effort: "low",
});
check("medium + glm-5.3 → high", buildThinkingParams({ ...bigmodel, model: "glm-5.3", reasoningEffort: "medium" }), {
  thinking: { type: "enabled" },
  reasoning_effort: "high",
});
check("high + glm-5.3 → max", buildThinkingParams({ ...bigmodel, model: "glm-5.3", reasoningEffort: "high" }), {
  thinking: { type: "enabled" },
  reasoning_effort: "max",
});
check("low + glm-5.2", buildThinkingParams({ ...bigmodel, model: "glm-5-2-260617", reasoningEffort: "low" }), {
  thinking: { type: "enabled" },
  reasoning_effort: "low",
});
check("high + glm-4.7 (no effort)", buildThinkingParams({ ...bigmodel, model: "glm-4.7-flash", reasoningEffort: "high" }), {
  thinking: { type: "enabled" },
});
check("off + glm-4.7 → disabled", buildThinkingParams({ ...bigmodel, model: "glm-4.7-flash", reasoningEffort: "off" }), {
  thinking: { type: "disabled" },
});
check("off + glm-5.3 → skipped", buildThinkingParams({ ...bigmodel, model: "glm-5.3", reasoningEffort: "off" }), {});

// 归一化与遗留迁移
check("normalize bad value", normalizeThinkingEffort("whatever"), "default");
check("normalize case", normalizeThinkingEffort(" HIGH "), "high");
check("isActive off", thinkingEffortIsActive("off"), false);
check("isActive medium", thinkingEffortIsActive("medium"), true);
check("legacy true → medium", resolveReasoningEffort(undefined, true), "medium");
check("legacy false → default", resolveReasoningEffort(undefined, false), "default");
check("explicit default wins over legacy true", resolveReasoningEffort("default", true), "medium");
check("explicit low wins over legacy false", resolveReasoningEffort("low", false), "low");

// 禁思考参数识别与剥离
const withDisable = { model: "m", thinking: { type: "disabled" }, reasoning_effort: "none", temperature: 0.7 };
check("hasDisableThinkingParams", hasDisableThinkingParams(withDisable), true);
stripDisableThinkingParams(withDisable);
check("strip keeps other params", withDisable, { model: "m", temperature: 0.7 });

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
