/**
 * Reference copy of the current v2 schema.
 * Read this to understand the DB structure.
 * Actual creation is done by migrations — do not use this at runtime.
 */

export const SCHEMA = `
-- Agent workspaces: folder, skills, CLAUDE.md.
-- All workspaces are equal; privilege lives on users, not groups.
-- Container config (mcpServers, packages, imageTag, additionalMounts) lives
-- in groups/<folder>/container.json on disk, not in the DB.
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,
  created_at       TEXT NOT NULL
);

-- Platform groups/channels. unknown_sender_policy governs what happens
-- when a sender we've never seen before posts in this chat.
-- The column DEFAULT is "strict" (inherited from migration 001), but it
-- only matters if something inserts without specifying the field, which no
-- current callsite does. Router auto-create hardcodes "request_approval"
-- (see src/router.ts:151); setup scripts pick per context.
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
                        -- 'strict' | 'request_approval' | 'public'
  created_at            TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);

-- Which agent groups handle which messaging groups.
-- engage_mode / engage_pattern / sender_scope / ignored_message_policy are
-- the four orthogonal axes that together replace v1's opaque trigger_rules
-- JSON + response_scope enum. See docs/v1-vs-v2/ACTION-ITEMS.md item 1.
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'mention',
                         -- 'pattern' | 'mention' | 'mention-sticky'
  engage_pattern         TEXT,   -- regex; required when engage_mode='pattern';
                                 -- '.' means "match every message" (the "always" flavor)
  sender_scope           TEXT NOT NULL DEFAULT 'all',    -- 'all' | 'known'
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',   -- 'drop' | 'accumulate'
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);

-- Users are messaging-platform identifiers, namespaced: "phone:+1555...",
-- "tg:123", "discord:456", "email:a@x.com". A single human can own multiple
-- user rows if they have identifiers on unrelated channels (no linking yet).
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- Role grants on users. Privilege is user-level, not group-level.
--   role ∈ {owner, admin}
--   owner: always global (agent_group_id IS NULL)
--   admin: agent_group_id NULL = global, else scoped to that agent group
-- Invariant: admin @ A implies membership in A (no row needed).
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);

-- "Known" membership in an agent group. Required for an unprivileged user
-- to interact with a workspace. Admin @ A is implicitly a member of A.
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);

-- Cached mapping from (user, channel) to the DM messaging group. Lets the
-- host initiate cold DMs (pairing, approvals) without reprobing the
-- platform API on every send. Populated lazily by ensureUserDm().
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);

-- Sessions: one folder = one session = one container when running
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup ON sessions(messaging_group_id, thread_id);

-- Durable scheduler ledger. These tables intentionally do not depend on
-- foreign keys to central tables so task identity survives route/session reset
-- edge cases and missing legacy rows can still be recovered.
CREATE TABLE scheduled_tasks (
  series_id             TEXT NOT NULL,
  agent_group_id        TEXT NOT NULL,
  messaging_group_id    TEXT,
  thread_id             TEXT,
  platform_id           TEXT,
  channel_type          TEXT,
  is_group              INTEGER,
  status                TEXT NOT NULL,
  process_after         TEXT,
  recurrence            TEXT,
  content               TEXT NOT NULL,
  generation            INTEGER NOT NULL DEFAULT 1,
  projected_session_id  TEXT,
  projected_message_id  TEXT,
  created_by_session_id TEXT,
  updated_by_session_id TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  completed_at          TEXT,
  last_error            TEXT,
  PRIMARY KEY (agent_group_id, series_id),
  CHECK (status IN ('pending', 'paused', 'completed', 'cancelled', 'failed')),
  CHECK (is_group IS NULL OR is_group IN (0, 1))
);
CREATE INDEX idx_scheduled_tasks_live_route
  ON scheduled_tasks(agent_group_id, messaging_group_id, thread_id, status, process_after);
CREATE INDEX idx_scheduled_tasks_projection
  ON scheduled_tasks(projected_session_id, projected_message_id);

CREATE TABLE scheduled_task_events (
  id              TEXT PRIMARY KEY,
  agent_group_id  TEXT NOT NULL,
  series_id       TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  session_id      TEXT,
  message_id      TEXT,
  created_at      TEXT NOT NULL,
  details_json    TEXT NOT NULL
);
CREATE INDEX idx_scheduled_task_events_series
  ON scheduled_task_events(agent_group_id, series_id, created_at);

CREATE TABLE scheduler_session_supersessions (
  old_session_id      TEXT PRIMARY KEY,
  new_session_id      TEXT,
  agent_group_id      TEXT NOT NULL,
  messaging_group_id  TEXT,
  thread_id           TEXT,
  session_mode        TEXT NOT NULL,
  response_channel_type TEXT,
  response_platform_id TEXT,
  response_thread_id   TEXT,
  phase               TEXT NOT NULL,
  command             TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  finished_at         TEXT,
  error_json          TEXT,
  CHECK (phase IN (
      'started',
      'old-resetting',
      'old-stopped',
      'actions-drained',
      'old-synced',
      'fresh-created',
      'fresh-projecting',
      'fresh-projected',
      'old-archived',
      'fresh-activated',
      'old-outbound-suppressed',
      'response-delivered',
      'failed'
    ))
);
CREATE INDEX idx_scheduler_supersessions_new_session
  ON scheduler_session_supersessions(new_session_id);

CREATE TABLE scheduler_drained_actions (
  old_session_id  TEXT NOT NULL,
  message_out_id  TEXT NOT NULL,
  action          TEXT NOT NULL,
  status          TEXT NOT NULL,
  intent_at       TEXT NOT NULL,
  applied_at      TEXT,
  details_json    TEXT NOT NULL,
  CHECK (status IN ('intent', 'applied')),
  PRIMARY KEY (old_session_id, message_out_id)
);

CREATE TABLE scheduler_incidents (
  id                  TEXT PRIMARY KEY,
  dedupe_key          TEXT NOT NULL UNIQUE,
  severity            TEXT NOT NULL,
  status              TEXT NOT NULL,
  agent_group_id      TEXT,
  series_id           TEXT,
  session_id          TEXT,
  messaging_group_id  TEXT,
  channel_type        TEXT,
  platform_id         TEXT,
  thread_id           TEXT,
  message             TEXT NOT NULL,
  details_json        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  next_attempt_at     TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_attempt_at     TEXT,
  last_error          TEXT,
  reported_at         TEXT,
  CHECK (severity IN ('info', 'warn', 'error')),
  CHECK (status IN ('pending', 'reported', 'unroutable'))
);
CREATE INDEX idx_scheduler_incidents_pending
  ON scheduler_incidents(status, next_attempt_at, created_at);

CREATE TABLE runtime_locks (
  name         TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  owner_token  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  renewed_at   TEXT NOT NULL
);

-- Pending interactive questions
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Pending approvals for unknown senders (unknown_sender_policy='request_approval').
-- In-flight dedup via UNIQUE(messaging_group_id, sender_identity): a second
-- message from the same unknown sender while a card is pending is silently
-- dropped instead of spamming the admin.
CREATE TABLE pending_sender_approvals (
  id                 TEXT PRIMARY KEY,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity    TEXT NOT NULL,    -- namespaced user id (channel_type:handle)
  sender_name        TEXT,
  original_message   TEXT NOT NULL,    -- JSON of the original InboundEvent
  approver_user_id   TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  UNIQUE(messaging_group_id, sender_identity)
);
`;

/**
 * Session DB schemas — split into two files so each has exactly one writer.
 * This eliminates SQLite write contention across the host-container mount boundary.
 *
 *   inbound.db  — host writes, container reads (read-only mount or open read-only)
 *   outbound.db — container writes, host reads (read-only open)
 */

/** Host-owned: inbound messages + delivery tracking + destination map. */
export const INBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',
  process_after  TEXT,
  recurrence     TEXT,
  series_id      TEXT,
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1,
                 -- 0 = accumulated context (don't wake), 1 = wake agent
  platform_id    TEXT,
  platform_message_id TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  -- Host-stamped route identity. Nullable for legacy/scheduling rows; a null
  -- value is never collapsible onto another route (fail-safe), so the only
  -- failure mode of a missing value is a missed merge, never a cross-route leak.
  messaging_group_id TEXT,
  is_group       INTEGER,
  -- Host-authenticated correlation. These values are written only by the host
  -- and are also mirrored into a separately-mounted read-only correlation
  -- directory for tools that cannot safely trust the agent-writable workspace.
  host_input_id  TEXT,
  host_route_key TEXT,
  host_received_at TEXT,
  content        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);

-- Host tracks delivery outcomes for messages_out IDs.
-- Avoids writing to outbound.db (container-owned).
CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);

-- Destination map for this session's agent.
-- Host overwrites on every container wake AND on demand (rewires, new child
-- agents, etc.). Container queries this live on every lookup, so changes
-- take effect mid-session without requiring a container restart.
CREATE TABLE IF NOT EXISTS destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,   -- 'channel' | 'agent' | 'blocked_channel'
  channel_type    TEXT,            -- for type='channel'
  platform_id     TEXT,            -- for type='channel'
  agent_group_id  TEXT             -- for type='agent'
);

-- Default reply routing for this session. Single-row table (id=1).
-- Host overwrites on every container wake from the session's messaging_group
-- and thread_id. Container reads it in send_message / ask_user_question to
-- default the channel/thread of outbound messages when the agent doesn't
-- specify an explicit destination.
CREATE TABLE IF NOT EXISTS session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT,
  -- Host-stamped route identity for the single normalized route active per
  -- wake (derived from the session's messaging_groups row).
  messaging_group_id TEXT,
  is_group     INTEGER
);
`;

/** Container-owned: outbound messages + processing acknowledgments. */
export const OUTBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  in_reply_to    TEXT,
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  -- Route metadata so recovery can harvest only the active conversation's
  -- progress/relay rows written during the accepted-input window.
  input_id       TEXT,
  route_key      TEXT,
  messaging_group_id TEXT,
  is_group       INTEGER,
  content        TEXT NOT NULL
);

-- Container tracks processing status here instead of updating messages_in.
-- Host reads this to know which messages have been processed.
-- On container startup, stale 'processing' entries are cleared (crash recovery).
-- status ∈ {processing, completed, failed, recovery}. A 'failed' ack is only a
-- valid host-sync completion when notice_message_out_id points at a written
-- user-visible terminal notice row; otherwise it is treated as invalid.
CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL,
  notice_message_out_id TEXT
);

-- Validated, imported side effects (idempotency key = id = the proxy audit_id
-- for GWS, the stable artifact/run key for summarize-dnd). Only records that
-- pass validation are written here; agent-writable staged JSONL is never
-- authoritative. kind is the durable recovery side-effect kind.
CREATE TABLE IF NOT EXISTS side_effect_ledger (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  kind            TEXT NOT NULL,
  operation       TEXT,
  payload_schema_version INTEGER NOT NULL DEFAULT 1,
  profile         TEXT,
  account_label   TEXT,
  account_email   TEXT,
  input_id        TEXT,
  route_key       TEXT,
  signed_payload  TEXT,
  signature       TEXT,
  evidence_json   TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  replay_policy   TEXT,
  occurred_at     TEXT,
  imported_at     TEXT NOT NULL
);

-- Persistent key/value state owned by the container. Used (among other things)
-- to store the SDK session ID so the agent's conversation resumes across
-- container restarts. Cleared by /clear.
CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Current tool-in-flight state. Single-row table (id=1). Container writes on
-- PreToolUse and clears on PostToolUse / PostToolUseFailure. Host reads in the
-- sweep to extend the stuck-tolerance window when Bash is running with a
-- declared timeout > 60s (long-running scripts shouldn't be flagged as stuck).
CREATE TABLE IF NOT EXISTS container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);
`;
