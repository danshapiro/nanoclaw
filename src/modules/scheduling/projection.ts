import type Database from 'better-sqlite3';

import { nextEvenSeq } from '../../db/session-db.js';
import type { RuntimeLockOwner } from '../../db/runtime-locks.js';
import { markTaskProjected, type ScheduledTaskRow } from './ledger.js';

const LIVE_PROJECTION_STATUSES = ['pending', 'paused', 'processing'];

export function projectionMessageId(task: Pick<ScheduledTaskRow, 'series_id' | 'generation'>): string {
  return `task-${task.series_id}-g${task.generation}`;
}

export function projectScheduledTask(
  inDb: Database.Database,
  task: ScheduledTaskRow,
  sessionId: string,
  owner: RuntimeLockOwner,
): string {
  const messageId = projectionMessageId(task);
  const writeProjection = inDb.transaction(() => {
    const existing = inDb.prepare('SELECT id, kind FROM messages_in WHERE id = ?').get(messageId) as
      | { id: string; kind: string }
      | undefined;
    const timestamp = new Date().toISOString();

    if (existing && existing.kind !== 'task') {
      throw new Error(`Projection id ${messageId} already exists as kind=${existing.kind}; refusing to overwrite`);
    }

    inDb
      .prepare(
        `UPDATE messages_in
         SET status = 'completed',
             recurrence = NULL
         WHERE kind = 'task'
           AND series_id = @seriesId
           AND id <> @messageId
           AND status IN ('pending', 'paused', 'processing')`,
      )
      .run({ seriesId: task.series_id, messageId });

    if (!existing) {
      inDb
        .prepare(
          `INSERT INTO messages_in (
             id,
             seq,
             kind,
             timestamp,
             status,
             process_after,
             recurrence,
             trigger,
             platform_id,
             channel_type,
             thread_id,
             messaging_group_id,
             is_group,
             content,
             series_id
           ) VALUES (
             @id,
             @seq,
             'task',
             @timestamp,
             @status,
             @processAfter,
             @recurrence,
             1,
             @platformId,
             @channelType,
             @threadId,
             @messagingGroupId,
             @isGroup,
             @content,
             @seriesId
           )`,
        )
        .run({
          id: messageId,
          seq: nextEvenSeq(inDb),
          timestamp,
          status: task.status,
          processAfter: task.process_after,
          recurrence: task.recurrence,
          platformId: task.platform_id,
          channelType: task.channel_type,
          threadId: task.thread_id,
          messagingGroupId: task.messaging_group_id,
          isGroup: task.is_group,
          content: task.content,
          seriesId: task.series_id,
        });
    } else {
      inDb
        .prepare(
          `UPDATE messages_in
           SET status = @status,
               process_after = @processAfter,
               recurrence = @recurrence,
               platform_id = @platformId,
               channel_type = @channelType,
               thread_id = @threadId,
               messaging_group_id = @messagingGroupId,
               is_group = @isGroup,
               content = @content,
               series_id = @seriesId,
               trigger = 1
           WHERE id = @id
             AND kind = 'task'`,
        )
        .run({
          id: messageId,
          status: task.status,
          processAfter: task.process_after,
          recurrence: task.recurrence,
          platformId: task.platform_id,
          channelType: task.channel_type,
          threadId: task.thread_id,
          messagingGroupId: task.messaging_group_id,
          isGroup: task.is_group,
          content: task.content,
          seriesId: task.series_id,
        });
    }
  });
  writeProjection();

  markTaskProjected(task.agent_group_id, task.series_id, sessionId, messageId, owner);
  return messageId;
}

export function retireProjection(inDb: Database.Database, seriesId: string): number {
  const placeholders = LIVE_PROJECTION_STATUSES.map(() => '?').join(', ');
  const result = inDb
    .prepare(
      `UPDATE messages_in
       SET status = 'completed',
           recurrence = NULL
       WHERE kind = 'task'
         AND series_id = ?
         AND status IN (${placeholders})`,
    )
    .run(seriesId, ...LIVE_PROJECTION_STATUSES);
  return result.changes;
}

export function clearCompletedProjectionRecurrence(inDb: Database.Database, messageId: string): void {
  inDb.prepare('UPDATE messages_in SET recurrence = NULL WHERE id = ? AND kind = ?').run(messageId, 'task');
}
