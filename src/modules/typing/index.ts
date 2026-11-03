/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval. Discord uses current selected work from the runner;
 * other channels use the heartbeat after an initial grace period.
 *
 * Other channels pause after delivery. Discord continues until selected
 * work resolves, even when a message was delivered during the request.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { heartbeatPath } from '../../session-manager.js';
import { log } from '../../log.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Heartbeats land
 * every few hundred ms during active work, so 6s is well above
 * the working floor and small enough to stop typing quickly when
 * the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;

interface TypingAdapter {
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();
const discordRefreshers = new Map<string, Map<string, TypingTarget & { active: boolean; expiresAt: number }>>();
const containerOwners = new Map<string, string>();
const typingFailures = new Set<string>();
const invalidSnapshots = new Set<string>();

function discordKey(platformId: string, threadId: string | null): string {
  return JSON.stringify([platformId, threadId]);
}

function startDiscordRefresh(
  sessionId: string,
  agentGroupId: string,
  platformId: string,
  threadId: string | null,
  active: boolean,
): void {
  let targets = discordRefreshers.get(sessionId);
  if (!targets) {
    targets = new Map();
    discordRefreshers.set(sessionId, targets);
  }
  const key = discordKey(platformId, threadId);
  const existing = targets.get(key);
  if (existing) {
    existing.active ||= active;
    if (!active) {
      existing.startedAt = Date.now();
      void triggerTyping('discord', platformId, threadId, sessionId);
    }
    return;
  }
  void triggerTyping('discord', platformId, threadId, sessionId);
  const interval = setInterval(() => {
    const entry = discordRefreshers.get(sessionId)?.get(key);
    if (!entry) return;
    if (
      (entry.active && Date.now() < entry.expiresAt) ||
      (!entry.active && Date.now() - entry.startedAt < TYPING_GRACE_MS)
    ) {
      void triggerTyping('discord', platformId, threadId, sessionId);
    } else {
      clearInterval(entry.interval);
      discordRefreshers.get(sessionId)?.delete(key);
      if (entry.active) log.warn('Discord typing activity expired', { sessionId, agentGroupId, platformId, threadId });
      if (discordRefreshers.get(sessionId)?.size === 0) discordRefreshers.delete(sessionId);
    }
  }, TYPING_REFRESH_MS);
  interval.unref();
  targets.set(key, {
    agentGroupId,
    channelType: 'discord',
    platformId,
    threadId,
    interval,
    startedAt: Date.now(),
    pausedUntil: 0,
    active,
    expiresAt: Number.POSITIVE_INFINITY,
  });
}

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping`. Called once by `src/delivery.ts` inside
 * `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

export function setTypingContainerOwner(sessionId: string, leaseId: string): void {
  containerOwners.set(sessionId, leaseId);
}

export function applyStoredDiscordTypingActivity(sessionId: string, agentGroupId: string, value: string): void {
  try {
    const snapshot = JSON.parse(value) as { leaseId?: unknown; updatedAt?: unknown; destinations?: unknown };
    if (!containerOwners.has(sessionId) || snapshot.leaseId !== containerOwners.get(sessionId)) return;
    if (
      typeof snapshot.updatedAt !== 'number' ||
      !Number.isFinite(snapshot.updatedAt) ||
      snapshot.updatedAt > Date.now() + 5000
    )
      return;
    if (
      !Array.isArray(snapshot.destinations) ||
      !snapshot.destinations.every((target: unknown) => {
        if (!target || typeof target !== 'object') return false;
        const row = target as { platformId?: unknown; threadId?: unknown };
        return (
          typeof row.platformId === 'string' &&
          row.platformId.length > 0 &&
          (typeof row.threadId === 'string' || row.threadId === null)
        );
      })
    )
      return;
    const expiry = snapshot.updatedAt + 15_000;
    applyDiscordTypingActivity(sessionId, agentGroupId, expiry > Date.now() ? snapshot.destinations : [], expiry);
    invalidSnapshots.delete(sessionId);
  } catch {
    if (!invalidSnapshots.has(sessionId)) log.warn('Invalid Discord typing activity', { sessionId, agentGroupId });
    invalidSnapshots.add(sessionId);
  }
}

export function applyDiscordTypingActivity(
  sessionId: string,
  agentGroupId: string,
  destinations: Array<{ platformId: string; threadId: string | null }>,
  expiresAt = Number.POSITIVE_INFINITY,
): void {
  const keys = new Set(destinations.map(({ platformId, threadId }) => discordKey(platformId, threadId)));
  for (const [key, entry] of discordRefreshers.get(sessionId) ?? []) {
    if (entry.active && !keys.has(key)) {
      clearInterval(entry.interval);
      discordRefreshers.get(sessionId)?.delete(key);
      log.info('Discord typing activity ended', {
        sessionId,
        agentGroupId,
        platformId: entry.platformId,
        threadId: entry.threadId,
      });
    }
  }
  for (const { platformId, threadId } of destinations) {
    const wasActive = discordRefreshers.get(sessionId)?.get(discordKey(platformId, threadId))?.active;
    startDiscordRefresh(sessionId, agentGroupId, platformId, threadId, true);
    const entry = discordRefreshers.get(sessionId)?.get(discordKey(platformId, threadId));
    if (entry) entry.expiresAt = expiresAt;
    if (!wasActive) log.info('Discord typing activity started', { sessionId, agentGroupId, platformId, threadId });
  }
  if (discordRefreshers.get(sessionId)?.size === 0) discordRefreshers.delete(sessionId);
}

async function triggerTyping(
  channelType: string,
  platformId: string,
  threadId: string | null,
  sessionId: string,
): Promise<void> {
  const key = JSON.stringify([sessionId, channelType, platformId, threadId]);
  try {
    await adapter?.setTyping?.(channelType, platformId, threadId);
    typingFailures.delete(key);
  } catch (err) {
    if (!typingFailures.has(key))
      log.warn('Typing indicator failed', { sessionId, channelType, platformId, threadId, err });
    typingFailures.add(key);
  }
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
): void {
  if (channelType === 'discord') {
    startDiscordRefresh(sessionId, agentGroupId, platformId, threadId, false);
    return;
  }
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    triggerTyping(channelType, platformId, threadId, sessionId).catch(() => {});
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    return;
  }

  // Immediate tick + periodic refresh.
  triggerTyping(channelType, platformId, threadId, sessionId).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > Date.now()) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      triggerTyping(entry.channelType, entry.platformId, entry.threadId, sessionId).catch(() => {});
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    clearInterval(entry.interval);
    typingRefreshers.delete(sessionId);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    interval,
    startedAt,
    pausedUntil: 0,
  });
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after
 * a user-facing message is delivered so the client-side indicator
 * has a chance to visually clear before the agent's next SDK event
 * pushes it back on. No-op if no refresh is active for this session.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  for (const [key, target] of discordRefreshers.get(sessionId) ?? []) {
    if (!target.active) {
      clearInterval(target.interval);
      discordRefreshers.get(sessionId)?.delete(key);
    }
  }
  if (discordRefreshers.get(sessionId)?.size === 0) discordRefreshers.delete(sessionId);
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

export function stopTypingRefresh(sessionId: string): void {
  containerOwners.delete(sessionId);
  invalidSnapshots.delete(sessionId);
  for (const key of typingFailures) if ((JSON.parse(key) as unknown[])[0] === sessionId) typingFailures.delete(key);
  for (const entry of discordRefreshers.get(sessionId)?.values() ?? []) clearInterval(entry.interval);
  discordRefreshers.delete(sessionId);
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
}

export function stopTypingGrace(
  sessionId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
): void {
  if (channelType !== 'discord') {
    stopTypingRefresh(sessionId);
    return;
  }
  const key = discordKey(platformId, threadId);
  const entry = discordRefreshers.get(sessionId)?.get(key);
  if (entry && !entry.active) {
    clearInterval(entry.interval);
    discordRefreshers.get(sessionId)?.delete(key);
    if (discordRefreshers.get(sessionId)?.size === 0) discordRefreshers.delete(sessionId);
  }
}
