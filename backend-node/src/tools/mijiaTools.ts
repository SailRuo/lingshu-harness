import type { NativeToolDefinition } from "./nativeTools.js";

export const MIJIA_TOOL_NAMES = [
  "list_homes",
  "list_devices",
  "list_device_capabilities",
  "get_device_properties",
  "get_device_property",
  "set_device_property",
  "run_device_action",
  "control_device",
  "list_scenes",
  "run_scene",
] as const;

type MijiaToolName = (typeof MIJIA_TOOL_NAMES)[number];

const DESCRIPTIONS: Record<MijiaToolName, string> = {
  list_homes: "列出米家账号下的家庭。",
  list_devices: "列出米家设备；可选 home_id。",
  list_device_capabilities: "查询指定设备可读写属性和可执行动作。",
  get_device_properties: "读取指定设备全部可读属性。",
  get_device_property: "读取指定设备的一个属性。",
  set_device_property: "设置指定设备的属性值。",
  run_device_action: "执行指定设备动作。",
  control_device: "高级控制：on、off、toggle 或 property=value。",
  list_scenes: "列出米家手动场景。",
  run_scene: "按 scene_id 和 home_id 执行米家场景。",
};

const PARAMETERS = {
  type: "object",
  properties: {
    dev_name: { type: "string", description: "米家中的设备名称。" },
    home_id: { type: "string", description: "米家家庭 ID。" },
    prop_name: { type: "string", description: "设备属性名。" },
    value: { type: "string", description: "属性值。" },
    action_name: { type: "string", description: "设备动作名。" },
    command: { type: "string", description: "on、off、toggle 或 property=value。" },
    scene_id: { type: "string", description: "米家场景 ID。" },
  },
  additionalProperties: false,
};

export const mijiaToolDefinitions: NativeToolDefinition[] = MIJIA_TOOL_NAMES.map((name) => ({
  name,
  description: `${DESCRIPTIONS[name]} 未登录或登录失效时，提示用户去 设置→插件→米家智能家居 扫码登录。`,
  inputSchema: PARAMETERS,
  group: "mijia",
}));
