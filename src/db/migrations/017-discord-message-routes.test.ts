import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../connection.js';
import { migration017 } from './017-discord-message-routes.js';
import { runMigrations } from './index.js';

function tableColumns(table: string): Set<string> {
  return new Set(
    (getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

describe('migration 017: discord message routes and cursors', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => closeDb());

  it('creates discord_message_routes with the claim/lease/status shape', () => {
    expect(tableColumns('discord_message_routes')).toEqual(
      new Set([
        'channel_id',
        'message_id',
        'guild_id',
        'author_id',
        'first_seen_at',
        'claimed_at',
        'lease_expires_at',
        'routed_at',
        'failed_at',
        'attempts',
        'status',
        'source',
        'last_error',
      ]),
    );
  });

  it('creates discord_channel_cursors keyed by channel', () => {
    expect(tableColumns('discord_channel_cursors')).toEqual(new Set(['channel_id', 'last_message_id', 'updated_at']));
  });

  it('enforces one route row per (channel_id, message_id)', () => {
    const insert = getDb().prepare(
      `INSERT INTO discord_message_routes (channel_id, message_id, first_seen_at) VALUES (?, ?, ?)`,
    );
    insert.run('c1', 'm1', '2026-07-30T00:00:00.000Z');
    expect(() => insert.run('c1', 'm1', '2026-07-30T00:00:01.000Z')).toThrow();
  });

  it('is idempotent when re-applied (IF NOT EXISTS)', () => {
    // runMigrations already dedupes by name; the SQL itself must also be safe.
    expect(() => migration017.up(getDb())).not.toThrow();
  });
});
