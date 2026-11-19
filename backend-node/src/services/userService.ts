import { getDb } from "../db/sqlite.js";

export interface UserProfileResponse {
  userId: string;
  nickname: string;
  gender: string;
  age: number;
  bio: string;
  voiceprintEnabled: boolean;
  voiceprintThreshold: number;
  voiceprintSampleCount: number;
  hasVoiceprint: boolean;
  updatedAt: string;
}

function getOrCreate(userId: string) {
  const db = getDb();
  let row = db.prepare("SELECT * FROM user_profiles WHERE user_id = ?").get(userId) as any;
  if (!row) {
    db.prepare(
      `INSERT INTO user_profiles (user_id) VALUES (?)`,
    ).run(userId);
    row = db.prepare("SELECT * FROM user_profiles WHERE user_id = ?").get(userId);
  }
  return row;
}

export function getUserProfile(userId = "default_user"): UserProfileResponse {
  const row: any = getOrCreate(userId);
  return {
    userId: row.user_id,
    nickname: row.nickname,
    gender: row.gender,
    age: row.age,
    bio: row.bio,
    voiceprintEnabled: !!row.voiceprint_enabled,
    voiceprintThreshold: row.voiceprint_threshold,
    voiceprintSampleCount: row.voiceprint_sample_count,
    hasVoiceprint: !!row.voiceprint_embedding && row.voiceprint_embedding.trim() !== "",
    updatedAt: row.updated_at,
  };
}

export function updateUserProfile(userId = "default_user", body: any) {
  const db = getDb();
  getOrCreate(userId);
  const fields: string[] = [];
  const vals: any[] = [];
  if (body.nickname !== undefined) { fields.push("nickname = ?"); vals.push(String(body.nickname).trim()); }
  if (body.gender !== undefined) { fields.push("gender = ?"); vals.push(String(body.gender).trim()); }
  if (body.age !== undefined) { fields.push("age = ?"); vals.push(Math.max(0, Math.min(150, Number(body.age)))); }
  if (body.bio !== undefined) { fields.push("bio = ?"); vals.push(String(body.bio).trim()); }
  if (body.voiceprintEnabled !== undefined) { fields.push("voiceprint_enabled = ?"); vals.push(body.voiceprintEnabled ? 1 : 0); }
  if (body.voiceprintThreshold !== undefined) { fields.push("voiceprint_threshold = ?"); vals.push(Math.max(0.1, Math.min(0.99, Number(body.voiceprintThreshold)))); }
  fields.push("updated_at = datetime('now')");
  vals.push(userId);
  db.prepare(`UPDATE user_profiles SET ${fields.join(", ")} WHERE user_id = ?`).run(...vals);
  return getUserProfile(userId);
}