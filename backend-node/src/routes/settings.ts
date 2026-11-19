import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getSettings,
  saveSettings,
  getGeneralSettings,
  saveGeneralSettings,
  getSecuritySettings,
  saveSecuritySettings,
} from "../services/settingsService.js";

export async function registerSettingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async () => getSettings());
  app.post("/api/settings", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    return saveSettings(body);
  });

  app.get("/api/settings/general", async () => getGeneralSettings());
  app.post("/api/settings/general", async (req) => saveGeneralSettings((req.body ?? {}) as any));

  app.get("/api/settings/security", async () => getSecuritySettings());
  app.post("/api/settings/security", async (req) => saveSecuritySettings((req.body ?? {}) as any));
}