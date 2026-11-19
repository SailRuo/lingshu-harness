import type { FastifyInstance } from "fastify";
import { exec } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function dataRoot() {
  return path.join(os.homedir(), ".lingshu");
}

export async function registerSystemExtraRoutes(app: FastifyInstance) {
  app.get("/api/system/data-path", async () => {
    const dataPath = dataRoot();
    return {
      dataPath,
      defaultDataPath: dataPath,
      runtimePath: path.join(dataPath, "runtime"),
      modelsPath: path.join(dataPath, "models"),
      persisted: false,
    };
  });

  app.post("/api/system/open-path", async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const raw = String(body.path || "").trim();
    if (!raw) {
      reply.code(400).send({ detail: "path 不能为空" });
      return;
    }
    const target = path.resolve(raw);
    if (!fs.existsSync(target)) {
      reply.code(404).send({ detail: `路径不存在: ${target}` });
      return;
    }
    const cmd = process.platform === "darwin" ? `open "${target}"` : process.platform === "win32" ? `start "" "${target}"` : `xdg-open "${target}"`;
    exec(cmd);
    return { status: "ok", path: target };
  });
}