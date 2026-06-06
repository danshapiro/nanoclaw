import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'scheduler-ledger',
  up(db: Database.Database) {
    db.exec(`
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
    `);
  },
};
