/**
 * Node backend SQLite schema.
 *
 * IMPORTANT: this schema is owned by the Node backend. By default the Node
 * service uses its own database file (see config.DB_PATH) and must NOT be
 * pointed at the Python backend's database (which tracks `user_version = 12`)
 * without an explicit migration plan. The schema below is additive on top of
 * the Node versions (currently `user_version = 20`); never share a single file
 * between the two runtimes unless you have verified the version handoff.
 *
 * All changes here must stay backwards compatible: add columns/indexes/tables
 * only, never drop or retype existing ones.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { config } from "../config.js";

let db: Database.Database | null = null;
let vectorExtensionReady = false;
let vectorExtensionError: string | null = null;

/**
 * sqlite-vec is optional at runtime. Callers that claim ANN must consult this
 * status instead of silently assuming the vec0 tables exist.
 */
export function vectorExtensionStatus(): { ready: boolean; error: string | null } {
  return { ready: vectorExtensionReady, error: vectorExtensionError };
}

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = path.resolve(config.DB_PATH);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initVectorExtension(db);
  initSchema(db);
  return db;
}

function initVectorExtension(database: Database.Database) {
  try {
    const require = createRequire(import.meta.url);
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(database);
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS stream_vec USING vec0(stream_id TEXT PRIMARY KEY, embedding float[768]);
      CREATE VIRTUAL TABLE IF NOT EXISTS seed_wake_vec USING vec0(seed_id TEXT PRIMARY KEY, embedding float[768]);
      CREATE VIRTUAL TABLE IF NOT EXISTS seed_boost_vec USING vec0(seed_id TEXT PRIMARY KEY, embedding float[768]);
      CREATE VIRTUAL TABLE IF NOT EXISTS seed_suppress_vec USING vec0(seed_id TEXT PRIMARY KEY, embedding float[768]);
      CREATE VIRTUAL TABLE IF NOT EXISTS entity_vec USING vec0(entity_id TEXT PRIMARY KEY, embedding float[768]);
    `);
    vectorExtensionReady = true;
    vectorExtensionError = null;
  } catch (error) {
    vectorExtensionReady = false;
    vectorExtensionError = error instanceof Error ? error.message : String(error);
  }
}

const SCHEMA_VERSION = 22;

function initSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar TEXT,
      color TEXT,
      voice TEXT,
      role_setting TEXT,
      speaking_style TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      self_evolution_enabled INTEGER NOT NULL DEFAULT 1,
      time_mirror_enabled INTEGER NOT NULL DEFAULT 1,
      proactive_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS settings_rows (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL DEFAULT '',
      gender TEXT NOT NULL DEFAULT '保密',
      age INTEGER NOT NULL DEFAULT 0,
      bio TEXT NOT NULL DEFAULT '',
      voiceprint_embedding TEXT NOT NULL DEFAULT '',
      voiceprint_sample_count INTEGER NOT NULL DEFAULT 0,
      voiceprint_enabled INTEGER NOT NULL DEFAULT 0,
      voiceprint_threshold REAL NOT NULL DEFAULT 0.65,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      agent_id INTEGER NOT NULL,
      last_message_text TEXT,
      last_message_at TEXT,
      last_message_kind TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0,
      last_read_message_id INTEGER,
      last_read_at TEXT,
      active_skills TEXT,
      thread_skills TEXT,
      -- Oldest message id the LLM context still starts from. The window is
      -- anchored here and only ever grows, so the request prefix stays
      -- byte-identical between turns and the provider's prompt cache keeps
      -- hitting. It is moved forward rarely (see loadThreadHistory).
      llm_anchor_message_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, agent_id)
    );
  `);
  database.exec(
    `CREATE INDEX IF NOT EXISTS ix_chat_threads_user_updated ON chat_threads (user_id, updated_at);`,
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      agent_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_kind TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      reply_to_message_id INTEGER,
      turn_pair_id INTEGER,
      task_id TEXT,
      user_images_json TEXT,
      assistant_images_json TEXT,
      -- The exact text that was sent to the LLM for this message. It can differ
      -- from the content column (the per-turn context rides along with the user
      -- turn), and it has to be replayed verbatim so the request prefix is stable.
      llm_content TEXT,
      -- The tool round-trip of the turn, stored verbatim so the next request can
      -- replay it exactly (assistant tool_calls + tool results). Dropping it
      -- changes the request prefix and costs the provider's prompt cache.
      tool_messages_json TEXT,
      input_metadata TEXT,
      assistant_read_at TEXT,
      assistant_unspoken TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      error_message TEXT,
      emotional_analysis TEXT,
      retrieved_facts TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      digested_at TEXT,
      purge_at TEXT
    );
  `);
  database.exec(
    `CREATE INDEX IF NOT EXISTS ix_chat_messages_thread_created ON chat_messages (thread_id, created_at);`,
  );
  database.exec(
    `CREATE INDEX IF NOT EXISTS ix_chat_messages_user_agent_created ON chat_messages (user_id, agent_id, created_at);`,
  );
  database.exec(
    `CREATE INDEX IF NOT EXISTS ix_chat_messages_turn_pair ON chat_messages (turn_pair_id);`,
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      task_id TEXT PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      message_id INTEGER,
      mode TEXT NOT NULL,
      state TEXT NOT NULL,
      root_event_id TEXT,
      last_event_id TEXT,
      last_checkpoint_id TEXT,
      resume_count INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      workspace_path TEXT,
      request_text TEXT,
      started_at TEXT NOT NULL,
      interrupted_at TEXT,
      resumed_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_task_runs_thread ON task_runs (thread_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS task_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES task_runs(task_id) ON DELETE CASCADE,
      parent_event_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      event_sequence INTEGER NOT NULL,
      step_type TEXT NOT NULL,
      step_status TEXT,
      attempt_no INTEGER NOT NULL DEFAULT 1,
      attempt_group_id TEXT,
      branch_id TEXT,
      node_name TEXT,
      error_class TEXT,
      payload_json TEXT,
      error_json TEXT,
      stdout_preview TEXT,
      stderr_preview TEXT,
      output_truncated INTEGER NOT NULL DEFAULT 0,
      output_bytes INTEGER,
      output_checksum TEXT,
      artifact_ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (task_id, event_sequence)
    );
    CREATE INDEX IF NOT EXISTS ix_task_events_task_seq ON task_events (task_id, event_sequence);

    CREATE TABLE IF NOT EXISTS task_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES task_runs(task_id) ON DELETE CASCADE,
      event_sequence INTEGER,
      state_snapshot_json TEXT,
      pending_queue_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (task_id, event_sequence)
    );

    CREATE TABLE IF NOT EXISTS mcp_server_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      transport_type TEXT NOT NULL,
      command TEXT,
      args_json TEXT,
      env_json TEXT,
      url TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_token_usage_daily (
      day TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension TEXT NOT NULL DEFAULT 'input_uncached',
      input_cached INTEGER NOT NULL DEFAULT 0,
      input_uncached INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      cache_creation INTEGER NOT NULL DEFAULT 0,
      output_cached INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, model, dimension)
    );
    CREATE TABLE IF NOT EXISTS tts_usage_daily (
      day TEXT NOT NULL,
      provider TEXT NOT NULL,
      chars INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, provider)
    );

    -- Per-call request / response log. The GUI drawer renders it as the
    -- "调用记录" panel: the raw LLM payload plus the provider usage counters
    -- (input cache hit / output cache hit).
    CREATE TABLE IF NOT EXISTS llm_call_traces (
      id TEXT PRIMARY KEY,
      thread_id INTEGER NOT NULL,
      turn_id TEXT,
      kind TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      tool_name TEXT,
      request_json TEXT,
      response_json TEXT,
      usage_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_llm_call_traces_thread_created
      ON llm_call_traces (thread_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS hippocampus_streams (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      narrative TEXT NOT NULL DEFAULT '',
      about TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'external',
      raw_start INTEGER,
      raw_end INTEGER,
      revisit_count INTEGER NOT NULL DEFAULT 1,
      revisit_last_at TEXT,
      last_proactive_at TEXT,
      significance REAL NOT NULL DEFAULT 0.5,
      archived INTEGER NOT NULL DEFAULT 0,
      cluster_linked_at TEXT,
      origin_scope TEXT,
      perspective TEXT,
      origin_group_session_id TEXT,
      origin_theater_id TEXT,
      participants_json TEXT,
      embedding BLOB,
      embedding_dim INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_streams_scope ON hippocampus_streams (agent_id, user_id, archived, created_at DESC);

    CREATE TABLE IF NOT EXISTS hippocampus_seeds (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT 'about_self',
      source TEXT NOT NULL DEFAULT 'learned',
      tags_json TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      applicability_json TEXT,
      inner_orientation TEXT NOT NULL DEFAULT '',
      outer_expression TEXT NOT NULL DEFAULT '',
      wake_text TEXT NOT NULL DEFAULT '',
      boost_text TEXT NOT NULL DEFAULT '',
      suppress_text TEXT NOT NULL DEFAULT '',
      innate INTEGER NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0,
      last_seen TEXT,
      wake_embedding BLOB,
      boost_embedding BLOB,
      suppress_embedding BLOB,
      embedding_dim INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_seeds_scope ON hippocampus_seeds (agent_id, user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS hippocampus_seed_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      seed_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      trigger_source TEXT NOT NULL DEFAULT 'manual',
      reason TEXT,
      session_id INTEGER,
      turn_ids_json TEXT,
      before_json TEXT,
      after_json TEXT,
      field TEXT,
      affect_note TEXT,
      recall_audit_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_seed_versions_seed ON hippocampus_seed_versions (seed_id, version_no DESC);

    CREATE TABLE IF NOT EXISTS hippocampus_entities (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      description TEXT,
      narrative TEXT,
      embedding BLOB,
      embedding_dim INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_entities_scope ON hippocampus_entities (agent_id, user_id, name, type);

    CREATE TABLE IF NOT EXISTS hippocampus_facts (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      from_entity_id TEXT,
      to_entity_id TEXT,
      relation TEXT NOT NULL,
      description TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'current',
      importance REAL NOT NULL DEFAULT 0.5,
      is_identity INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      expired_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_hc_facts_scope ON hippocampus_facts (agent_id, user_id, status);

    CREATE TABLE IF NOT EXISTS hippocampus_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      UNIQUE (edge_type, source_id, target_id)
    );
    CREATE INDEX IF NOT EXISTS ix_hc_edges_source ON hippocampus_edges (source_id, edge_type);
    CREATE INDEX IF NOT EXISTS ix_hc_edges_target ON hippocampus_edges (target_id, edge_type);

    CREATE TABLE IF NOT EXISTS hippocampus_threads (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      owner TEXT,
      current_grip REAL,
      last_note TEXT,
      origin_note TEXT,
      embedding BLOB,
      embedding_dim INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_touchpoints (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      episode_ref TEXT,
      grip REAL,
      stance_note TEXT,
      affect_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_touchpoints_thread ON hippocampus_touchpoints (thread_id, created_at);

    CREATE TABLE IF NOT EXISTS hippocampus_constraints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      description TEXT NOT NULL,
      opt_out_proactive INTEGER NOT NULL DEFAULT 0,
      evidence_refs_json TEXT,
      evidence TEXT,
      segment_ref TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      due_at TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      recur TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      evidence TEXT,
      evidence_turn_id INTEGER,
      embedding TEXT,
      last_delivered_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_tick_log (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      tick_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      payload_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_hc_tick_log_scope ON hippocampus_tick_log (agent_id, user_id, triggered_at DESC);

    CREATE TABLE IF NOT EXISTS hippocampus_self_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      trigger TEXT,
      turn_id INTEGER,
      closeness REAL NOT NULL DEFAULT 0,
      closeness_trend REAL NOT NULL DEFAULT 0,
      intimacy_tier TEXT NOT NULL DEFAULT 'surface',
      template_risk REAL NOT NULL DEFAULT 0,
      granularity TEXT,
      sample_count INTEGER,
      period TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_self_state_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      closeness REAL NOT NULL DEFAULT 0,
      closeness_trend REAL NOT NULL DEFAULT 0,
      template_risk REAL NOT NULL DEFAULT 0,
      intimacy_tier TEXT NOT NULL DEFAULT 'surface',
      sample_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (agent_id, user_id, day)
    );
    CREATE INDEX IF NOT EXISTS ix_hc_self_state_daily_scope
      ON hippocampus_self_state_daily (agent_id, user_id, day DESC);
    CREATE TABLE IF NOT EXISTS hippocampus_baselines (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      baseline_status TEXT NOT NULL DEFAULT 'cold',
      text_valence REAL,
      text_arousal REAL,
      text_dominance REAL,
      voice_affect_json TEXT,
      text_iqr_json TEXT,
      voice_iqr_json TEXT,
      text_samples_json TEXT,
      voice_samples_json TEXT,
      evidence_refs_json TEXT,
      sample_count INTEGER NOT NULL DEFAULT 0,
      text_sample_count INTEGER NOT NULL DEFAULT 0,
      voice_sample_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      created_at TEXT,
      PRIMARY KEY (agent_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS hippocampus_affect_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      thread_id INTEGER,
      turn_id INTEGER,
      channel TEXT NOT NULL DEFAULT 'text',
      source TEXT NOT NULL DEFAULT 'runtime',
      valence REAL,
      arousal REAL,
      dominance REAL,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_hc_affect_scope ON hippocampus_affect_points (agent_id, user_id, created_at);
    CREATE TABLE IF NOT EXISTS hippocampus_affect_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      day TEXT NOT NULL,
      valence REAL NOT NULL DEFAULT 0,
      arousal REAL NOT NULL DEFAULT 0,
      dominance REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (agent_id, user_id, channel, day)
    );
    CREATE INDEX IF NOT EXISTS ix_hc_affect_daily_scope
      ON hippocampus_affect_daily (agent_id, user_id, channel, day DESC);
    CREATE TABLE IF NOT EXISTS hippocampus_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_recall_traces (
      turn_id INTEGER PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hippocampus_retrospect_buckets (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      granularity TEXT NOT NULL,
      bucket_key TEXT NOT NULL,
      period_start TEXT,
      period_end TEXT,
      is_frozen INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      narrative TEXT,
      dimensions_json TEXT,
      evidence_ids_json TEXT,
      themes_json TEXT,
      mood_trajectory_json TEXT,
      changes_json TEXT,
      portrait_source_marker TEXT,
      arc_source_marker TEXT,
      portrait_evidence_ids_json TEXT,
      arc_evidence_ids_json TEXT,
      portrait_frozen INTEGER DEFAULT 0,
      arc_frozen INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, user_id, granularity, bucket_key)
    );
    CREATE TABLE IF NOT EXISTS hippocampus_portraits (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      narrative TEXT,
      dimensions_json TEXT,
      evidence_ids_json TEXT,
      last_stream_marker TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, user_id)
    );

    -- v19: private digest high-water mark. 'last_message_id' is a desktop-only
    -- tie-breaker for messages sharing the same created_at (APP has no id here).
    CREATE TABLE IF NOT EXISTS digest_state (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      last_message_created_at TEXT,
      last_message_id INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS ix_digest_state_updated
      ON digest_state (updated_at);

    -- v19: cross-object background task event log. This is deliberately not
    -- 'task_events' (agent task runtime) and not 'hippocampus_tick_log'
    -- (per agent+user memory audit).
    CREATE TABLE IF NOT EXISTS background_task_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      subject_type TEXT NOT NULL DEFAULT '',
      subject_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_background_task_events_created_at
      ON background_task_events (created_at DESC);
    CREATE INDEX IF NOT EXISTS ix_background_task_events_subject
      ON background_task_events (event_type, subject_type, subject_id, created_at DESC);

    -- v19: generic state-change ledger. M1 only backfills provable seed history;
    -- portrait entries start from the first real change after migration.
    CREATE TABLE IF NOT EXISTS agent_state_changes (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      base_revision INTEGER NOT NULL DEFAULT 0,
      new_revision INTEGER NOT NULL DEFAULT 0,
      before_json TEXT,
      after_json TEXT,
      reason TEXT NOT NULL DEFAULT '',
      evidence_json TEXT,
      batch_key TEXT,
      source TEXT NOT NULL DEFAULT 'model',
      created_at TEXT NOT NULL,
      UNIQUE (batch_key, target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS ix_agent_state_changes_target
      ON agent_state_changes (agent_id, target_kind, target_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS ix_agent_state_changes_scope_created
      ON agent_state_changes (agent_id, user_id, created_at DESC);

    -- v19: private conversation anchor (summary). Empty at migration time: no
    -- trustworthy historical summary exists, so none is invented.
    CREATE TABLE IF NOT EXISTS conversation_anchors (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      covered_at TEXT NOT NULL,
      covered_message_id INTEGER,
      updated_at TEXT NOT NULL,
      self_narrative TEXT NOT NULL DEFAULT '',
      self_dimensions_json TEXT NOT NULL DEFAULT '{}',
      self_retired_json TEXT NOT NULL DEFAULT '[]',
      self_updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (agent_id, user_id)
    );

    -- v21: the last real usage the most recent private chat request reported.
    -- It is the conversation anchor's primary trigger signal (APP
    -- NativeCoreMessages.lastChatUsage); the character estimate is only the
    -- fallback when no provider usage has been recorded yet.
    CREATE TABLE IF NOT EXISTS chat_usage_state (
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT '',
      base_url_hash TEXT NOT NULL DEFAULT '',
      measured_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, user_id)
    );

    -- v20: APP relationship continuity (shared context). This is deliberately
    -- separate from the retired desktop "心事线" tables and is not injected
    -- into chat prompts.
    CREATE TABLE IF NOT EXISTS relationship_threads (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      first_message_id TEXT NOT NULL,
      first_at TEXT NOT NULL,
      last_message_id TEXT NOT NULL,
      last_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_relationship_threads_agent_last
      ON relationship_threads (agent_id, user_id, last_at DESC);
    CREATE TABLE IF NOT EXISTS relationship_thread_nodes (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      carry_note TEXT NOT NULL DEFAULT '',
      batch_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (thread_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS ix_relationship_thread_nodes_thread
      ON relationship_thread_nodes (thread_id, occurred_at);

    CREATE TABLE IF NOT EXISTS obs_snapshot_merge_log (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      merged_at TEXT NOT NULL,
      UNIQUE (agent_id, user_id, year, month)
    );
    CREATE INDEX IF NOT EXISTS ix_obs_snapshot_merge_scope
      ON obs_snapshot_merge_log (agent_id, user_id);

    CREATE TABLE IF NOT EXISTS wechat_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ilink_bot_id TEXT,
      bot_token TEXT,
      bot_user_id TEXT,
      base_url TEXT,
      agent_id INTEGER,
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qqbot_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL UNIQUE,
      agent_id INTEGER NOT NULL UNIQUE,
      client_secret_enc TEXT NOT NULL,
      reply_with_voice INTEGER NOT NULL DEFAULT 0,
      enabled_private INTEGER NOT NULL DEFAULT 1,
      enabled_group INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'disconnected',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proactive_routes (
      agent_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      context_token TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, channel)
    );

    -- Desktop multi-agent group chat. Public events live in their own table so
    -- they can never leak into private chat threads or their prompt history.
    CREATE TABLE IF NOT EXISTS group_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      unread_count INTEGER NOT NULL DEFAULT 0,
      last_message_text TEXT,
      last_message_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_group_sessions_user_updated
      ON group_sessions (user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS group_members (
      group_session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      joined_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_session_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS ix_group_members_agent
      ON group_members (agent_id, status);

    CREATE TABLE IF NOT EXISTS group_messages (
      id TEXT PRIMARY KEY,
      group_session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      speaker_type TEXT NOT NULL,
      speaker_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata_json TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_group_messages_session_created
      ON group_messages (group_session_id, created_at, id);
    CREATE INDEX IF NOT EXISTS ix_group_messages_turn
      ON group_messages (turn_id);

    CREATE TABLE IF NOT EXISTS group_read_state (
      group_session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      last_read_message_id TEXT,
      last_read_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_session_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_conversation_anchors (
      group_session_id TEXT PRIMARY KEY REFERENCES group_sessions(id) ON DELETE CASCADE,
      summary TEXT NOT NULL DEFAULT '',
      covered_message_id TEXT NOT NULL,
      covered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_digest_state (
      group_session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL,
      last_message_created_at TEXT,
      last_message_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_session_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS group_director_turns (
      id TEXT PRIMARY KEY,
      group_session_id TEXT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      trigger_message_id TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_group_director_turns_session
      ON group_director_turns (group_session_id, created_at DESC);
  `);

  const current = database.pragma("user_version", { simple: true }) as number;
  if (current < 5) {
    addColumnIfMissing(database, "chat_threads", "pending_task_context", "TEXT");
  }
  if (current < 11) {
    addColumnIfMissing(database, "chat_threads", "active_skills", "TEXT");
    addColumnIfMissing(database, "chat_threads", "thread_skills", "TEXT");
  }
  if (current < 7) {
    addColumnIfMissing(database, "hippocampus_threads", "origin_note", "TEXT");
    addColumnIfMissing(database, "hippocampus_threads", "embedding", "BLOB");
    addColumnIfMissing(database, "hippocampus_threads", "embedding_dim", "INTEGER");
    addColumnIfMissing(database, "hippocampus_portraits", "last_stream_marker", "TEXT");
    addColumnIfMissing(database, "hippocampus_portraits", "created_at", "TEXT");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "portrait_source_marker", "TEXT");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "arc_source_marker", "TEXT");
    addColumnIfMissing(database, "hippocampus_baselines", "baseline_status", "TEXT NOT NULL DEFAULT 'cold'");
    addColumnIfMissing(database, "hippocampus_baselines", "text_samples_json", "TEXT");
    addColumnIfMissing(database, "hippocampus_baselines", "voice_samples_json", "TEXT");
    addColumnIfMissing(database, "hippocampus_baselines", "evidence_refs_json", "TEXT");
  }
  if (current < 14) {
    // Additive migration: new columns/indexes/tables only. Safe to re-run.
    // v13 shipped the version bump before these columns in a hot-reload race,
    // so v14 re-runs the same idempotent statements for existing databases.
    addColumnIfMissing(database, "hippocampus_facts", "updated_at", "TEXT");
    addColumnIfMissing(database, "hippocampus_entities", "narrative", "TEXT");
    addColumnIfMissing(database, "hippocampus_entities", "embedding", "BLOB");
    addColumnIfMissing(database, "hippocampus_entities", "embedding_dim", "INTEGER");
    addColumnIfMissing(database, "hippocampus_appointments", "embedding", "TEXT");
    addColumnIfMissing(
      database,
      "hippocampus_affect_points",
      "source",
      "TEXT NOT NULL DEFAULT 'runtime'",
    );
    addColumnIfMissing(database, "hippocampus_baselines", "created_at", "TEXT");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "portrait_evidence_ids_json", "TEXT");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "arc_evidence_ids_json", "TEXT");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "portrait_frozen", "INTEGER DEFAULT 0");
    addColumnIfMissing(database, "hippocampus_retrospect_buckets", "arc_frozen", "INTEGER DEFAULT 0");

    // Unique indexes require existing duplicates to be removed first. Rows with
    // a NULL key are exempt because SQLite treats NULLs as distinct in unique
    // indexes, so they can never conflict.
    database.transaction(() => {
      database.exec(`
        DELETE FROM hippocampus_affect_points
        WHERE turn_id IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM hippocampus_affect_points
            WHERE turn_id IS NOT NULL
            GROUP BY turn_id, channel
          );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_hc_affect_turn_channel
          ON hippocampus_affect_points (turn_id, channel);

        DELETE FROM hippocampus_constraints
        WHERE segment_ref IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM hippocampus_constraints
            WHERE segment_ref IS NOT NULL
            GROUP BY agent_id, user_id, segment_ref, description
          );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_hc_constraints_scope_segment_desc
          ON hippocampus_constraints (agent_id, user_id, segment_ref, description);

        CREATE INDEX IF NOT EXISTS ix_hc_facts_from_status
          ON hippocampus_facts (from_entity_id, status);
        CREATE INDEX IF NOT EXISTS ix_hc_threads_scope_updated
          ON hippocampus_threads (agent_id, user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS ix_hc_seed_versions_scope_seed_created
          ON hippocampus_seed_versions (agent_id, user_id, seed_id, created_at);
        CREATE INDEX IF NOT EXISTS ix_hc_seed_versions_scope_created
          ON hippocampus_seed_versions (agent_id, user_id, created_at);
      `);
    })();
  }
  if (current < 15) {
    // Additive seed metrics: count/last_seen power real salience instead of a
    // version-table proxy. Idempotent: only rows never backfilled (last_seen
    // IS NULL) are touched, so re-running the migration cannot reset counts.
    addColumnIfMissing(database, "hippocampus_seeds", "count", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(database, "hippocampus_seeds", "last_seen", "TEXT");
    database.transaction(() => {
      database.exec(`
        UPDATE hippocampus_seeds
        SET count = MAX(1, COALESCE((
              SELECT COUNT(*) FROM hippocampus_seed_versions v
              WHERE v.seed_id = hippocampus_seeds.id
                AND v.event_type IN ('new', 'reinforce', 'merge', 'revise')
            ), 0)),
            last_seen = COALESCE((
              SELECT MAX(v.created_at) FROM hippocampus_seed_versions v
              WHERE v.seed_id = hippocampus_seeds.id
                AND v.event_type IN ('new', 'reinforce', 'merge', 'revise')
            ), updated_at)
        WHERE last_seen IS NULL;
        CREATE INDEX IF NOT EXISTS ix_hc_seeds_scope_last_seen
          ON hippocampus_seeds (agent_id, user_id, last_seen DESC);
      `);
    })();
  }
  if (current < 16) {
    // Per-call request / response log (the GUI drawer's "调用记录" panel) plus
    // the cache counters the daily usage table needs. Additive and idempotent.
    addColumnIfMissing(database, "llm_token_usage_daily", "cache_creation", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(database, "llm_token_usage_daily", "output_cached", "INTEGER NOT NULL DEFAULT 0");
    database.exec(`
      CREATE TABLE IF NOT EXISTS llm_call_traces (
        id TEXT PRIMARY KEY,
        thread_id INTEGER NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        tool_name TEXT,
        request_json TEXT,
        response_json TEXT,
        usage_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_llm_call_traces_thread_created
        ON llm_call_traces (thread_id, created_at DESC);
    `);
  }
  if (current < 17) {
    // Per-call request / response log (the GUI drawer's "调用记录" panel) plus
    // the cache counters the daily usage table needs. Additive and idempotent.
    addColumnIfMissing(database, "llm_token_usage_daily", "cache_creation", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(database, "llm_token_usage_daily", "output_cached", "INTEGER NOT NULL DEFAULT 0");
    database.exec(`
      CREATE TABLE IF NOT EXISTS llm_call_traces (
        id TEXT PRIMARY KEY,
        thread_id INTEGER NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        tool_name TEXT,
        request_json TEXT,
        response_json TEXT,
        usage_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_llm_call_traces_thread_created
        ON llm_call_traces (thread_id, created_at DESC);
    `);
  }
  if (current < 19) {
    // v19: memory-alignment schema. One additive migration for the whole M1
    // write path (digest high-water mark, task events, seed lifecycle columns,
    // generic change ledger, private conversation anchors, theater provenance).
    // Nothing is dropped or retyped; every backfill is re-runnable.
    database.transaction(() => {
      // Ensure the v18 provenance columns exist before the normalization below
      // touches them. On a current v18 database these are no-ops.
      addColumnIfMissing(database, "hippocampus_streams", "origin_scope", "TEXT");
      addColumnIfMissing(database, "hippocampus_streams", "perspective", "TEXT");
      addColumnIfMissing(database, "hippocampus_streams", "origin_group_session_id", "TEXT");
      addColumnIfMissing(database, "hippocampus_streams", "participants_json", "TEXT");
      addColumnIfMissing(database, "hippocampus_streams", "origin_theater_id", "TEXT");
      database.exec(`
        CREATE INDEX IF NOT EXISTS ix_hc_streams_origin_scope
          ON hippocampus_streams (agent_id, user_id, archived, origin_scope, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_hc_streams_theater_origin
          ON hippocampus_streams (origin_theater_id, agent_id);
      `);

      addColumnIfMissing(database, "hippocampus_seeds", "revision", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(database, "hippocampus_seeds", "status", "TEXT NOT NULL DEFAULT 'active'");
      addColumnIfMissing(database, "hippocampus_seeds", "applicability_json", "TEXT");
      database.exec(`
        CREATE INDEX IF NOT EXISTS ix_hc_seeds_scope_status
          ON hippocampus_seeds (agent_id, user_id, status, updated_at DESC);
      `);
      // revision: seed_versions starts at 1 = creation; APP revision starts at 0.
      database.exec(`
        UPDATE hippocampus_seeds
        SET revision = COALESCE((
          SELECT MAX(v.version_no) - 1
          FROM hippocampus_seed_versions v
          WHERE v.seed_id = hippocampus_seeds.id
            AND v.event_type <> 'delete'
        ), 0)
        WHERE revision = 0
          AND EXISTS (
            SELECT 1 FROM hippocampus_seed_versions v
            WHERE v.seed_id = hippocampus_seeds.id
              AND v.event_type <> 'delete'
              AND v.version_no > 1
          );
      `);

      database.exec(`
        CREATE TABLE IF NOT EXISTS digest_state (
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          last_message_created_at TEXT,
          last_message_id INTEGER,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (agent_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS ix_digest_state_updated
          ON digest_state (updated_at);

        CREATE TABLE IF NOT EXISTS background_task_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          subject_type TEXT NOT NULL DEFAULT '',
          subject_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_background_task_events_created_at
          ON background_task_events (created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_background_task_events_subject
          ON background_task_events (event_type, subject_type, subject_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS agent_state_changes (
          id TEXT PRIMARY KEY,
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          target_kind TEXT NOT NULL,
          target_id TEXT NOT NULL,
          action TEXT NOT NULL,
          base_revision INTEGER NOT NULL DEFAULT 0,
          new_revision INTEGER NOT NULL DEFAULT 0,
          before_json TEXT,
          after_json TEXT,
          reason TEXT NOT NULL DEFAULT '',
          evidence_json TEXT,
          batch_key TEXT,
          source TEXT NOT NULL DEFAULT 'model',
          created_at TEXT NOT NULL,
          UNIQUE (batch_key, target_kind, target_id)
        );
        CREATE INDEX IF NOT EXISTS ix_agent_state_changes_target
          ON agent_state_changes (agent_id, target_kind, target_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS ix_agent_state_changes_scope_created
          ON agent_state_changes (agent_id, user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS conversation_anchors (
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          covered_at TEXT NOT NULL,
          covered_message_id INTEGER,
          updated_at TEXT NOT NULL,
          self_narrative TEXT NOT NULL DEFAULT '',
          self_dimensions_json TEXT NOT NULL DEFAULT '{}',
          self_retired_json TEXT NOT NULL DEFAULT '[]',
          self_updated_at TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (agent_id, user_id)
        );
      `);

      // digest_state backfill from digested_at. A scope with an older
      // undigested assistant row has a hole in the old row-level marker; do not
      // fabricate a high-water mark that would skip that row.
      const digestScopes = database
        .prepare(
          `SELECT agent_id, user_id, MAX(id) AS max_id
           FROM chat_messages
           WHERE digested_at IS NOT NULL
           GROUP BY agent_id, user_id`,
        )
        .all() as { agent_id: number; user_id: string; max_id: number }[];
      const insertDigestState = database.prepare(
        `INSERT OR IGNORE INTO digest_state
          (agent_id, user_id, last_message_created_at, last_message_id, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const insertTaskEvent = database.prepare(
        `INSERT INTO background_task_events
          (id, event_type, subject_type, subject_id, status, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const migrationEventId = `migration-v19-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      for (const scope of digestScopes) {
        const last = database
          .prepare("SELECT id, created_at FROM chat_messages WHERE id = ?")
          .get(scope.max_id) as { id: number; created_at: string } | undefined;
        if (!last?.created_at) continue;
        const hole = database
          .prepare(
            `SELECT 1 FROM chat_messages
             WHERE agent_id = ? AND user_id = ? AND role = 'assistant' AND status = 'completed'
               AND digested_at IS NULL
               AND (created_at < ? OR (created_at = ? AND id < ?))
             LIMIT 1`,
          )
          .get(scope.agent_id, scope.user_id, last.created_at, last.created_at, last.id);
        if (hole) {
          insertTaskEvent.run(
            `migration-v19-hole-${scope.agent_id}-${scope.user_id}-${Math.random().toString(36).slice(2, 8)}`,
            "schema_migration",
            "agent",
            String(scope.agent_id),
            "skipped",
            `digest_state_backfill_hole:${scope.user_id}`,
            new Date().toISOString(),
          );
          continue;
        }
        insertDigestState.run(
          scope.agent_id,
          scope.user_id,
          last.created_at,
          last.id,
          new Date().toISOString(),
        );
      }

      // streams scope/perspective/participants normalization (deterministic and
      // only for rows whose column is still empty; later writes are untouched).
      database.exec(`
        UPDATE hippocampus_streams
        SET origin_scope = CASE
          WHEN (origin_group_session_id IS NOT NULL AND TRIM(origin_group_session_id) <> '')
            OR type = 'group_presence'
            THEN 'group_public'
          ELSE 'private_dyadic'
        END
        WHERE origin_scope IS NULL OR TRIM(origin_scope) = '';

        UPDATE hippocampus_streams
        SET perspective = CASE
          WHEN origin_scope = 'group_public' THEN 'everyone'
          WHEN about IN ('她·感受', '她·在乎', '她·反应', '她·边界') THEN 'self'
          ELSE 'ta'
        END
        WHERE perspective IS NULL OR TRIM(perspective) = '';

        UPDATE hippocampus_streams
        SET participants_json = '[]'
        WHERE participants_json IS NULL OR TRIM(participants_json) = '';
      `);

      // Only provable seed history is backfilled. Portrait history is not
      // recoverable from a single current row and is deliberately left empty.
      database.exec(`
        INSERT OR IGNORE INTO agent_state_changes (
          id, agent_id, user_id, target_kind, target_id, action,
          base_revision, new_revision, before_json, after_json,
          reason, evidence_json, batch_key, source, created_at
        )
        SELECT
          'legacy-seedver-' || v.id,
          v.agent_id,
          v.user_id,
          'seed',
          v.seed_id,
          CASE v.event_type
            WHEN 'manual_create' THEN 'new'
            WHEN 'manual_update' THEN 'manual_edit'
            WHEN 'delete' THEN 'manual_delete'
            ELSE v.event_type
          END,
          MAX(v.version_no - 1, 0),
          v.version_no,
          v.before_json,
          v.after_json,
          COALESCE(v.reason, ''),
          NULL,
          'legacy-seedver:' || v.id,
          CASE
            WHEN v.trigger_source IN ('manual', 'system', 'model') THEN v.trigger_source
            ELSE 'legacy_backfill'
          END,
          v.created_at
        FROM hippocampus_seed_versions v
        WHERE v.seed_id IN (SELECT id FROM hippocampus_seeds);
      `);

      const badSeeds = database
        .prepare("SELECT COUNT(*) AS c FROM hippocampus_seeds WHERE status NOT IN ('active','retired')")
        .get() as { c: number };
      const badStreams = database
        .prepare(
          `SELECT COUNT(*) AS c FROM hippocampus_streams
           WHERE origin_scope IS NULL OR TRIM(origin_scope) = ''
              OR perspective IS NULL OR TRIM(perspective) = ''`,
        )
        .get() as { c: number };
      if (Number(badSeeds.c) > 0) throw new Error("schema_v19_invalid_seed_status");
      if (Number(badStreams.c) > 0) throw new Error("schema_v19_invalid_stream_scope");

      insertTaskEvent.run(
        migrationEventId,
        "schema_migration",
        "global",
        "",
        "succeeded",
        "v19",
        new Date().toISOString(),
      );
    })();
  }
  if (current < 20) {
    // v20: APP relationship continuity tables. Empty at migration time: old
    // desktop "心事线" rows are not copied (that model is retired). Continuity
    // now writes only these tables and is never injected into chat prompts.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS relationship_threads (
          id TEXT PRIMARY KEY,
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          first_message_id TEXT NOT NULL,
          first_at TEXT NOT NULL,
          last_message_id TEXT NOT NULL,
          last_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_relationship_threads_agent_last
          ON relationship_threads (agent_id, user_id, last_at DESC);
        CREATE TABLE IF NOT EXISTS relationship_thread_nodes (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          role TEXT NOT NULL,
          excerpt TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          carry_note TEXT NOT NULL DEFAULT '',
          batch_key TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (thread_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS ix_relationship_thread_nodes_thread
          ON relationship_thread_nodes (thread_id, occurred_at);
      `);
      database.prepare(
        `INSERT INTO background_task_events
          (id, event_type, subject_type, subject_id, status, detail, created_at)
         VALUES (?, 'schema_migration', 'global', '', 'succeeded', 'v20', ?)`,
      ).run(`migration-v20-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, new Date().toISOString());
    })();
  }
  if (current < 21) {
    // v21: chat_usage_state — the anchor's real-usage trigger signal. Empty at
    // migration time: without a recorded row the estimate fallback stays in
    // charge until the next private chat request reports usage.
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS chat_usage_state (
          agent_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          cached_tokens INTEGER NOT NULL DEFAULT 0,
          model TEXT NOT NULL DEFAULT '',
          base_url_hash TEXT NOT NULL DEFAULT '',
          measured_at TEXT NOT NULL,
          PRIMARY KEY (agent_id, user_id)
        );
      `);
      database.prepare(
        `INSERT INTO background_task_events
          (id, event_type, subject_type, subject_id, status, detail, created_at)
         VALUES (?, 'schema_migration', 'global', '', 'succeeded', 'v21', ?)`,
      ).run(`migration-v21-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, new Date().toISOString());
    })();
  }
  if (current < 22) {
    // v22: the APP's formal package no longer exposes or honors a "deep memory"
    // toggle. Drop the retired column; legacy booleans must not survive as a
    // hidden behavior switch.
    dropColumnIfPresent(database, "agent_configs", "deep_memory_enabled");
    database.prepare(
      `INSERT INTO background_task_events
        (id, event_type, subject_type, subject_id, status, detail, created_at)
       VALUES (?, 'schema_migration', 'global', '', 'succeeded', 'v22', ?)`,
    ).run(`migration-v22-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, new Date().toISOString());
  }
  // The v22 drop is unconditional too. A hot reload can set user_version=22
  // before this migration block is loaded, exactly like the seed-column race.
  dropColumnIfPresent(database, "agent_configs", "deep_memory_enabled");
  // Unconditional and idempotent: these columns are what lets the next request
  // replay the previous one byte for byte, which is what the provider's prompt
  // cache keys on. They must exist even on a database that already reached the
  // current schema version before they were introduced.
  addColumnIfMissing(database, "chat_messages", "tool_messages_json", "TEXT");
  addColumnIfMissing(database, "chat_messages", "llm_content", "TEXT");
  addColumnIfMissing(database, "chat_threads", "llm_anchor_message_id", "INTEGER");
  // v18: group-public stream provenance. Additive only; existing streams keep
  // NULL and are therefore still treated as private memory.
  addColumnIfMissing(database, "hippocampus_streams", "origin_group_session_id", "TEXT");
  addColumnIfMissing(database, "hippocampus_streams", "participants_json", "TEXT");
  // v19 seed lifecycle columns are unconditional too: a hot reload can move
  // `user_version` forward before the version-guarded block commits, leaving a
  // v19+ database without the columns the new code assumes.
  addColumnIfMissing(database, "hippocampus_seeds", "revision", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "hippocampus_seeds", "status", "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(database, "hippocampus_seeds", "applicability_json", "TEXT");
  addColumnIfMissing(database, "hippocampus_streams", "origin_theater_id", "TEXT");
  // M3 manage_alarm: APP-compatible appointment time modes. Legacy rows keep
  // NULL and read as the historical exact-time appointments.
  addColumnIfMissing(database, "hippocampus_appointments", "time_mode", "TEXT");
  addColumnIfMissing(database, "hippocampus_appointments", "event_date", "TEXT");
  database.exec(`
    CREATE INDEX IF NOT EXISTS ix_hc_streams_group_origin
       ON hippocampus_streams (origin_group_session_id, agent_id);
    CREATE INDEX IF NOT EXISTS ix_hc_streams_origin_scope
      ON hippocampus_streams (agent_id, user_id, archived, origin_scope, created_at DESC);
    CREATE INDEX IF NOT EXISTS ix_hc_streams_theater_origin
      ON hippocampus_streams (origin_theater_id, agent_id);
    CREATE INDEX IF NOT EXISTS ix_hc_seeds_scope_status
      ON hippocampus_seeds (agent_id, user_id, status, updated_at DESC);
  `);
  if (current < SCHEMA_VERSION) {
    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

function addColumnIfMissing(database: Database.Database, table: string, column: string, ddl: string) {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!rows.some((row) => row.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function dropColumnIfPresent(database: Database.Database, table: string, column: string) {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (rows.some((row) => row.name === column)) {
    database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}