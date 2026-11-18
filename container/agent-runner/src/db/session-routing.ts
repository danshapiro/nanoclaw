/**
 * Default reply routing for this session — written by the host on every
 * container wake (see src/session-manager.ts `writeSessionRouting`).
 *
 * Read by the MCP tools as the default destination for outbound messages
 * when the agent doesn't specify an explicit `to`. This is what makes
 * "agent replies in the thread it's currently in" work: the router strips
 * or preserves thread_id based on the adapter's thread support, and we
 * just read the fixed routing the host committed for this session.
 */
import fs from 'fs';

import { getInboundDb } from './connection.js';

export interface SessionRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  messaging_group_id: string | null;
  is_group: 0 | 1 | null;
}

export function getSessionRouting(): SessionRouting {
  const db = getInboundDb();
  try {
    const row = db
      .prepare(
        'SELECT channel_type, platform_id, thread_id, messaging_group_id, is_group FROM session_routing WHERE id = 1',
      )
      .get() as SessionRouting | undefined;
    if (row) return row;
  } catch {
    // Table may not exist on an older session DB — fall through to defaults
  }
  return { channel_type: null, platform_id: null, thread_id: null, messaging_group_id: null, is_group: null };
}

/**
 * The admin transport can explicitly redirect an inbound reply. Preserve that
 * address for default MCP sends too, using only the current host-accepted input.
 * Ordinary CLI/default destinations remain unchanged. No latest-row guessing.
 */
export function getAcceptedReplyRouting(
  inputId: string,
  routeKey: string,
  source: SessionRouting,
): SessionRouting | null {
  const rows = getInboundDb()
    .prepare(
      `
    SELECT channel_type, platform_id, thread_id, messaging_group_id, is_group,
           host_accepted_at, host_acceptance_ended_at
      FROM messages_in
     WHERE host_accepted_input_id = ? AND host_accepted_route_key = ?
  `,
    )
    .all(inputId, routeKey) as (SessionRouting & {
    host_accepted_at: string | null;
    host_acceptance_ended_at: string | null;
  })[];
  if (rows.length === 0) return null;
  const first = rows[0];
  if (
    rows.some(
      (row) =>
        row.messaging_group_id !== source.messaging_group_id ||
        row.is_group !== source.is_group ||
        row.host_acceptance_ended_at !== null ||
        typeof row.host_accepted_at !== 'string' ||
        !Number.isFinite(Date.parse(row.host_accepted_at)) ||
        row.channel_type !== first.channel_type ||
        row.platform_id !== first.platform_id ||
        row.thread_id !== first.thread_id,
    ) ||
    typeof first.channel_type !== 'string' ||
    !first.channel_type ||
    typeof first.platform_id !== 'string' ||
    !first.platform_id ||
    (first.thread_id !== null && typeof first.thread_id !== 'string')
  ) {
    throw new Error('Current admin reply routing is incomplete, ended, or ambiguous; specify an explicit destination.');
  }
  return {
    channel_type: first.channel_type,
    platform_id: first.platform_id,
    thread_id: first.thread_id,
    messaging_group_id: source.messaging_group_id,
    is_group: source.is_group,
  };
}

// Missing correlation may preserve the ordinary CLI default only when there
// is no unresolved accepted redirection. Never guess which redirect was active.
function hasUnresolvedReplyRedirect(source: SessionRouting): boolean {
  return !!getInboundDb()
    .prepare(
      `
    SELECT 1 FROM messages_in
     WHERE host_acceptance_ended_at IS NULL
       AND (host_accepted_input_id IS NOT NULL OR host_accepted_route_key IS NOT NULL OR host_accepted_at IS NOT NULL)
       AND (channel_type IS NOT ? OR platform_id IS NOT ? OR thread_id IS NOT ?)
     LIMIT 1
  `,
    )
    .get(source.channel_type, source.platform_id, source.thread_id);
}

/** Explicit CLI-origin reply routing; other ordinary session defaults stay unchanged. */
export function getCurrentReplyRouting(): SessionRouting & { activeRouteKey?: string } {
  const source = getSessionRouting();
  const relayRouteKey = process.env.NANOCLAW_RELAY_ROUTE_KEY;
  const relayMode = process.env.NANOCLAW_RELAY_MODE;
  if ((relayMode === '1' || relayMode === 'true') && !relayRouteKey) {
    throw new Error('Missing relay route lock; refusing default delivery.');
  }
  if (source.channel_type !== 'cli' && !relayRouteKey) return source;
  let active: { inputId?: unknown; routeKey?: unknown } | null;
  try {
    active = JSON.parse(
      fs.readFileSync(process.env.NANOCLAW_ACTIVE_INPUT_PATH || '/workspace/.active-input.json', 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !relayRouteKey && !hasUnresolvedReplyRedirect(source))
      return source;
    throw new Error('Current admin input identity is unreadable; refusing default delivery.', { cause: error });
  }
  if (
    !active ||
    typeof active.inputId !== 'string' ||
    !active.inputId ||
    typeof active.routeKey !== 'string' ||
    !active.routeKey
  ) {
    throw new Error('Current admin input identity is incomplete; refusing default delivery.');
  }
  // Relays remain bound to the route captured at launch, even if the accepted
  // input has since moved, ended, or lost its correlation file/proof.
  if (relayRouteKey && relayRouteKey !== active.routeKey) {
    throw new Error('Current admin input differs from the relay route lock; refusing default delivery.');
  }
  const accepted = getAcceptedReplyRouting(active.inputId, active.routeKey, source);
  if (!accepted)
    throw new Error('Missing accepted proof for the current reply/relay route lock; refusing default delivery.');
  return { ...accepted, activeRouteKey: active.routeKey };
}
