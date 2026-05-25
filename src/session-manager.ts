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
import fs from 'fs';
import path from 'path';

import type { OutboundFile } from './channels/adapter.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import {
  archiveSession,
  createSession,
  findSessionByAgentGroup,
  findSessionForAgent,
  getSession,
  updateSession,
} from './db/sessions.js';
import {
  ensureSchema,
  openInboundDb as openInboundDbRaw,
  openOutboundDb as openOutboundDbRaw,
  openOutboundDbRw as openOutboundDbRwRaw,
  openOutboundDbForWrite,
  upsertSessionRouting,
  insertMessage,
  migrateMessagesInTable,
} from './db/session-db.js';
import { log } from './log.js';
import type { Session } from './types.js';
import {
  formatAttachmentErrorPromptMetadata,
  formatAttachmentPromptMetadata,
  materializeAttachmentData,
  type MaterializedAttachment,
} from './yente/attachments.js';

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
  if (session.messaging_group_id) {
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg) {
      channelType = mg.channel_type;
      platformId = mg.platform_id;
    }
  }

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    upsertSessionRouting(db, {
      channel_type: channelType,
      platform_id: platformId,
      thread_id: session.thread_id,
    });
  } finally {
    db.close();
  }
  log.debug('Session routing written', { sessionId, channelType, platformId, threadId: session.thread_id });
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
  },
): void {
  // Extract base64 attachment data, save to inbox, replace with file paths
  const content = extractAttachmentFiles(agentGroupId, message.id, message.channelType, message.content);

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

  const channel = channelType === 'discord' || channelType === 'whatsapp' ? channelType : null;
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
  const db = openInboundDbRaw(inboundDbPath(agentGroupId, sessionId));
  migrateMessagesInTable(db);
  return db;
}

/** Open the outbound DB for a session (host reads only). */
export function openOutboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return openOutboundDbRaw(outboundDbPath(agentGroupId, sessionId));
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
