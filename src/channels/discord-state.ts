import { getDb } from '../db/connection.js';

/** A route is terminally failed (abandoned) after this many claim attempts. */
export const DISCORD_ROUTE_MAX_ATTEMPTS = 3;

export type DiscordMessageRouteMeta = {
  guildId: string | null;
  authorId: string | null;
  source: 'gateway' | 'catchup';
};

export type DiscordClaimResult =
  | { claimed: true; status: 'processing' }
  | { claimed: false; status: 'already-routed' | 'abandoned' | 'active-lease' };

/**
 * Transactional claim for one Discord message at the ingress choke point.
 * - 'routed' refuses forever (already handed to the shared ingress path).
 * - 'failed' KEEPS its lease (markDiscordMessageFailed does not clear it):
 *   while the lease is unexpired it refuses as 'active-lease', so the live
 *   forwarder's rapid HTTP retries cannot burn claim attempts (A16). After
 *   expiry it reclaims (attempts+1) until DISCORD_ROUTE_MAX_ATTEMPTS, then
 *   refuses as 'abandoned' — bounded retries, a channel can never wedge.
 * - an active 'processing' lease refuses; an expired lease reclaims.
 * Time is injected (ISO strings) — this module has no clock.
 */
export function claimDiscordMessage(
  channelId: string,
  messageId: string,
  meta: DiscordMessageRouteMeta,
  now: string,
  leaseExpiresAt: string,
): DiscordClaimResult {
  const claim = getDb().transaction((): DiscordClaimResult => {
    const existing = getDb()
      .prepare(
        `SELECT status, lease_expires_at, attempts
           FROM discord_message_routes
          WHERE channel_id = ? AND message_id = ?`,
      )
      .get(channelId, messageId) as { status: string; lease_expires_at: string | null; attempts: number } | undefined;

    if (existing?.status === 'routed') return { claimed: false, status: 'already-routed' };
    if (existing?.status === 'failed' && existing.attempts >= DISCORD_ROUTE_MAX_ATTEMPTS) {
      return { claimed: false, status: 'abandoned' };
    }
    if (
      existing?.lease_expires_at &&
      existing.lease_expires_at > now &&
      (existing.status === 'processing' || existing.status === 'failed')
    ) {
      return { claimed: false, status: 'active-lease' };
    }

    getDb()
      .prepare(
        `INSERT INTO discord_message_routes (
           channel_id, message_id, guild_id, author_id, first_seen_at,
           claimed_at, lease_expires_at, attempts, status, source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'processing', ?)
         ON CONFLICT(channel_id, message_id) DO UPDATE SET
           claimed_at = excluded.claimed_at,
           lease_expires_at = excluded.lease_expires_at,
           attempts = discord_message_routes.attempts + 1,
           status = 'processing',
           last_error = NULL`,
      )
      .run(channelId, messageId, meta.guildId, meta.authorId, now, now, leaseExpiresAt, meta.source);

    return { claimed: true, status: 'processing' };
  }) as () => DiscordClaimResult;
  return claim();
}

export function markDiscordMessageRouted(channelId: string, messageId: string, routedAt: string): void {
  getDb()
    .prepare(
      `UPDATE discord_message_routes
          SET status = 'routed',
              routed_at = ?,
              lease_expires_at = NULL,
              last_error = NULL
        WHERE channel_id = ? AND message_id = ?`,
    )
    .run(routedAt, channelId, messageId);
}

/**
 * Record a failure WITHOUT clearing the lease (A16): the bridge answers 500
 * only after this runs, so the live forwarder's immediate HTTP retries hit an
 * unexpired lease and are duplicate-dropped instead of burning attempts 2–3
 * within ~1.3 s. Catch-up reclaims normally once the lease expires.
 */
export function markDiscordMessageFailed(channelId: string, messageId: string, failedAt: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE discord_message_routes
          SET status = 'failed',
              failed_at = ?,
              last_error = ?
        WHERE channel_id = ? AND message_id = ?`,
    )
    .run(failedAt, error.slice(0, 2000), channelId, messageId);
}

/** Terminal = handled: 'routed', or 'failed' with attempts exhausted (abandoned). */
export function isDiscordMessageTerminal(channelId: string, messageId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1
         FROM discord_message_routes
        WHERE channel_id = ? AND message_id = ?
          AND (status = 'routed' OR (status = 'failed' AND attempts >= ?))
        LIMIT 1`,
    )
    .get(channelId, messageId, DISCORD_ROUTE_MAX_ATTEMPTS);
  return Boolean(row);
}

export function getDiscordMessageRouteAttempts(channelId: string, messageId: string): number {
  const row = getDb()
    .prepare(`SELECT attempts FROM discord_message_routes WHERE channel_id = ? AND message_id = ?`)
    .get(channelId, messageId) as { attempts: number } | undefined;
  return row?.attempts ?? 0;
}

/** Raw row status ('processing' | 'routed' | 'failed') or null when absent — the engine verifies rows after POSTs (A16). */
export function getDiscordMessageRouteStatus(channelId: string, messageId: string): string | null {
  const row = getDb()
    .prepare(`SELECT status FROM discord_message_routes WHERE channel_id = ? AND message_id = ?`)
    .get(channelId, messageId) as { status: string } | undefined;
  return row?.status ?? null;
}
