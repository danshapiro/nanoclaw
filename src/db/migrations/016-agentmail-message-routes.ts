import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: '016-agentmail-message-routes',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agentmail_message_routes (
        inbox_id            TEXT NOT NULL,
        message_id          TEXT NOT NULL,
        event_id            TEXT,
        agentmail_thread_id TEXT,
        nano_thread_id      TEXT,
        messaging_group_id  TEXT,
        sender_email        TEXT,
        subject             TEXT,
        received_at         TEXT,
        first_seen_at       TEXT NOT NULL,
        claimed_at          TEXT,
        lease_expires_at    TEXT,
        routed_at           TEXT,
        failed_at           TEXT,
        attempts            INTEGER NOT NULL DEFAULT 0,
        status              TEXT NOT NULL DEFAULT 'processing',
        last_error          TEXT,
        PRIMARY KEY (inbox_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agentmail_message_routes_thread
        ON agentmail_message_routes(inbox_id, nano_thread_id, routed_at);
      CREATE INDEX IF NOT EXISTS idx_agentmail_message_routes_status
        ON agentmail_message_routes(status, lease_expires_at);
    `);
  },
};
