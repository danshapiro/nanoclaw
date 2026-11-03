import fs from 'node:fs';
import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { listRecoveryEntries } from './db/session-state.js';
import { normalizeRoute } from './formatter.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, QueryTurnInput } from './providers/types.js';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error('scenario timed out');
    await pause(20);
  }
}

export async function runStopTypingScenario() {
  initTestSessionDb();
  const route = {
    platformId: 'channel',
    channelType: 'discord',
    threadId: null,
    messagingGroupId: 'dm',
    isGroup: 0 as const,
  };
  const routeKey = normalizeRoute('test', route).routeKey;
  const insert = (id: string, text: string, thread: string) => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in
      (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, messaging_group_id,
       is_group, host_input_id, host_route_key, host_received_at, content)
      VALUES (?, 'chat-sdk', datetime('now'), 'pending', 1, 'channel', 'discord', ?, 'dm', 0, ?, ?, datetime('now'), ?)`,
      )
      .run(id, thread, `input-${id}`, routeKey, JSON.stringify({ sender: 'User', text }));
  };
  let pushed: QueryTurnInput | undefined;
  let abortRequested = false;
  let lateAccepted = false;
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const provider: AgentProvider = {
    supportsNativeSlashCommands: false,
    isSessionInvalid: () => false,
    query(input) {
      return {
        push(turn) {
          if (typeof turn !== 'string') pushed = turn;
        },
        end() {},
        async abort() {
          abortRequested = true;
        },
        events: (async function* () {
          await input.acceptInput();
          yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
          await waitFor(() => abortRequested);
          await pushed!.acceptInput!();
          yield { type: 'input-accepted', inputId: pushed!.inputId, scope: 'followup' };
          lateAccepted = true;
          await cleanup;
        })(),
      };
    },
  };
  const snapshots: Array<Array<{ platformId: string; threadId: string | null }>> = [];
  let clearBeforeAck = false;
  const bound: string[] = [];
  const released: string[] = [];
  const controller = new AbortController();
  insert('initial', 'start', 'initial-thread');
  const loop = runPollLoop({
    provider,
    providerName: 'test',
    cwd: '/tmp',
    signal: controller.signal,
    bindGwsCorrelation: async (id) => {
      bound.push(id);
    },
    releaseGwsCorrelation: async (id) => {
      released.push(id);
    },
    publishTypingActivity: (targets) => {
      if (!targets.length && snapshots.length && !snapshots.some((snapshot) => !snapshot.length)) {
        clearBeforeAck = !getUndeliveredMessages().some((row) => JSON.parse(row.content).text.includes('Stopped'));
      }
      snapshots.push(targets);
    },
  });
  let result:
    | {
        ack: NonNullable<ReturnType<typeof getUndeliveredMessages>[number]>;
        afterStopSnapshots: typeof snapshots;
        pendingLater: boolean;
        pushedId: string | undefined;
        bound: string[];
        released: string[];
        completed: string[];
        recoveryCount: number;
        clearBeforeAck: boolean;
      }
    | undefined;
  try {
    await waitFor(() => snapshots.length > 0);
    insert('pushed', 'follow up', 'pushed-thread');
    await waitFor(() => Boolean(pushed));
    insert('pending', 'also do this', 'pending-thread');
    insert('stop', '/stop', 'stop-thread');
    await waitFor(() => abortRequested && lateAccepted);
    const stopSnapshotIndex = snapshots.findIndex((targets) => targets.length === 0);
    const ack = getUndeliveredMessages().find((row) => JSON.parse(row.content).text.includes('Stopped'));
    if (!ack || stopSnapshotIndex < 0) throw new Error('missing stop acknowledgement or activity clear');
    insert('later', 'new request', 'later-thread');
    await pause(5200);
    const pendingLater = !getOutboundDb()
      .prepare('SELECT message_id FROM processing_ack WHERE message_id = ?')
      .get('later');
    result = {
      ack,
      afterStopSnapshots: snapshots.slice(stopSnapshotIndex + 1),
      pendingLater,
      pushedId: pushed?.inputId,
      bound,
      released,
      completed: [],
      recoveryCount: -1,
      clearBeforeAck,
    };
  } finally {
    controller.abort();
    releaseCleanup();
    await loop.catch(() => {});
    if (result) {
      result.completed = (
        getOutboundDb()
          .prepare("SELECT message_id FROM processing_ack WHERE status = 'completed' ORDER BY message_id")
          .all() as Array<{ message_id: string }>
      ).map((row) => row.message_id);
      result.recoveryCount = listRecoveryEntries({
        providerName: 'test',
        ...route,
        routeKey,
        threadKey: `dm:${route.messagingGroupId}`,
      }).length;
    }
    closeSessionDb();
  }
  return result!;
}

if (import.meta.main) {
  const result = await runStopTypingScenario();
  fs.writeFileSync(process.argv[2], JSON.stringify(result));
}
