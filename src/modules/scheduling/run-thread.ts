/**
 * Per-run result threads for scheduled tasks.
 *
 * A scheduled task may declare a `headline` — a short line the host posts to
 * the channel the first time the run produces a user-visible message. The
 * host then opens a platform thread on that headline message and delivers
 * every later message of the same run into it, so a chatty nightly run takes
 * one line in the channel instead of five.
 *
 * Three properties this deliberately has:
 *   - Opt-in. No headline on the task, no anchoring; delivery is unchanged.
 *   - Lazy. A run that produces nothing never posts a headline.
 *   - Fail-open. Anything that goes wrong here degrades to delivering the
 *     message in the channel exactly as before.
 *
 * Correlating an outbound row to the run that produced it uses three signals,
 * in order: the row's `in_reply_to` (the poll loop stamps the projected task
 * message id on result text, relay rows and inactivity notices), the
 * container's live `processing_ack` claim (covers rows written by
 * `send_message`, which carry no `in_reply_to`), and a short stickiness
 * window for stragglers delivered just after the run acked completion. The
 * window closes as soon as a real inbound message lands, so a conversation
 * that starts after the run never leaks into last night's thread.
 */
import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import type { ChannelDeliveryAdapter, OutboundThreadContext } from '../../delivery.js';
import { log } from '../../log.js';

/** How long after a run's last known activity a straggler still joins its thread. */
const STRAGGLER_WINDOW_MS = 5 * 60_000;

/** Runs whose thread could not be opened -- don't post a second orphan headline for them. */
const failedRuns = new Set<string>();

interface RunThreadRow {
  session_id: string;
  task_message_id: string;
  channel_type: string;
  platform_id: string;
  anchor_message_id: string;
  thread_id: string;
  created_at: string;
}

function getRunThread(sessionId: string, taskMessageId: string): RunThreadRow | undefined {
  return getDb()
    .prepare('SELECT * FROM scheduled_run_threads WHERE session_id = ? AND task_message_id = ?')
    .get(sessionId, taskMessageId) as RunThreadRow | undefined;
}

function latestRunThread(sessionId: string): RunThreadRow | undefined {
  return getDb()
    .prepare('SELECT * FROM scheduled_run_threads WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(sessionId) as RunThreadRow | undefined;
}

function saveRunThread(row: RunThreadRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO scheduled_run_threads
         (session_id, task_message_id, channel_type, platform_id, anchor_message_id, thread_id, created_at)
       VALUES (@session_id, @task_message_id, @channel_type, @platform_id, @anchor_message_id, @thread_id, @created_at)`,
    )
    .run(row);
}

/** The projected scheduled-task row for this inbound id, if it is one. */
function taskProjection(inDb: Database.Database, messageId: string): { content: string } | undefined {
  return inDb.prepare("SELECT content FROM messages_in WHERE id = ? AND kind = 'task'").get(messageId) as
    | { content: string }
    | undefined;
}

/** Task message ids the container currently holds a processing claim on. */
function claimedTaskIds(outDb: Database.Database, inDb: Database.Database): string[] {
  let claims: Array<{ message_id: string }>;
  try {
    claims = outDb
      .prepare("SELECT message_id FROM processing_ack WHERE status = 'processing' ORDER BY status_changed DESC")
      .all() as Array<{ message_id: string }>;
  } catch {
    return []; // Older session DB without processing_ack -- nothing claimed.
  }
  return claims.map((c) => c.message_id).filter((id) => taskProjection(inDb, id) !== undefined);
}

/** True when a real (non-task) inbound message arrived after the given time. */
function hasInboundSince(inDb: Database.Database, since: string): boolean {
  const row = inDb
    .prepare("SELECT 1 AS hit FROM messages_in WHERE kind <> 'task' AND timestamp > ? LIMIT 1")
    .get(since) as { hit: number } | undefined;
  return row !== undefined;
}

function activeTaskMessageId(ctx: OutboundThreadContext): string | null {
  const { inDb, outDb, message, session } = ctx;

  if (message.inReplyTo && taskProjection(inDb, message.inReplyTo)) return message.inReplyTo;

  const claimed = claimedTaskIds(outDb, inDb);
  if (claimed.length > 0) return claimed[0];

  // Straggler: the run acked completion between the container writing this
  // row and the delivery poll reaching it.
  const recent = latestRunThread(session.id);
  if (!recent) return null;
  if (Date.now() - Date.parse(recent.created_at) > STRAGGLER_WINDOW_MS) return null;
  if (hasInboundSince(inDb, recent.created_at)) return null;
  return recent.task_message_id;
}

/** The short line a task wants posted above its run output, if it declared one. */
function headlineForTask(inDb: Database.Database, taskMessageId: string): string | null {
  const row = taskProjection(inDb, taskMessageId);
  if (!row) return null;
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(row.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const headline = content.headline;
  if (typeof headline !== 'string') return null;
  const trimmed = headline.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function canOpenThreads(adapter: ChannelDeliveryAdapter, channelType: string): boolean {
  if (typeof adapter.openThread !== 'function') return false;
  return adapter.canOpenThread?.(channelType) ?? true;
}

/**
 * Thread to deliver this outbound message into, or null to deliver it in the
 * channel as usual. Posts the run's headline and opens its thread on first use.
 */
export async function resolveScheduledRunThread(ctx: OutboundThreadContext): Promise<string | null> {
  const { session, message, inDb, adapter } = ctx;

  const taskMessageId = activeTaskMessageId(ctx);
  if (!taskMessageId) return null;

  const existing = getRunThread(session.id, taskMessageId);
  if (existing) {
    const sameRoute = existing.channel_type === message.channelType && existing.platform_id === message.platformId;
    return sameRoute ? existing.thread_id : null;
  }

  const runKey = `${session.id} ${taskMessageId}`;
  if (failedRuns.has(runKey)) return null;

  const headline = headlineForTask(inDb, taskMessageId);
  if (!headline) return null;

  if (!canOpenThreads(adapter, message.channelType)) {
    // Posting the headline here would leave an orphan line in the channel
    // with nothing under it -- worse than the clutter we are removing.
    log.info('Scheduled run headline skipped: channel cannot open threads', {
      sessionId: session.id,
      taskMessageId,
      channelType: message.channelType,
    });
    failedRuns.add(runKey);
    return null;
  }

  const anchorMessageId = await adapter.deliver(
    message.channelType,
    message.platformId,
    null,
    'chat',
    JSON.stringify({ text: headline }),
  );
  if (!anchorMessageId) {
    log.warn('Scheduled run headline delivered without a platform message id; not threading', {
      sessionId: session.id,
      taskMessageId,
    });
    failedRuns.add(runKey);
    return null;
  }

  const threadId = await adapter.openThread!(message.channelType, message.platformId, anchorMessageId, headline);
  if (!threadId) {
    failedRuns.add(runKey);
    log.warn('Could not open a thread on the scheduled run headline; delivering in the channel', {
      sessionId: session.id,
      taskMessageId,
      anchorMessageId,
    });
    return null;
  }

  saveRunThread({
    session_id: session.id,
    task_message_id: taskMessageId,
    channel_type: message.channelType,
    platform_id: message.platformId,
    anchor_message_id: anchorMessageId,
    thread_id: threadId,
    created_at: new Date().toISOString(),
  });
  log.info('Opened scheduled run thread', {
    sessionId: session.id,
    taskMessageId,
    anchorMessageId,
    threadId,
    messageOutId: message.id,
  });
  return threadId;
}

/** Test seam: the failed-run memo is process-local, not durable state. */
export function clearRunThreadMemoForTest(): void {
  failedRuns.clear();
}
