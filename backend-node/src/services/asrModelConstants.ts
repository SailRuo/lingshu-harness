/**
 * ASR 模型不再随安装包分发，改由用户在设置页下载或导入。
 * 默认地址为本仓库 GitHub Releases 的发布资产，可用环境变量覆盖。
 */
export const ASR_MODEL_ID = "sherpa-onnx-streaming-paraformer-zh";

const ENV_URL = String(process.env.LINGSHU_ASR_MODEL_URL || "").trim();

export const DEFAULT_ASR_MODEL_URL =
  ENV_URL ||
  "https://github.com/SailRuo/lingshu-harness/releases/latest/download/sherpa-onnx-streaming-paraformer-zh.zip";
