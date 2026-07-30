import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: '017-discord-message-routes',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS discord_message_routes (
        channel_id       TEXT NOT NULL,
        message_id       TEXT NOT NULL,
        guild_id         TEXT,
        author_id        TEXT,
        first_seen_at    TEXT NOT NULL,
        claimed_at       TEXT,
        lease_expires_at TEXT,
        routed_at        TEXT,
        failed_at        TEXT,
        attempts         INTEGER NOT NULL DEFAULT 0,
        status           TEXT NOT NULL DEFAULT 'processing',
        source           TEXT,
        last_error       TEXT,
        PRIMARY KEY (channel_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_discord_message_routes_status
        ON discord_message_routes(status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_discord_message_routes_seen
        ON discord_message_routes(first_seen_at);

      CREATE TABLE IF NOT EXISTS discord_channel_cursors (
        channel_id      TEXT PRIMARY KEY,
        last_message_id TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
    `);
  },
};
