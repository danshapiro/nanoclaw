import { findByRouting } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import { TIMEZONE, formatLocalTime } from './timezone.js';

/**
 * Command categories for messages starting with '/'.
 * - admin: sender must be in NANOCLAW_ADMIN_USER_IDS
 * - filtered: silently drop (mark completed without processing)
 * - passthrough: pass raw to the agent (no XML wrapping)
 * - none: not a command — format normally
 */
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

const ADMIN_COMMANDS = new Set(['/remote-control', '/compact', '/context', '/cost', '/files']);
const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/start']);

export interface CommandInfo {
  category: CommandCategory;
  command: string; // the command name (e.g., '/clear')
  text: string; // full original text
  senderId: string | null;
}

/**
 * Categorize a message as a command or not.
 * Only applies to chat/chat-sdk messages.
 *
 * The extracted `senderId` is compared against `NANOCLAW_ADMIN_USER_IDS`
 * which stores ids in the namespaced form `<channel_type>:<raw>` (see
 * src/db/users.ts). chat-sdk-bridge serializes `author.userId` as a raw
 * platform id with no prefix, so we prefix it here. If the id already
 * contains a `:` we assume it's pre-namespaced (non-chat-sdk adapters
 * that populate `senderId` directly) and leave it alone.
 */
export function categorizeMessage(msg: MessageInRow): CommandInfo {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  const senderId = extractSenderId(msg, content);

  if (!text.startsWith('/')) {
    return { category: 'none', command: '', text, senderId };
  }

  // Extract the command name (e.g., '/clear' from '/clear some args')
  const command = text.split(/\s/)[0].toLowerCase();

  if (ADMIN_COMMANDS.has(command)) {
    return { category: 'admin', command, text, senderId };
  }

  if (FILTERED_COMMANDS.has(command)) {
    return { category: 'filtered', command, text, senderId };
  }

  return { category: 'passthrough', command, text, senderId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSenderId(msg: MessageInRow, content: any): string | null {
  const raw: string | null = content?.senderId || content?.author?.userId || null;
  if (!raw) return null;
  // Already namespaced (e.g. "telegram:123") — use as-is.
  if (raw.includes(':')) return raw;
  // Raw platform id from chat-sdk serialization — prefix with channel type.
  if (!msg.channel_type) return raw;
  return `${msg.channel_type}:${raw}`;
}

/**
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  /**
   * Normalized active route metadata so every route-bearing `messages_out` row
   * the poll loop writes (result text, relay status, inactivity fallback) is
   * stamped with `route_key`/`messaging_group_id`/`is_group`. Without these,
   * `harvestRouteScopedProgress` could never find the agent's own user-visible
   * progress during recovery (it filters on `route_key`). The poll loop fills
   * these from the wake's authoritative active route scope; `extractRouting`
   * leaves them null for callers that only need the bare destination.
   */
  routeKey?: string | null;
  messagingGroupId?: string | null;
  isGroup?: 0 | 1 | null;
}

/**
 * Extract routing context from a batch of messages.
 * Uses the first message's routing fields.
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const first = messages[0];
  return {
    platformId: first?.platform_id ?? null,
    channelType: first?.channel_type ?? null,
    threadId: first?.thread_id ?? null,
    inReplyTo: first?.id ?? null,
    routeKey: null,
    messagingGroupId: null,
    isGroup: null,
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 *
 * Prepends a `<context timezone="<IANA>" />` header so the agent always knows
 * what timezone it's in — every timestamp it sees in message bodies is the
 * user's local time, and every time it produces (schedules, suggests) should
 * be interpreted as local time in that same zone. This header is v1 behavior
 * (src/v1/router.ts:20-22); dropping it led to misinterpretations where the
 * agent scheduled tasks for the wrong hour.
 *
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 */
export function formatMessages(messages: MessageInRow[]): string {
  const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`;
  if (messages.length === 0) return header;

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (taskMessages.length > 0) {
    parts.push(...taskMessages.map(formatTaskMessage));
  }
  if (webhookMessages.length > 0) {
    parts.push(...webhookMessages.map(formatWebhookMessage));
  }
  if (systemMessages.length > 0) {
    parts.push(...systemMessages.map(formatSystemMessage));
  }

  return header + parts.join('\n\n');
}

function formatChatMessages(messages: MessageInRow[]): string {
  if (messages.length === 1) {
    return formatSingleChat(messages[0]);
  }

  const lines = ['<messages>'];
  for (const msg of messages) {
    lines.push(formatSingleChat(msg));
  }
  lines.push('</messages>');
  return lines.join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyAttr = content.replyTo?.id ? ` reply_to="${escapeXml(String(content.replyTo.id))}"` : '';
  const replyPrefix = formatReplyContext(content.replyTo);
  const attachmentsSuffix = formatAttachments(content.attachments);

  const fromAttr = formatOriginDestinationAttr(msg);

  return `<message${idAttr}${fromAttr} sender="${escapeXml(sender)}" time="${escapeXml(time)}"${replyAttr}>${replyPrefix}${escapeXml(text)}${attachmentsSuffix}</message>`;
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const parts = [`[SCHEDULED TASK${formatOriginDestinationAttr(msg)}]`];
  if (content.scriptOutput) {
    parts.push('', 'Script output:', JSON.stringify(content.scriptOutput, null, 2));
  }
  parts.push('', 'Instructions:', content.prompt || '');
  return parts.join('\n');
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  return `[WEBHOOK${formatOriginDestinationAttr(msg)}: ${source}/${event}]\n\n${JSON.stringify(content.payload || content, null, 2)}`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  return `[SYSTEM RESPONSE]\n\nAction: ${content.action || 'unknown'}\nStatus: ${content.status || 'unknown'}\nResult: ${JSON.stringify(content.result || null)}`;
}

function formatOriginDestinationAttr(msg: MessageInRow): string {
  // Look up the destination name for the origin (reverse map lookup).
  // If not found, fall back to a raw channel:platform_id marker so nothing
  // gets silently dropped — this should only happen if the destination was
  // removed between when the message was received and when it's being processed.
  const fromDest = findByRouting(msg.channel_type, msg.platform_id);
  if (fromDest) return ` from="${escapeXml(fromDest.name)}"`;
  if (msg.channel_type || msg.platform_id) {
    return ` from="unknown:${escapeXml(msg.channel_type || '')}:${escapeXml(msg.platform_id || '')}"`;
  }
  return '';
}

/**
 * Render the quoted original inside the <message> body.
 *
 * Matches v1 format (src/v1/router.ts:10-18): `<quoted_message from="X">Y</quoted_message>`.
 * Requires BOTH sender and text — if only id is present the reply_to attribute
 * on the parent <message> carries the link without an inline preview.
 *
 * No truncation here (v1 didn't truncate).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const sender = replyTo.sender;
  const text = replyTo.text;
  if (!sender || !text) return '';
  return `\n  <quoted_message from="${escapeXml(sender)}">${escapeXml(text)}</quoted_message>\n`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAttachments(attachments: any[] | undefined): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = attachments.map((a) => {
    const name = a.originalName || a.name || a.filename || a.safeName || 'attachment';
    const type = a.contentType || a.mimeType || a.type || 'file';
    const size = typeof a.sizeBytes === 'number' ? ` - ${a.sizeBytes} bytes` : '';
    const workspacePath = a.workspacePath || '';
    const localPath = a.localPath ? `/workspace/${a.localPath}` : '';
    const url = a.url || '';
    if (workspacePath) {
      return `[${type}: ${escapeXml(name)}${size} - saved to ${escapeXml(workspacePath)}]`;
    }
    if (localPath) {
      return `[${type}: ${escapeXml(name)}${size} - saved to ${escapeXml(localPath)}]`;
    }
    return url ? `[${type}: ${escapeXml(name)} (${escapeXml(url)})]` : `[${type}: ${escapeXml(name)}]`;
  });
  return '\n' + parts.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Strip `<internal>...</internal>` blocks from agent output, then trim.
 * Ported from v1 (src/v1/router.ts:25-27). Used to remove the agent's
 * own scratchpad/reasoning before a reply goes out over a channel.
 */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Export the XML escape helper so other modules (recovery prompt injection in
 * the poll loop) can XML-escape untrusted recovery text without re-implementing
 * the entity rules.
 */
export function escapeXmlText(str: string): string {
  return escapeXml(str);
}

/** Minimal shape of a recovery entry needed for prompt injection. */
export interface RecoveryContextInput {
  classification: string;
  agentMessage: string;
  originalTasks: Array<{ text: string }>;
  acceptedUnresolvedInputs: Array<{ prompt: string }>;
  priorProgress: Array<{ text: string }>;
  observations: string[];
  sideEffects: Array<{ kind: string; label: string }>;
  continuationPolicy: string;
}

/**
 * Build an XML-escaped `<recovery>` block prepended to a top-level prompt so the
 * next Yente turn resumes interrupted work with full route-scoped context: the
 * original task(s), any accepted-but-unresolved input prompts, the agent's prior
 * user-visible progress, completed side effects (so it reports existing work
 * rather than duplicating it), and the continuation policy. All untrusted text is
 * XML-escaped. Returns '' when there is nothing to inject.
 */
export function formatRecoveryContext(entries: RecoveryContextInput[]): string {
  if (entries.length === 0) return '';
  const lines: string[] = ['<recovery>'];
  lines.push(
    '  <note>You were interrupted on a previous turn for this conversation. Resume the work below; do NOT repeat any completed side effects.</note>',
  );
  for (const e of entries) {
    lines.push(`  <interrupted classification="${escapeXml(e.classification)}" continuation_policy="${escapeXml(e.continuationPolicy)}">`);
    if (e.agentMessage) lines.push(`    <status>${escapeXml(e.agentMessage)}</status>`);
    for (const t of e.originalTasks) lines.push(`    <original_task>${escapeXml(t.text)}</original_task>`);
    for (const a of e.acceptedUnresolvedInputs) lines.push(`    <unresolved_input>${escapeXml(a.prompt)}</unresolved_input>`);
    for (const p of e.priorProgress) lines.push(`    <prior_progress>${escapeXml(p.text)}</prior_progress>`);
    for (const o of e.observations) lines.push(`    <observation>${escapeXml(o)}</observation>`);
    for (const s of e.sideEffects)
      lines.push(`    <completed_side_effect kind="${escapeXml(s.kind)}">${escapeXml(s.label)}</completed_side_effect>`);
    lines.push('  </interrupted>');
  }
  lines.push('</recovery>');
  return lines.join('\n');
}

// ── Route normalization (Task 1 Step 10) ─────────────────────────────────────

export interface RouteInput {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  messagingGroupId: string | null;
  isGroup: 0 | 1 | null;
}

export interface NormalizedRoute {
  routeKey: string;
  providerName: string;
  platformId: string | null;
  channelType: string | null;
  messagingGroupId: string | null;
  isGroup: 0 | 1 | null;
  /** Normalized thread identity used in the route key. */
  threadKey: string | null;
}

/**
 * Normalize a row's routing identity into a stable route key/scope.
 *
 * The collapse rule is POSITIVE-ONLY and driven by host-stamped metadata, never
 * by guessing from nullable thread ids:
 *  - A DM (`isGroup===0`) with a known `messagingGroupId` normalizes its thread
 *    identity to `dm:<messagingGroupId>`, so a null-thread DM and a threaded DM
 *    alias collapse to the SAME route.
 *  - A group route (`isGroup===1`) keeps its distinct `thread_id`, so different
 *    group threads stay isolated.
 *  - A row LACKING host metadata (`messagingGroupId` null, or `isGroup` null) is
 *    NEVER collapsible: it gets a unique, self-identifying thread key so it can
 *    only ever match itself. The worst case is a missed merge, never a
 *    cross-conversation leak.
 */
export function normalizeRoute(providerName: string, input: RouteInput): NormalizedRoute {
  const platformId = input.platformId;
  const channelType = input.channelType;

  let threadKey: string;
  if (input.messagingGroupId != null && input.isGroup === 0) {
    // Confirmed DM: collapse all thread aliases to one DM route.
    threadKey = `dm:${input.messagingGroupId}`;
  } else if (input.messagingGroupId != null && input.isGroup === 1) {
    // Confirmed group route: distinct threads stay isolated.
    threadKey = `grp:${input.messagingGroupId}:${input.threadId ?? 'main'}`;
  } else {
    // No host metadata → non-collapsible. Encode thread_id plus a marker so it
    // can never equal a metadata-bearing route key.
    threadKey = `nometa:${channelType ?? ''}:${platformId ?? ''}:${input.threadId ?? 'null'}`;
  }

  const routeKey = `${providerName}|${channelType ?? ''}|${platformId ?? ''}|${threadKey}`;
  return {
    routeKey,
    providerName,
    platformId,
    channelType,
    messagingGroupId: input.messagingGroupId,
    isGroup: input.isGroup,
    threadKey,
  };
}
