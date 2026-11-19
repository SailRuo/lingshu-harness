import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const ConfigSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8600),
  // Loopback by default. The desktop GUI always talks to the backend over
  // 127.0.0.1, and the API has no authentication of its own, so exposing it
  // on every interface would let anyone on the LAN drive the app. Set HOST
  // explicitly (or LINGSHU_BACKEND_HOST from the desktop launcher) to opt
  // into LAN access.
  HOST: z.string().default("127.0.0.1"),
  // 迁移期开关：python | node | hybrid（Node 实现不做 Python 代理转发）
  BACKEND_MODE: z.enum(["python", "node", "hybrid"]).default("node"),
  PYTHON_BACKEND_URL: z.string().default("http://localhost:8601"),
  LOG_LEVEL: z.string().default("info"),
  DB_PATH: z.string().default("./data/lingshu.db"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const config: AppConfig = ConfigSchema.parse(process.env);

export const isNodeMode = () => config.BACKEND_MODE === "node";
export const isHybridMode = () => config.BACKEND_MODE === "hybrid";