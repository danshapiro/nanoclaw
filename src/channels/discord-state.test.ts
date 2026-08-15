import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import {
  advanceDiscordChannelCursor,
  claimDiscordMessage,
  DISCORD_ROUTE_MAX_ATTEMPTS,
  getDiscordChannelCursor,
  getDiscordMessageRouteStatus,
  isDiscordMessageTerminal,
  listRetriableDiscordMessageRoutes,
  markDiscordMessageFailed,
  markDiscordMessageRouted,
  markDiscordMessageSource,
  pruneDiscordMessageRoutes,
} from './discord-state.js';

const META = { guildId: 'g1', authorId: 'u1', source: 'gateway' as const };
const T0 = '2026-07-30T00:00:00.000Z';
const T0_LEASE = '2026-07-30T00:02:00.000Z';
const T1 = '2026-07-30T00:00:01.000Z';
const T1_LEASE = '2026-07-30T00:02:01.000Z';
const AFTER_LEASE = '2026-07-30T00:02:30.000Z';
const AFTER_LEASE_LEASE = '2026-07-30T00:04:30.000Z';

describe('Discord message route claims', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => closeDb());

  it('first claim wins; second claim while the lease is active is refused', () => {
    expect(claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE)).toEqual({ claimed: true, status: 'processing' });
    expect(claimDiscordMessage('c1', 'm1', META, T1, T1_LEASE)).toEqual({ claimed: false, status: 'active-lease' });
  });

  it('routed messages refuse reclaim and are terminal', () => {
    claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE);
    markDiscordMessageRouted('c1', 'm1', T1);
    expect(claimDiscordMessage('c1', 'm1', META, AFTER_LEASE, AFTER_LEASE_LEASE)).toEqual({
      claimed: false,
      status: 'already-routed',
    });
    expect(isDiscordMessageTerminal('c1', 'm1')).toBe(true);
  });

  it('never regresses a routed row to failed (monotonic terminality under overlapping attempts)', () => {
    // Attempt A completes routing; an overlapping attempt B — re-claimed after
    // the lease expired while A's dispatch was still in flight, its tracker
    // entry consumed by A — attempts to mark the row failed. It must no-op.
    claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE);
    markDiscordMessageRouted('c1', 'm1', '2026-07-30T00:00:30.000Z');
    markDiscordMessageFailed('c1', 'm1', '2026-07-30T00:00:31.000Z', 'no dispatch handler accepted the message');
    expect(getDiscordMessageRouteStatus('c1', 'm1')).toBe('routed');
    expect(isDiscordMessageTerminal('c1', 'm1')).toBe(true);
  });

  it('an expired lease reclaims with attempts+1', () => {
    claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE);
    expect(claimDiscordMessage('c1', 'm1', META, AFTER_LEASE, AFTER_LEASE_LEASE)).toEqual({
      claimed: true,
      status: 'processing',
    });
  });

  it('failed messages stay reclaimable until DISCORD_ROUTE_MAX_ATTEMPTS, then become terminal', () => {
    for (let attempt = 1; attempt <= DISCORD_ROUTE_MAX_ATTEMPTS; attempt += 1) {
      const now = `2026-07-30T00:0${attempt}:00.000Z`;
      const lease = `2026-07-30T00:0${attempt}:30.000Z`;
      expect(claimDiscordMessage('c1', 'm-fail', META, now, lease)).toEqual({ claimed: true, status: 'processing' });
      expect(isDiscordMessageTerminal('c1', 'm-fail')).toBe(false);
      markDiscordMessageFailed('c1', 'm-fail', now, `boom ${attempt}`);
    }
    expect(isDiscordMessageTerminal('c1', 'm-fail')).toBe(true);
    expect(claimDiscordMessage('c1', 'm-fail', META, '2026-07-30T00:09:00.000Z', '2026-07-30T00:09:30.000Z')).toEqual({
      claimed: false,
      status: 'abandoned',
    });
  });

  it('a failed row KEEPS its lease: rapid retries are refused as active-lease until expiry', () => {
    expect(claimDiscordMessage('c1', 'm-flap', META, T0, T0_LEASE)).toEqual({ claimed: true, status: 'processing' });
    markDiscordMessageFailed('c1', 'm-flap', T1, 'boom');
    // T1 is inside the T0 lease window: the live forwarder's 250ms/1000ms
    // HTTP retries land here and must NOT burn claim attempts (A16).
    expect(claimDiscordMessage('c1', 'm-flap', META, T1, T1_LEASE)).toEqual({ claimed: false, status: 'active-lease' });
    // After the lease expires (catch-up arrives minutes later) it reclaims.
    expect(claimDiscordMessage('c1', 'm-flap', META, AFTER_LEASE, AFTER_LEASE_LEASE)).toEqual({
      claimed: true,
      status: 'processing',
    });
  });

  it('reports the raw row status for engine verification', () => {
    expect(getDiscordMessageRouteStatus('c1', 'm1')).toBeNull();
    claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE);
    expect(getDiscordMessageRouteStatus('c1', 'm1')).toBe('processing');
    markDiscordMessageRouted('c1', 'm1', T1);
    expect(getDiscordMessageRouteStatus('c1', 'm1')).toBe('routed');
  });

  it('messages in different channels claim independently', () => {
    expect(claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE)).toEqual({ claimed: true, status: 'processing' });
    expect(claimDiscordMessage('c2', 'm1', META, T0, T0_LEASE)).toEqual({ claimed: true, status: 'processing' });
  });
});

describe('Discord channel cursors and route hygiene', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => closeDb());

  it('cursor advance is monotonic under BigInt snowflake compare', () => {
    expect(getDiscordChannelCursor('c1')).toBeNull();
    advanceDiscordChannelCursor('c1', '100', T0);
    expect(getDiscordChannelCursor('c1')).toBe('100');
    advanceDiscordChannelCursor('c1', '99', T1);
    expect(getDiscordChannelCursor('c1')).toBe('100'); // never regresses
    // mixed string lengths: numeric compare, not lexicographic ('1000' > '999')
    advanceDiscordChannelCursor('c1', '1000', T1);
    expect(getDiscordChannelCursor('c1')).toBe('1000');
    advanceDiscordChannelCursor('c1', '999', T1);
    expect(getDiscordChannelCursor('c1')).toBe('1000');
  });

  it('prune removes only old routed rows', () => {
    claimDiscordMessage('c1', 'm-old-routed', META, '2026-06-01T00:00:00.000Z', '2026-06-01T00:02:00.000Z');
    markDiscordMessageRouted('c1', 'm-old-routed', '2026-06-01T00:00:01.000Z');
    claimDiscordMessage('c1', 'm-new-routed', META, '2026-07-29T00:00:00.000Z', '2026-07-29T00:02:00.000Z');
    markDiscordMessageRouted('c1', 'm-new-routed', '2026-07-29T00:00:01.000Z');
    claimDiscordMessage('c1', 'm-old-failed', META, '2026-06-01T00:00:00.000Z', '2026-06-01T00:02:00.000Z');
    markDiscordMessageFailed('c1', 'm-old-failed', '2026-06-01T00:00:01.000Z', 'boom');

    expect(pruneDiscordMessageRoutes('2026-07-01T00:00:00.000Z')).toBe(1);
    expect(isDiscordMessageTerminal('c1', 'm-new-routed')).toBe(true);
    const remaining = getDb()
      .prepare(`SELECT message_id FROM discord_message_routes ORDER BY message_id`)
      .all() as Array<{ message_id: string }>;
    expect(remaining.map((r) => r.message_id)).toEqual(['m-new-routed', 'm-old-failed']);
  });

  it('marks route source for catch-up attribution', () => {
    claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE);
    markDiscordMessageSource('c1', 'm1', 'catchup');
    const row = getDb()
      .prepare(`SELECT source FROM discord_message_routes WHERE channel_id = 'c1' AND message_id = 'm1'`)
      .get() as { source: string };
    expect(row.source).toBe('catchup');
  });

  it('lists retriable failed rows and expired-lease orphans for the sweep, oldest first', () => {
    // Retriable failure (markDiscordMessageFailed KEEPS the lease; expired by query time).
    claimDiscordMessage('c1', 'm-failed', META, T0, T0_LEASE);
    markDiscordMessageFailed('c1', 'm-failed', T1, 'boom');
    // Expired-lease 'processing' orphan (crash between claim and mark).
    claimDiscordMessage('c1', 'm-orphan', META, T1, T1_LEASE);
    // Active lease — still owned by a live delivery; not listed.
    claimDiscordMessage('c1', 'm-active', META, T0, '2027-01-01T00:00:00.000Z');
    // Terminal rows are never listed.
    claimDiscordMessage('c1', 'm-routed', META, T0, T0_LEASE);
    markDiscordMessageRouted('c1', 'm-routed', T1);
    for (let attempt = 1; attempt <= DISCORD_ROUTE_MAX_ATTEMPTS; attempt += 1) {
      claimDiscordMessage(
        'c1',
        'm-abandoned',
        META,
        `2026-07-30T00:0${attempt}:00.000Z`,
        `2026-07-30T00:0${attempt}:30.000Z`,
      );
      markDiscordMessageFailed('c1', 'm-abandoned', `2026-07-30T00:0${attempt}:01.000Z`, 'poison');
    }
    const rows = listRetriableDiscordMessageRoutes('2026-07-30T01:00:00.000Z', '2026-01-01T00:00:00.000Z', 10);
    expect(rows.map((r) => r.message_id)).toEqual(['m-failed', 'm-orphan']);
    expect(
      listRetriableDiscordMessageRoutes('2026-07-30T01:00:00.000Z', '2026-01-01T00:00:00.000Z', 1).map(
        (r) => r.message_id,
      ),
    ).toEqual(['m-failed']);
  });

  it('does not list a failed row while its lease is still unexpired (live retry window)', () => {
    claimDiscordMessage('c1', 'm-fresh-fail', META, T0, '2027-01-01T00:00:00.000Z');
    markDiscordMessageFailed('c1', 'm-fresh-fail', T1, 'boom');
    expect(listRetriableDiscordMessageRoutes(AFTER_LEASE, '2026-01-01T00:00:00.000Z', 10)).toEqual([]);
  });

  it('excludes rows older than the horizon from the sweep budget (no starvation)', () => {
    // Aged row (first_seen before the horizon): must not occupy a LIMIT slot.
    claimDiscordMessage('c1', 'm-aged', META, '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z');
    markDiscordMessageFailed('c1', 'm-aged', '2026-01-01T00:00:01.000Z', 'boom');
    // Fresh retriable row inside the horizon.
    claimDiscordMessage('c1', 'm-fresh', META, T0, T0_LEASE);
    markDiscordMessageFailed('c1', 'm-fresh', T1, 'boom');
    // With LIMIT 1 and oldest-first ordering, an out-of-horizon row would
    // otherwise permanently shadow every newer retriable row (starvation).
    expect(
      listRetriableDiscordMessageRoutes('2026-07-30T01:00:00.000Z', '2026-07-27T01:00:00.000Z', 1).map(
        (r) => r.message_id,
      ),
    ).toEqual(['m-fresh']);
  });
});
