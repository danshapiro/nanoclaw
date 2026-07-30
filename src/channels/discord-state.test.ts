import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import {
  claimDiscordMessage,
  DISCORD_ROUTE_MAX_ATTEMPTS,
  getDiscordMessageRouteStatus,
  isDiscordMessageTerminal,
  markDiscordMessageFailed,
  markDiscordMessageRouted,
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
