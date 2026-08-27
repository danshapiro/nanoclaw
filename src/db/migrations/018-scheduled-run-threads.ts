import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: '018-scheduled-run-threads',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_run_threads (
        session_id        TEXT NOT NULL,
        task_message_id   TEXT NOT NULL,
        channel_type      TEXT NOT NULL,
        platform_id       TEXT NOT NULL,
        anchor_message_id TEXT NOT NULL,
        thread_id         TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        PRIMARY KEY (session_id, task_message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_run_threads_recent
        ON scheduled_run_threads(session_id, created_at);
    `);
  },
};
