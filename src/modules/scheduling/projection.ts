import type Database from 'better-sqlite3';

import { nextEvenSeq } from '../../db/session-db.js';
import type { RuntimeLockOwner } from '../../db/runtime-locks.js';
import { buildHostInputStamp } from '../../session-manager.js';
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
  const timestamp = new Date().toISOString();
  const hostStamp = buildHostInputStamp(
    task.agent_group_id,
    sessionId,
    {
      id: messageId,
      platformId: task.platform_id,
      channelType: task.channel_type,
      threadId: task.thread_id,
      messagingGroupId: task.messaging_group_id,
      isGroup: task.is_group,
    },
    timestamp,
  );
  const writeProjection = inDb.transaction(() => {
    const existing = inDb.prepare('SELECT id, kind FROM messages_in WHERE id = ?').get(messageId) as
      | { id: string; kind: string }
      | undefined;

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
             host_input_id,
             host_route_key,
             host_received_at,
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
             @hostInputId,
             @hostRouteKey,
             @hostReceivedAt,
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
          ...hostStamp,
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
               host_input_id = CASE WHEN host_accepted_at IS NULL THEN @hostInputId ELSE host_input_id END,
               host_route_key = CASE WHEN host_accepted_at IS NULL THEN @hostRouteKey ELSE host_route_key END,
               host_received_at = CASE WHEN host_accepted_at IS NULL THEN @hostReceivedAt ELSE host_received_at END,
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
          ...hostStamp,
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
