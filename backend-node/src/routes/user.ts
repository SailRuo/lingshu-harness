import type { FastifyInstance } from "fastify";
import { getUserProfile, updateUserProfile } from "../services/userService.js";

export async function registerUserRoutes(app: FastifyInstance) {
  app.get("/api/v1/user/profile", async (req) => {
    const userId = (req.query as any)?.user_id || "default_user";
    return getUserProfile(String(userId));
  });
  app.post("/api/v1/user/profile", async (req) => {
    const userId = (req.query as any)?.user_id || "default_user";
    return updateUserProfile(String(userId), req.body ?? {});
  });
}