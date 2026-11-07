/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied into the
 * target's inbound DB; if the source message had `files` (from `send_file`),
 * the actual bytes are copied from the source's outbox into the target's
 * `inbox/<a2a-msg-id>/` directory and surfaced to the target agent as
 * `attachments` (existing formatter convention — see formatter.ts:230).
 * The target agent can then forward the file onward via its own `send_file`
 * call using the absolute `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import {
  openInboundDb,
  readOutboxFiles,
  resolveSession,
  sessionDir,
  writeSessionMessage,
} from '../../session-manager.js';
import { DeliveryUnavailableError } from '../../delivery-errors.js';
import type { Session } from '../../types.js';
import { hasDestination } from './db/agent-destinations.js';

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Is `name` safe to use as the last segment of a path inside the target
 * agent's inbox directory? Filenames arrive in messages_out content from
 * the source agent — under a multi-agent setup with heterogenous providers
 * (or a compromised / hallucinating sub-agent) they can't be trusted.
 *
 * Rejects:
 *   - empty string
 *   - `.` / `..` (traversal sentinels that path.basename returns as-is)
 *   - anything containing a path separator (`/` or `\`) or NUL
 *   - any value where `path.basename(name) !== name`, catching OS-specific
 *     separators and covering drives/prefixes on Windows runtimes
 */
export function isSafeAttachmentName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/\0]/.test(name)) return false;
  return path.basename(name) === name;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * All declared attachments must be safe and readable before any message is
 * inserted. A partial transfer is an error, never an acknowledged route.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  for (const filename of source.filenames) {
    if (!isSafeAttachmentName(filename)) {
      throw new DeliveryUnavailableError(`Unsafe agent attachment name for message ${source.messageId}`, false);
    }
  }
  const files = readOutboxFiles(source.agentGroupId, source.sessionId, source.messageId, source.filenames);
  const targetInboxDir = path.join(sessionDir(target.agentGroupId, target.sessionId), 'inbox', target.messageId);
  fs.mkdirSync(targetInboxDir, { recursive: true });
  return files.map(({ filename, data }) => {
    const dst = path.join(targetInboxDir, filename);
    const fd = fs.openSync(
      dst,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    return { name: filename, filename, type: 'file' as const, localPath: `inbox/${target.messageId}/${filename}` };
  });
}

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  content: string;
}

export async function routeAgentMessage(msg: RoutableAgentMessage, session: Session): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }
  if (
    targetAgentGroupId !== session.agent_group_id &&
    !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)
  ) {
    throw new Error(
      `unauthorized agent-to-agent: ${session.agent_group_id} has no destination for ${targetAgentGroupId}`,
    );
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
  }
  // The source-owned ledger fixes the target session before inserting any
  // message. Replays after a wake failure reuse that session and message ID.
  const sourceDb = openInboundDb(session.agent_group_id, session.id);
  let targetSessionId: string;
  try {
    sourceDb.exec(`CREATE TABLE IF NOT EXISTS agent_route_targets (
      message_out_id TEXT PRIMARY KEY,
      target_agent_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL
    )`);
    let route = sourceDb
      .prepare('SELECT target_agent_id, target_session_id FROM agent_route_targets WHERE message_out_id = ?')
      .get(msg.id) as { target_agent_id: string; target_session_id: string } | undefined;
    if (!route) {
      const { session: target } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');
      sourceDb
        .prepare('INSERT OR IGNORE INTO agent_route_targets VALUES (?, ?, ?)')
        .run(msg.id, targetAgentGroupId, target.id);
      route = sourceDb
        .prepare('SELECT target_agent_id, target_session_id FROM agent_route_targets WHERE message_out_id = ?')
        .get(msg.id) as { target_agent_id: string; target_session_id: string };
    }
    if (route.target_agent_id !== targetAgentGroupId) throw new Error(`Agent route target changed for ${msg.id}`);
    targetSessionId = route.target_session_id;
  } finally {
    sourceDb.close();
  }
  const targetSession = getSession(targetSessionId);
  if (!targetSession || targetSession.status !== 'active' || targetSession.agent_group_id !== targetAgentGroupId) {
    throw new DeliveryUnavailableError(`Agent route target session is inactive or missing for ${msg.id}`, false);
  }
  const a2aMsgId =
    'a2a-' +
    createHash('sha256')
      .update(JSON.stringify([session.agent_group_id, session.id, msg.id, targetAgentGroupId]))
      .digest('hex');
  const targetDb = openInboundDb(targetAgentGroupId, targetSession.id);
  let alreadyInserted: boolean;
  try {
    alreadyInserted = !!targetDb.prepare('SELECT 1 FROM messages_in WHERE id = ?').get(a2aMsgId);
  } finally {
    targetDb.close();
  }
  if (!alreadyInserted) {
    const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);
    writeSessionMessage(targetAgentGroupId, targetSession.id, {
      id: a2aMsgId,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: forwardedContent,
    });
    log.info('Agent message routed', {
      from: session.agent_group_id,
      to: targetAgentGroupId,
      targetSession: targetSession.id,
      a2aMsgId,
      forwardedFileCount: countForwardedFiles(forwardedContent),
    });
  }

  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (files === undefined) return msg.content;
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
    throw new DeliveryUnavailableError(`Invalid agent attachment list for message ${msg.id}`, false);
  }
  if (files.length === 0) return msg.content;
  const filenames = files as string[];

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}
