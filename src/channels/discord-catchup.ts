/**
 * Discord catch-up engine: recovers messages that arrived while the gateway
 * was disconnected (fresh IDENTIFY gets no replay) or the service was down.
 * Mirrors the AgentMail catch-up pattern (agentmail.ts) adapted to Discord's
 * snowflake-cursor REST pagination. See docs/plans/2026-07-30-discord-catchup.md.
 */

import { log } from '../log.js';
import { forwardDiscordGatewayEventWithRetry } from './discord.js';
import {
  advanceDiscordChannelCursor,
  claimDiscordMessage,
  DISCORD_ROUTE_MAX_ATTEMPTS,
  getDiscordChannelCursor,
  getDiscordMessageRouteAttempts,
  getDiscordMessageRouteStatus,
  isDiscordMessageTerminal,
  listRetriableDiscordMessageRoutes,
  markDiscordMessageFailed,
  markDiscordMessageSource,
  pruneDiscordMessageRoutes,
} from './discord-state.js';

export const DEFAULT_DISCORD_CATCHUP_INTERVAL_MS = 300000; // 5 min periodic safety net
export const DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS = 15000; // coalesce READY bursts
export const DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES = 200; // per channel per run (2 REST pages)
export const DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS = 259200000; // 72 h backfill horizon
export const DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS = 120000; // choke-point claim lease
export const DEFAULT_DISCORD_CATCHUP_MAX_THREADS = 25; // active-thread backfill bound per run

const DISCORD_EPOCH_MS = 1420070400000;

export type DiscordCatchupConfig = {
  disabled: boolean;
  intervalMs: number;
  readyDebounceMs: number;
  maxMessages: number;
  maxAgeMs: number;
  routeLeaseMs: number;
  maxThreads: number;
};

function integerEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: number, min: number): number {
  const raw = env[key]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${key} must be an integer >= ${min}`);
  }
  return parsed;
}

export function discordCatchupConfigFromEnv(env: NodeJS.ProcessEnv): DiscordCatchupConfig {
  return {
    disabled: env.DISCORD_CATCHUP_DISABLED?.trim() === '1',
    intervalMs: integerEnv(env, 'DISCORD_CATCHUP_INTERVAL_MS', DEFAULT_DISCORD_CATCHUP_INTERVAL_MS, 0),
    readyDebounceMs: integerEnv(env, 'DISCORD_CATCHUP_READY_DEBOUNCE_MS', DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS, 1),
    maxMessages: integerEnv(env, 'DISCORD_CATCHUP_MAX_MESSAGES', DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES, 1),
    maxAgeMs: integerEnv(env, 'DISCORD_CATCHUP_MAX_AGE_MS', DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS, 1),
    routeLeaseMs: integerEnv(env, 'DISCORD_CATCHUP_ROUTE_LEASE_MS', DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS, 1),
    maxThreads: integerEnv(env, 'DISCORD_CATCHUP_MAX_THREADS', DEFAULT_DISCORD_CATCHUP_MAX_THREADS, 0),
  };
}

export function snowflakeToUnixMs(snowflake: string): number {
  return Number((BigInt(snowflake) >> 22n) + BigInt(DISCORD_EPOCH_MS));
}

export function unixMsToSnowflake(unixMs: number): string {
  const sinceEpoch = Math.max(0, unixMs - DISCORD_EPOCH_MS);
  return (BigInt(sinceEpoch) << 22n).toString();
}

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const DISCORD_API_BASE = 'https://discord.com/api/v10';
/** Whole-run wall-clock cap; a pathological backlog can't starve the process. */
export const DISCORD_CATCHUP_RUN_WALL_CLOCK_MS = 60000;
/** Sequential REST pacing — hard floor ~2 req/s. */
export const DISCORD_CATCHUP_REST_PACING_MS = 500;
/** Routed route rows older than this are pruned on periodic runs. */
export const DISCORD_ROUTE_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Message types routed by catch-up: 0 = DEFAULT, 19 = REPLY. */
const ROUTABLE_MESSAGE_TYPES = new Set([0, 19]);

export type DiscordCatchupReason = 'ready' | 'startup' | 'periodic';

export type DiscordCatchupRunSummary = {
  reason: DiscordCatchupReason;
  channels: number;
  threads: number;
  fetched: number;
  routed: number;
  skippedTerminal: number;
  skippedOwnBot: number;
  failed: number;
  durationMs: number;
};

export type DiscordCatchupDeps = {
  botToken: string;
  botUserId: string;
  webhookUrl: string;
  monitoredChannelIds: () => Set<string>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type DiscordCatchup = {
  runOnce(reason: DiscordCatchupReason): Promise<DiscordCatchupRunSummary | null>;
  onGatewayEvent(type: string): void;
  start(): void;
  stop(): void;
};

type DiscordRestMessage = Record<string, unknown> & { id: string; type: number };
type TargetInfo = { id: string; guildId: string; kind: 'channel' | 'thread' };

export function createDiscordCatchup(deps: DiscordCatchupDeps): DiscordCatchup {
  const env = deps.env ?? process.env;
  const config = discordCatchupConfigFromEnv(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const guildCache = new Map<string, string | null>();
  let running: Promise<DiscordCatchupRunSummary | null> | null = null;
  let readyDebounceTimer: NodeJS.Timeout | null = null;
  let periodicTimer: NodeJS.Timeout | null = null;

  const nowIso = (): string => new Date(now()).toISOString();

  async function discordGetJson<T>(path: string): Promise<T | null> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bot ${deps.botToken}` },
      });
      await sleep(DISCORD_CATCHUP_REST_PACING_MS);
      if (response.status === 429) {
        const retryAfterS = Number(response.headers.get('Retry-After') ?? '1');
        await sleep(Math.max(0, Math.round(retryAfterS * 1000)));
        continue;
      }
      if (!response.ok) {
        log.warn('Discord catch-up REST request failed', { path, status: response.status });
        return null;
      }
      return (await response.json()) as T;
    }
    log.warn('Discord catch-up REST request rate-limited after retries', { path });
    return null;
  }

  async function resolveChannelTarget(channelId: string): Promise<TargetInfo | null> {
    let channelInfo: { guild_id?: string; last_message_id?: string | null } | null = null;
    let guildId = guildCache.get(channelId);
    if (guildId === undefined) {
      channelInfo = await discordGetJson(`/channels/${encodeURIComponent(channelId)}`);
      if (!channelInfo) return null;
      guildId =
        typeof channelInfo.guild_id === 'string' && channelInfo.guild_id.length > 0 ? channelInfo.guild_id : null;
      guildCache.set(channelId, guildId);
    }
    if (guildId === null) {
      // DMs are out of scope v1 (Yente's production intake is guild-channel based).
      log.debug('Discord catch-up skipping non-guild channel', { channelId });
      return null;
    }
    if (!getDiscordChannelCursor(channelId)) {
      // First rollout / newly monitored: initialize at the channel head and
      // route NOTHING — no history replay on first deploy (spec §6.4a).
      if (!channelInfo) channelInfo = await discordGetJson(`/channels/${encodeURIComponent(channelId)}`);
      const head = channelInfo?.last_message_id ?? unixMsToSnowflake(now());
      advanceDiscordChannelCursor(channelId, head, nowIso());
      log.info('Discord catch-up cursor initialized at channel head', { channelId, cursor: head });
      return null;
    }
    return { id: channelId, guildId, kind: 'channel' };
  }

  async function resolveThreadTargets(guildId: string, monitored: Set<string>): Promise<TargetInfo[]> {
    const body = await discordGetJson<{
      threads?: Array<{ id: string; parent_id?: string; last_message_id?: string | null }>;
    }>(`/guilds/${encodeURIComponent(guildId)}/threads/active`);
    if (!body?.threads) return [];
    const relevant = body.threads.filter((thread) => thread.parent_id && monitored.has(thread.parent_id));
    relevant.sort((a, b) => compareSnowflakes(b.last_message_id ?? b.id, a.last_message_id ?? a.id));
    const targets: TargetInfo[] = [];
    for (const thread of relevant.slice(0, config.maxThreads)) {
      if (!getDiscordChannelCursor(thread.id)) {
        // Same no-replay rule as channels: first sight initializes at head.
        advanceDiscordChannelCursor(thread.id, thread.last_message_id ?? thread.id, nowIso());
        continue;
      }
      targets.push({ id: thread.id, guildId, kind: 'thread' });
    }
    return targets;
  }

  async function catchUpTarget(target: TargetInfo, summary: DiscordCatchupRunSummary, deadline: number): Promise<void> {
    let cursor = getDiscordChannelCursor(target.id);
    if (!cursor) return;
    const minSnowflake = unixMsToSnowflake(now() - config.maxAgeMs);
    if (compareSnowflakes(cursor, minSnowflake) < 0) cursor = minSnowflake; // stale-cursor clamp
    let processed = 0;
    while (processed < config.maxMessages && now() <= deadline) {
      const page = await discordGetJson<DiscordRestMessage[]>(
        `/channels/${encodeURIComponent(target.id)}/messages?after=${encodeURIComponent(cursor)}&limit=100`,
      );
      if (!page || page.length === 0) return;
      page.sort((a, b) => compareSnowflakes(a.id, b.id)); // never trust API ordering
      for (const message of page) {
        if (processed >= config.maxMessages || now() > deadline) return;
        processed += 1;
        summary.fetched += 1;
        const advance = (): void => {
          advanceDiscordChannelCursor(target.id, message.id, nowIso());
          cursor = message.id;
        };
        if (!ROUTABLE_MESSAGE_TYPES.has(message.type)) {
          advance();
          continue;
        }
        if ((message.author as { id?: string } | undefined)?.id === deps.botUserId) {
          // The wrapper bypasses the bot's own messages entirely (never
          // dispatched, no ledger row). The walk must skip them too: without
          // this, a presented-by-catch-up own-bot message stays row-less, is
          // neither 'routed' nor attempts-exhausted, and the walk stops at it
          // — wedging every missed user message behind it.
          summary.skippedOwnBot += 1;
          advance();
          continue;
        }
        if (isDiscordMessageTerminal(target.id, message.id)) {
          summary.skippedTerminal += 1;
          advance();
          continue;
        }
        const event = {
          type: 'GATEWAY_MESSAGE_CREATE',
          timestamp: now(),
          data: { ...message, guild_id: target.guildId },
        };
        // SINGLE-ATTEMPT POST (A16): run-to-run cadence is the engine's retry
        // mechanism. Intra-call HTTP retries would burn one claim attempt each
        // and can exhaust the 3-attempt budget in ~1.3 s; the LIVE forwarder
        // keeps its own 3 network-level attempts unchanged.
        const delivered = await forwardDiscordGatewayEventWithRetry(deps.webhookUrl, event, deps.botToken, {
          fetchImpl,
          sleep,
          retryDelaysMs: [],
        });
        // Verify against the ROW, not the HTTP status (A16): a duplicate-drop
        // or an abandoned/active-lease refusal also answers 200 — only a row
        // that is genuinely 'routed' counts as routed / advances the cursor.
        if (delivered && getDiscordMessageRouteStatus(target.id, message.id) === 'routed') {
          summary.routed += 1;
          markDiscordMessageSource(target.id, message.id, 'catchup');
          advance();
          log.info('Discord catch-up routed missed message', {
            channelId: target.id,
            messageId: message.id,
            reason: summary.reason,
          });
          continue;
        }
        summary.failed += 1;
        if (getDiscordMessageRouteAttempts(target.id, message.id) >= DISCORD_ROUTE_MAX_ATTEMPTS) {
          // Bounded abandon: never wedge a channel behind one poison message.
          // The ONE non-routed case that advances the cursor, logged at ERROR.
          log.error('Discord catch-up abandoned message', { channelId: target.id, messageId: message.id });
          advance();
          continue;
        }
        return; // stop advancing this target; retry from the cursor next run
      }
    }
  }

  /**
   * Re-present one stranded non-terminal row (A11): the after=cursor walk can
   * never see rows BEHIND the cursor, so fetch the message by id and re-POST
   * it through the same synthesis path. NEVER moves any cursor (the cursor is
   * already past these rows). Uses the same single-attempt POST + row-status
   * verification as the walk — anything else would reintroduce the A16 holes.
   */
  async function sweepRetriableRoute(
    row: { channel_id: string; message_id: string },
    summary: DiscordCatchupRunSummary,
  ): Promise<void> {
    const boundOut = (guild: string | null, reason: string): void => {
      // Burn one BOUNDED claim attempt and record the failure: after
      // DISCORD_ROUTE_MAX_ATTEMPTS sweeps the row is terminal and the SQL
      // stops listing it — attempts stay bounded, the sweep never loops forever.
      const nowStr = nowIso();
      claimDiscordMessage(
        row.channel_id,
        row.message_id,
        { guildId: guild, authorId: null, source: 'catchup' },
        nowStr,
        new Date(now() + config.routeLeaseMs).toISOString(),
      );
      markDiscordMessageFailed(row.channel_id, row.message_id, nowStr, reason);
      summary.failed += 1;
    };
    let guildId = guildCache.get(row.channel_id);
    if (guildId === undefined) {
      const info = await discordGetJson<{ guild_id?: string }>(`/channels/${encodeURIComponent(row.channel_id)}`);
      if (!info) return; // channel unreadable THIS run (transient); the SQL horizon bounds how long such rows can hold a budget slot
      guildId = typeof info.guild_id === 'string' && info.guild_id.length > 0 ? info.guild_id : null;
      guildCache.set(row.channel_id, guildId);
    }
    if (guildId === null) {
      // Non-guild (DM) rows are PERMANENTLY out of scope v1 (matches the walk):
      // drive them terminal instead of letting them occupy a sweep-budget slot
      // on every run until the horizon ages them out.
      boundOut(null, 'non-guild channel out of scope (v1)');
      return;
    }

    // One-shot fetch by id — we need the raw status code to detect deletion.
    const response = await fetchImpl(
      `${DISCORD_API_BASE}/channels/${encodeURIComponent(row.channel_id)}/messages/${encodeURIComponent(row.message_id)}`,
      { method: 'GET', headers: { Authorization: `Bot ${deps.botToken}` } },
    );
    await sleep(DISCORD_CATCHUP_REST_PACING_MS);
    if (response.status === 429) return; // rate-limited: the row stays listed for next run
    if (response.status === 404) {
      boundOut(guildId, 'message deleted (404) during sweep');
      return;
    }
    if (!response.ok) {
      log.warn('Discord catch-up sweep fetch failed', {
        channelId: row.channel_id,
        messageId: row.message_id,
        status: response.status,
      });
      return;
    }
    const message = (await response.json()) as DiscordRestMessage;
    summary.fetched += 1;
    if (!ROUTABLE_MESSAGE_TYPES.has(message.type)) {
      boundOut(guildId, 'non-routable message type');
      return;
    }
    const event = {
      type: 'GATEWAY_MESSAGE_CREATE',
      timestamp: now(),
      data: { ...message, guild_id: guildId }, // same hard-required injection as the walk
    };
    const delivered = await forwardDiscordGatewayEventWithRetry(deps.webhookUrl, event, deps.botToken, {
      fetchImpl,
      sleep,
      retryDelaysMs: [],
    });
    if (delivered && getDiscordMessageRouteStatus(row.channel_id, row.message_id) === 'routed') {
      summary.routed += 1;
      markDiscordMessageSource(row.channel_id, row.message_id, 'catchup');
      log.info('Discord catch-up routed missed message', {
        channelId: row.channel_id,
        messageId: row.message_id,
        reason: summary.reason,
        sweep: true,
      });
      return;
    }
    summary.failed += 1;
    if (getDiscordMessageRouteAttempts(row.channel_id, row.message_id) >= DISCORD_ROUTE_MAX_ATTEMPTS) {
      // Terminal abandon is visible here too; the SQL excludes the row next run.
      log.error('Discord catch-up abandoned message', { channelId: row.channel_id, messageId: row.message_id });
    }
  }

  async function doRun(reason: DiscordCatchupReason): Promise<DiscordCatchupRunSummary> {
    const startedAt = now();
    const deadline = startedAt + DISCORD_CATCHUP_RUN_WALL_CLOCK_MS;
    const summary: DiscordCatchupRunSummary = {
      reason,
      channels: 0,
      threads: 0,
      fetched: 0,
      routed: 0,
      skippedTerminal: 0,
      skippedOwnBot: 0,
      failed: 0,
      durationMs: 0,
    };
    try {
      const channels = deps.monitoredChannelIds();
      summary.channels = channels.size;
      const targets: TargetInfo[] = [];
      const guilds = new Set<string>();
      for (const channelId of [...channels].sort()) {
        const target = await resolveChannelTarget(channelId);
        if (target) {
          targets.push(target);
          guilds.add(target.guildId);
        }
      }
      for (const guildId of [...guilds].sort()) {
        const threadTargets = await resolveThreadTargets(guildId, channels);
        summary.threads += threadTargets.length;
        targets.push(...threadTargets);
      }
      for (const target of targets) {
        if (now() > deadline) {
          log.warn('Discord catch-up run hit wall-clock cap', { reason });
          break;
        }
        try {
          await catchUpTarget(target, summary, deadline);
        } catch (error) {
          log.warn('Discord catch-up target failed', { channelId: target.id, error: String(error) });
        }
      }
      // Stranded-row sweep (A11): a live failure followed by a later live
      // success leaves a retriable 'failed' (or crash-orphaned 'processing')
      // row BEHIND the cursor, where the after=cursor walk can never see it
      // again. Re-present each such row individually. NO cursor movement here.
      // Horizon enforced IN the SQL (starvation guard): rows older than the
      // backfill horizon are excluded by the query itself, so they can never
      // occupy one of the 50 oldest-first budget slots and starve newer
      // retriable rows — an aged row is an accepted residual.
      const sweepHorizonIso = new Date(now() - config.maxAgeMs).toISOString();
      for (const row of listRetriableDiscordMessageRoutes(nowIso(), sweepHorizonIso, 50)) {
        if (now() > deadline) break;
        try {
          await sweepRetriableRoute(row, summary);
        } catch (error) {
          log.warn('Discord catch-up sweep failed for row', {
            channelId: row.channel_id,
            messageId: row.message_id,
            error: String(error),
          });
        }
      }
      if (reason === 'periodic') {
        pruneDiscordMessageRoutes(new Date(now() - DISCORD_ROUTE_PRUNE_AFTER_MS).toISOString());
      }
    } catch (error) {
      log.warn('Discord catch-up run failed', { reason, error: String(error) });
    }
    summary.durationMs = now() - startedAt;
    log.info('Discord catch-up run complete', { ...summary });
    return summary;
  }

  function runOnce(reason: DiscordCatchupReason): Promise<DiscordCatchupRunSummary | null> {
    if (config.disabled) return Promise.resolve(null);
    if (running) return running; // single-flight: overlapping triggers coalesce
    const run = doRun(reason).finally(() => {
      running = null;
    });
    running = run;
    return run;
  }

  function onGatewayEvent(type: string): void {
    if (config.disabled) return;
    // RESUMED is deliberately NOT a trigger: Discord replays missed events on
    // a session resume; only a fresh IDENTIFY (READY) leaves a gap.
    if (type !== 'GATEWAY_READY') return;
    if (readyDebounceTimer) clearTimeout(readyDebounceTimer);
    readyDebounceTimer = setTimeout(() => {
      readyDebounceTimer = null;
      void runOnce('ready');
    }, config.readyDebounceMs);
    readyDebounceTimer.unref?.();
  }

  function start(): void {
    if (config.disabled) {
      log.info('Discord catch-up disabled via DISCORD_CATCHUP_DISABLED');
      return;
    }
    void runOnce('startup');
    if (periodicTimer || config.intervalMs <= 0) return;
    periodicTimer = setInterval(() => {
      void runOnce('periodic');
    }, config.intervalMs);
    periodicTimer.unref?.();
  }

  function stop(): void {
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = null;
    if (readyDebounceTimer) clearTimeout(readyDebounceTimer);
    readyDebounceTimer = null;
  }

  return { runOnce, onGatewayEvent, start, stop };
}
