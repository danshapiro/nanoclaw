/**
 * Session lifecycle: folders, DBs, messages, container status.
 *
 * Two-DB split — inbound.db (host writes) + outbound.db (container writes).
 * Three cross-mount invariants are load-bearing:
 *   1. journal_mode=DELETE — WAL's mmapped -shm doesn't refresh host→guest;
 *      the container would silently miss every new message.
 *   2. Host opens-writes-CLOSES per op — close invalidates the container's
 *      page cache; a long-lived connection freezes its view at first read.
 *   3. One writer per file — DELETE-mode journal-unlink isn't atomic across
 *      the mount; concurrent writers corrupt the DB.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { OutboundFile } from './channels/adapter.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import {
  archiveSession,
  createSession,
  findLatestArchivedSessionByAgentGroup,
  findLatestArchivedSessionForAgent,
  findSessionByAgentGroup,
  findSessionForAgent,
  getSession,
  reactivateSession,
  updateSession,
} from './db/sessions.js';
import {
  ensureSchema,
  openInboundDb as openInboundDbRaw,
  openOutboundDb as openOutboundDbRaw,
  openOutboundDbReadOnlyHealing,
  openOutboundDbRw as openOutboundDbRwRaw,
  openOutboundDbForWrite,
  upsertSessionRouting,
  insertMessage,
} from './db/session-db.js';
import { log } from './log.js';
import { readContainerConfig } from './container-config.js';
import type { Session } from './types.js';
import {
  formatAttachmentErrorPromptMetadata,
  formatAttachmentPromptMetadata,
  materializeAttachmentData,
  type MaterializedAttachment,
} from './yente/attachments.js';
import { assertNoRouteResetInProgress } from './yente/scheduler-supersessions.js';

/** Root directory for all session data. */
export function sessionsBaseDir(): string {
  return path.join(DATA_DIR, 'v2-sessions');
}

/** Directory for a specific session: sessions/{agent_group_id}/{session_id}/ */
export function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, sessionId);
}

/** Path to the host-owned inbound DB (messages_in + delivered). */
export function inboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'inbound.db');
}

/** Path to the container-owned outbound DB (messages_out + processing_ack). */
export function outboundDbPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), 'outbound.db');
}

/** Path to the container heartbeat file (touched instead of DB writes). */
export function heartbeatPath(agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(agentGroupId, sessionId), '.heartbeat');
}

/** Host-owned correlation state lives outside the agent-writable session tree. */
export function hostCorrelationDir(agentGroupId: string, sessionId: string): string {
  return path.join(DATA_DIR, 'v2-host-correlation', agentGroupId, sessionId);
}

export function hostCorrelationPath(agentGroupId: string, sessionId: string): string {
  return path.join(hostCorrelationDir(agentGroupId, sessionId), 'current.json');
}

/** R6: host-owned per-session container stderr tails — OUTSIDE the agent-writable session tree, never mounted. */
export function containerLogsDir(agentGroupId: string, sessionId: string): string {
  return path.join(DATA_DIR, 'v2-container-logs', agentGroupId, sessionId);
}

export function hostRouteKey(
  providerName: string,
  message: {
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
    messagingGroupId?: string | null;
    isGroup?: 0 | 1 | null;
  },
): string {
  const channelType = message.channelType ?? null;
  const platformId = message.platformId ?? null;
  let threadKey: string;
  if (message.messagingGroupId != null && message.isGroup === 0) {
    threadKey = `dm:${message.messagingGroupId}`;
  } else if (message.messagingGroupId != null && message.isGroup === 1) {
    threadKey = `grp:${message.messagingGroupId}:${message.threadId ?? 'main'}`;
  } else {
    threadKey = `nometa:${channelType ?? ''}:${platformId ?? ''}:${message.threadId ?? 'null'}`;
  }
  return `${providerName}|${channelType ?? ''}|${platformId ?? ''}|${threadKey}`;
}

export function buildHostInputStamp(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    platformId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
    messagingGroupId?: string | null;
    isGroup?: 0 | 1 | null;
  },
  receivedAt = new Date().toISOString(),
): {
  hostInputId: string;
  hostRouteKey: string;
  hostReceivedAt: string;
} {
  const agentGroup = getAgentGroup(agentGroupId);
  const providerName = agentGroup
    ? (readContainerConfig(agentGroup.folder).provider ?? 'claude').trim().toLowerCase()
    : 'claude';
  return {
    hostInputId: `in-host-${createHash('sha256').update(`${sessionId}\0${message.id}`).digest('hex').slice(0, 24)}`,
    hostRouteKey: hostRouteKey(providerName, message),
    hostReceivedAt: receivedAt,
  };
}

/**
 * Path to the per-session marker recording the managed-skill generation the
 * current container spawned with. Lives beside the heartbeat in the session
 * dir. Parameterized by an explicit session dir so it is a pure fs wrapper.
 */
export function skillGenerationPath(sessionDirPath: string): string {
  return path.join(sessionDirPath, '.skill-generation');
}

/** Record the managed-skill generation a container spawned with. Best-effort:
 *  a write failure must not block the spawn (host-sweep just won't recycle for
 *  this generation, i.e. it degrades to today's behavior). */
export function writeSpawnSkillGeneration(sessionDirPath: string, value: string): void {
  try {
    fs.mkdirSync(sessionDirPath, { recursive: true });
    fs.writeFileSync(skillGenerationPath(sessionDirPath), value);
  } catch {
    // Non-fatal — see doc comment.
  }
}

/** Read the generation a container spawned with ('' when the marker is absent). */
export function readSpawnSkillGeneration(sessionDirPath: string): string {
  try {
    return fs.readFileSync(skillGenerationPath(sessionDirPath), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * @deprecated Use inboundDbPath / outboundDbPath instead.
 * Kept temporarily for test compatibility during migration.
 */
export function sessionDbPath(agentGroupId: string, sessionId: string): string {
  return inboundDbPath(agentGroupId, sessionId);
}

function generateId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export type SessionMode = 'shared' | 'per-thread' | 'agent-shared';

/**
 * Find or create a session for a messaging group + thread.
 *
 * Session modes:
 * - 'shared': one session per messaging group (ignores threadId)
 * - 'per-thread': one session per (messaging group, thread)
 * - 'agent-shared': one session per agent group — all messaging groups
 *   wired with this mode share a single session (e.g. GitHub + Slack)
 */
export function resolveSession(
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null,
  sessionMode: SessionMode,
  reviveArchived = false,
): { session: Session; created: boolean } {
  // agent-shared: single session per agent group, regardless of messaging group
  if (sessionMode === 'agent-shared') {
    const existing = findSessionByAgentGroup(agentGroupId);
    if (existing) {
      return { session: existing, created: false };
    }
  } else if (messagingGroupId) {
    const lookupThreadId = sessionMode === 'shared' ? null : threadId;
    // Scope lookup by agent_group_id so fan-out to multiple agents in the
    // same chat doesn't accidentally deliver to the wrong agent's session.
    const existing = findSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
    if (existing) {
      return { session: existing, created: false };
    }
  }

  // Guard BEFORE revival: during a scheduler-aware reset both route
  // sessions are 'resetting', so the active lookups above miss — reviving
  // an archived sibling here would end with two active sessions after the
  // reset finalizes. Throwing preserves today's exact mid-reset behavior.
  assertNoRouteResetInProgress({
    agentGroupId,
    messagingGroupId,
    threadId,
    sessionMode,
  });

  if (reviveArchived) {
    if (sessionMode === 'agent-shared') {
      const archived = findLatestArchivedSessionByAgentGroup(agentGroupId);
      if (archived) {
        return { session: reviveArchivedSession(archived), created: false };
      }
    } else if (messagingGroupId) {
      const lookupThreadId = sessionMode === 'shared' ? null : threadId;
      const archived = findLatestArchivedSessionForAgent(agentGroupId, messagingGroupId, lookupThreadId);
      if (archived) {
        return { session: reviveArchivedSession(archived), created: false };
      }
    }
  }

  const id = generateId();
  const lookupThreadId = sessionMode === 'per-thread' ? threadId : null;
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: lookupThreadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };

  createSession(session);
  initSessionFolder(agentGroupId, id);
  log.info('Session created', { id, agentGroupId, messagingGroupId, threadId: lookupThreadId, sessionMode });

  return { session, created: true };
}

/**
 * HARD REQUIREMENT (see docs/plans/2026-07-30-sqlite-write-churn.md): an
 * inbound message for an archived session revives it and delivers into it —
 * never drops, never forks a duplicate session. Revival is OPT-IN
 * (reviveArchived=true) at the router inbound call site only; every other
 * caller (a2a agent-route, rollActiveSession) keeps today's mint-fresh
 * semantics — a fresh session still delivers, so never-drop holds there too.
 */
function reviveArchivedSession(session: Session): Session {
  reactivateSession(session.id);
  // The on-disk folder normally survives archival; recreate it only if it
  // vanished (e.g. manual cleanup) so the message write cannot fail.
  if (!fs.existsSync(sessionDir(session.agent_group_id, session.id))) {
    initSessionFolder(session.agent_group_id, session.id);
  }
  log.info('Session reactivated by inbound routing', {
    id: session.id,
    agentGroupId: session.agent_group_id,
    messagingGroupId: session.messaging_group_id,
    threadId: session.thread_id,
  });
  return { ...session, status: 'active' };
}

export function rollActiveSession(args: {
  agentGroupId: string;
  messagingGroupId: string;
  threadId: string | null;
  sessionMode: SessionMode;
}): Session {
  const lookupThreadId = args.sessionMode === 'per-thread' ? args.threadId : null;
  const existing =
    args.sessionMode === 'agent-shared'
      ? findSessionByAgentGroup(args.agentGroupId)
      : findSessionForAgent(args.agentGroupId, args.messagingGroupId, lookupThreadId);

  if (existing) {
    archiveSession(existing.id);
  }

  return resolveSession(args.agentGroupId, args.messagingGroupId, args.threadId, args.sessionMode).session;
}

/** Create the session folder and initialize both DBs. */
export function initSessionFolder(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
  ensureSessionWorkspaceDirs(agentGroupId, sessionId);

  ensureSchema(inboundDbPath(agentGroupId, sessionId), 'inbound');
  ensureSchema(outboundDbPath(agentGroupId, sessionId), 'outbound');
}

export function ensureSessionWorkspaceDirs(agentGroupId: string, sessionId: string): void {
  const dir = sessionDir(agentGroupId, sessionId);
  ensureWritableSessionSubdir(dir, 'group');
  ensureDurableSideEffectLedger(dir);
  fs.mkdirSync(hostCorrelationDir(agentGroupId, sessionId), { recursive: true, mode: 0o700 });
}

/**
 * Create the empty side-effect ledger before a container can accept work.
 *
 * Strict crash recovery deliberately treats a missing ledger as ambiguous:
 * absence could mean either "no mutation happened" or "power failed after the
 * mutation but before its append." Persisting the empty-file directory entry
 * before launch makes those states distinguishable without weakening recovery.
 * Existing ledgers are never truncated or rewritten.
 */
export function ensureDurableSideEffectLedger(dir: string): void {
  const ledger = path.join(dir, 'side-effects.jsonl');
  let ledgerFd: number | undefined;
  let created = false;
  try {
    ledgerFd = fs.openSync(
      ledger,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    fs.fsyncSync(ledgerFd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(ledger);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Session side-effect ledger is not a regular file: ${ledger}`, { cause: error });
    }
  } finally {
    if (ledgerFd !== undefined) fs.closeSync(ledgerFd);
  }

  if (!created) return;
  const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

function ensureWritableSessionSubdir(dir: string, name: string): void {
  const target = path.join(dir, name);
  fs.mkdirSync(target, { recursive: true });

  try {
    fs.accessSync(target, fs.constants.W_OK | fs.constants.X_OK);
    return;
  } catch {
    // Docker creates missing nested mountpoints as root-owned directories
    // inside the /workspace bind mount. If the directory is still empty,
    // replace it with a service-owned directory before the agent starts.
  }

  const entries = fs.readdirSync(target);
  if (entries.length > 0) {
    throw new Error(
      `Session workspace directory ${target} is not writable and is not empty; fix ownership before spawning the agent container`,
    );
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.accessSync(target, fs.constants.W_OK | fs.constants.X_OK);
}

/**
 * Write the default reply routing for a session into its inbound.db.
 *
 * The container reads this as the default (channel_type, platform_id, thread_id)
 * for outbound messages when the agent doesn't specify an explicit destination.
 * Derived from session.messaging_group_id → messaging_groups row + session.thread_id.
 *
 * Called on every container wake alongside the agent-to-agent module's
 * writeDestinations() (when installed) so the latest routing is always in
 * place, including after admin rewiring.
 */
export function writeSessionRouting(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const session = getSession(sessionId);
  if (!session) return;

  let channelType: string | null = null;
  let platformId: string | null = null;
  // Derive the route's host-stamped identity from the session's already-loaded
  // messaging_groups row (per-wake). This is distinct from the per-message
  // values stamped via writeSessionMessage(): session routing carries the
  // single normalized route active for this wake.
  const messagingGroupId: string | null = session.messaging_group_id ?? null;
  let isGroup: 0 | 1 | null = null;
  if (session.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg) {
      channelType = mg.channel_type;
      platformId = mg.platform_id;
      isGroup = mg.is_group === 1 ? 1 : 0;
    }
  }

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    upsertSessionRouting(db, {
      channel_type: channelType,
      platform_id: platformId,
      thread_id: session.thread_id,
      messaging_group_id: messagingGroupId,
      is_group: isGroup,
    });
  } finally {
    db.close();
  }
  log.debug('Session routing written', { sessionId, channelType, platformId, threadId: session.thread_id, isGroup });
}

/**
 * Write a message to a session's inbound DB (messages_in). Host-only.
 *
 * ⚠ Opens and closes the DB on every call. Do not refactor to reuse a
 * long-lived connection — see the "Cross-mount visibility invariants" note
 * at the top of this file.
 */
export function writeSessionMessage(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    timestamp: string;
    platformId?: string | null;
    platformMessageId?: string | null;
    channelType?: string | null;
    threadId?: string | null;
    content: string;
    processAfter?: string | null;
    recurrence?: string | null;
    /**
     * 1 = this message should wake the agent (the default); 0 = accumulate
     * as context only, don't wake. Host's countDueMessages gates on this
     * column; the container still reads all prior messages as context when
     * a trigger-1 message does arrive.
     */
    trigger?: 0 | 1;
    /**
     * Host-stamped route identity for this message. Nullable; a null value is
     * never collapsible onto another route (fail-safe route matching).
     */
    messagingGroupId?: string | null;
    isGroup?: 0 | 1 | null;
  },
): void {
  // Extract base64 attachment data, save to inbox, replace with file paths
  const content = extractAttachmentFiles(agentGroupId, message.id, message.channelType, message.content);

  const hostStamp = buildHostInputStamp(agentGroupId, sessionId, message);

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    insertMessage(db, {
      id: message.id,
      kind: message.kind,
      timestamp: message.timestamp,
      platformId: message.platformId ?? null,
      platformMessageId: message.platformMessageId ?? null,
      channelType: message.channelType ?? null,
      threadId: message.threadId ?? null,
      content,
      processAfter: message.processAfter ?? null,
      recurrence: message.recurrence ?? null,
      trigger: message.trigger ?? 1,
      messagingGroupId: message.messagingGroupId ?? null,
      isGroup: message.isGroup ?? null,
      ...hostStamp,
    });
  } finally {
    db.close();
  }

  updateSession(sessionId, { last_active: new Date().toISOString() });
}

/**
 * If message content has attachments with base64 `data`, save them to
 * the agent group's mounted workspace and add prompt metadata.
 */
function extractAttachmentFiles(
  agentGroupId: string,
  messageId: string,
  channelType: string | null | undefined,
  contentStr: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return contentStr;
  }

  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(attachments)) return contentStr;

  const channel =
    channelType === 'discord' || channelType === 'whatsapp' || channelType === 'agentmail' ? channelType : null;
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) {
    throw new Error(`Cannot materialize attachments: unknown agent group ${agentGroupId}`);
  }

  let changed = false;
  const promptMetadata: string[] = [];
  for (const [idx, att] of attachments.entries()) {
    const originalName =
      (typeof att.name === 'string' && att.name) ||
      (typeof att.filename === 'string' && att.filename) ||
      `attachment-${idx + 1}`;
    if (typeof att.error === 'string') {
      promptMetadata.push(
        formatAttachmentErrorPromptMetadata({
          originalName,
          platformMessageId: messageId,
          error: att.error,
        }),
      );
      changed = true;
      continue;
    }

    if (typeof att.data === 'string') {
      if (!channel) {
        throw new Error(`Cannot materialize attachments for unsupported channel ${channelType ?? '(missing)'}`);
      }
      const materialized = materializeAttachmentData({
        groupsDir: GROUPS_DIR,
        groupFolder: agentGroup.folder,
        channel,
        messageId,
        attachmentId:
          (typeof att.id === 'string' && att.id) ||
          (typeof att.attachmentId === 'string' && att.attachmentId) ||
          `attachment-${idx + 1}`,
        originalName,
        contentType:
          (typeof att.mimeType === 'string' && att.mimeType) ||
          (typeof att.contentType === 'string' && att.contentType) ||
          null,
        data: Buffer.from(att.data, 'base64'),
      });
      const persisted = attachmentForPrompt(materialized);
      Object.assign(att, persisted);
      delete att.data;
      delete att.localPath;
      promptMetadata.push(formatAttachmentPromptMetadata(materialized));
      changed = true;
      log.debug('Saved attachment to group workspace', {
        messageId,
        workspacePath: materialized.workspacePath,
        size: materialized.sizeBytes,
      });
    }
  }

  if (promptMetadata.length > 0) {
    const existingText = typeof parsed.text === 'string' ? parsed.text : '';
    parsed.text = existingText ? `${existingText}\n\n${promptMetadata.join('\n\n')}` : promptMetadata.join('\n\n');
    changed = true;
  }

  return changed ? JSON.stringify(parsed) : contentStr;
}

function attachmentForPrompt(att: MaterializedAttachment): Record<string, unknown> {
  return {
    workspacePath: att.workspacePath,
    originalName: att.originalName,
    safeName: att.safeName,
    contentType: att.contentType,
    sizeBytes: att.sizeBytes,
    platformMessageId: att.platformMessageId,
  };
}

/** Open the inbound DB for a session (host reads/writes). */
export function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  // Inbound schema self-heal (messages_in + session_routing) lives in the raw
  // opener in db/session-db.ts so every host inbound open migrates forward.
  return openInboundDbRaw(inboundDbPath(agentGroupId, sessionId));
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRaw(outboundDbPath(agentGroupId, sessionId));
}

/**
 * R9: read-only outbound open that heals a crashed container's hot journal.
 * CALLER CONTRACT: only call from sites that verified the session's container
 * is not running (gated sweep path) — never from the 1s delivery poll.
 */
export function openOutboundDbHealing(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbReadOnlyHealing(outboundDbPath(agentGroupId, sessionId), (dbPath) => {
    log.error('Hot outbound journal detected; performing gated write-mode rollback', {
      agentGroupId,
      sessionId,
      dbPath,
    });
  });
}

/** Open the outbound DB for a session with write access. Only safe to call when no container is running. */
export function openOutboundDbRw(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRwRaw(outboundDbPath(agentGroupId, sessionId));
}

/**
 * Write a message directly to a session's outbound DB so the host delivery
 * loop picks it up. Used by the command gate to send denial responses
 * without waking a container.
 */
export function writeOutboundDirect(
  agentGroupId: string,
  sessionId: string,
  message: {
    id: string;
    kind: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  },
): void {
  const db = openOutboundDbForWrite(outboundDbPath(agentGroupId, sessionId));
  try {
    db.prepare(
      `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'), ?, ?, ?, ?, ?)`,
    ).run(message.id, message.kind, message.platformId, message.channelType, message.threadId, message.content);
  } finally {
    db.close();
  }
}

/**
 * @deprecated Use openInboundDb / openOutboundDb instead.
 */
export function openSessionDb(agentGroupId: string, sessionId: string): Database.Database {
  return openInboundDb(agentGroupId, sessionId);
}

/** Write a system response to a session's inbound.db so the container's findQuestionResponse() picks it up. */
export function writeSystemResponse(
  agentGroupId: string,
  sessionId: string,
  requestId: string,
  status: string,
  result: Record<string, unknown>,
): void {
  writeSessionMessage(agentGroupId, sessionId, {
    id: `sys-resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      type: 'question_response',
      questionId: requestId,
      status,
      result,
    }),
  });
}

/**
 * Load outbox attachments for a delivered message.
 *
 * Symmetric with `extractAttachmentFiles` on the inbound side: the container
 * writes files into the session's `outbox/<messageId>/` directory alongside
 * its `messages_out` row, and the host reads them back at delivery time.
 *
 * Returns undefined when the outbox dir is missing or no declared file was
 * actually on disk — delivery continues without attachments rather than
 * failing the whole message.
 */
export function readOutboxFiles(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  filenames: string[],
): OutboundFile[] | undefined {
  const outboxDir = path.join(sessionDir(agentGroupId, sessionId), 'outbox', messageId);
  if (!fs.existsSync(outboxDir)) return undefined;
  const files: OutboundFile[] = [];
  for (const filename of filenames) {
    const filePath = path.join(outboxDir, filename);
    if (fs.existsSync(filePath)) {
      files.push({ filename, data: fs.readFileSync(filePath) });
    } else {
      log.warn('Outbox file not found', { messageId, filename });
    }
  }
  return files.length > 0 ? files : undefined;
}

/**
 * Remove a message's outbox directory after successful delivery. Best-effort:
 * failures log and swallow. A cleanup failure must NOT propagate to the
 * delivery caller — the message is already on the user's screen, and a
 * thrown error would trigger the delivery retry path and deliver twice.
 */
export function clearOutbox(agentGroupId: string, sessionId: string, messageId: string): void {
  const outboxDir = path.join(sessionDir(agentGroupId, sessionId), 'outbox', messageId);
  if (!fs.existsSync(outboxDir)) return;
  try {
    fs.rmSync(outboxDir, { recursive: true, force: true });
  } catch (err) {
    log.warn('Outbox cleanup failed (message already delivered)', { messageId, err });
  }
}

/** Mark a container as running for a session. */
export function markContainerRunning(sessionId: string): void {
  updateSession(sessionId, { container_status: 'running', last_active: new Date().toISOString() });
}

/** Mark a container as idle for a session. */
export function markContainerIdle(sessionId: string): void {
  updateSession(sessionId, { container_status: 'idle' });
}

/** Mark a container as stopped for a session. */
export function markContainerStopped(sessionId: string): void {
  updateSession(sessionId, { container_status: 'stopped' });
}
