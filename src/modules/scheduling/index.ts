/**
 * Scheduling module — one-shot and recurring tasks.
 *
 * Registers:
 *   - Five delivery action handlers: schedule_task, cancel_task, pause_task,
 *     resume_task, update_task. The container's scheduling MCP tools
 *     (container/agent-runner/src/mcp-tools/scheduling.ts) write system
 *     messages with these actions; the host applies them to the central
 *     scheduler ledger and projects live tasks into inbound.db.
 *
 * Host integration points (filled by MODULE-HOOK markers, validated here
 * with the scheduling module shipping inline):
 *   - `src/host-sweep.ts` syncs completed/failed projected tasks back into
 *     the central scheduler ledger and projects the next due generation.
 *   - `container/agent-runner/src/poll-loop.ts` → MODULE-HOOK:scheduling-pre-task
 *     runs `applyPreTaskScripts` before the provider call so tasks carrying
 *     a pre-agent script can gate their own execution.
 *
 * Durable scheduler intent lives in central scheduler tables. Per-session
 * `messages_in.kind='task'` rows are active-session projections.
 */
import { registerDeliveryAction } from '../../delivery.js';
import {
  handleCancelTask,
  handlePauseTask,
  handleResumeTask,
  handleScheduleTask,
  handleUpdateTask,
} from './actions.js';

registerDeliveryAction('schedule_task', handleScheduleTask);
registerDeliveryAction('cancel_task', handleCancelTask);
registerDeliveryAction('pause_task', handlePauseTask);
registerDeliveryAction('resume_task', handleResumeTask);
registerDeliveryAction('update_task', handleUpdateTask);
