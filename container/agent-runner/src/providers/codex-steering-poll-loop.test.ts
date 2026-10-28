import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { listRecoveryEntries } from '../db/session-state.js';
import { normalizeRoute } from '../formatter.js';
import { runPollLoop } from '../poll-loop.js';
import type { AppServer, JsonRpcNotification, JsonRpcResponse } from './codex-app-server.js';
import { CodexProvider } from './codex.js';
import type { AgentProvider, ProviderEvent } from './types.js';

const scope = {
  providerName: 'codex',
  routeKey: normalizeRoute('codex', {
    channelType: 'discord',
    platformId: 'chan-steering',
    threadId: null,
    messagingGroupId: null,
    isGroup: null,
  }).routeKey,
  channelType: 'discord',
  platformId: 'chan-steering',
  threadKey: null,
  messagingGroupId: null,
  isGroup: null,
};

type Request = { id: number; method: string; params: Record<string, unknown> };

async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('Timed out waiting for steering lifecycle');
    await Bun.sleep(1);
  }
}

function insertMessage(id: string, text: string, trigger: 0 | 1): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, kind, timestamp, status, trigger, platform_id, channel_type,
        host_input_id, host_route_key, host_received_at, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?, ?, datetime('now'), ?)`,
    )
    .run(
      id,
      trigger,
      scope.platformId,
      scope.channelType,
      `host-${id}`,
      scope.routeKey,
      JSON.stringify({ sender: 'User', text }),
    );
}

function ackStatus(id: string): string | undefined {
  return (
    getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined
  )?.status;
}

function harness(
  options: {
    steerError?: { code: number; message: string };
    followupGate?: Promise<void>;
    holdSteerResponse?: boolean;
  } = {},
) {
  const requests: Request[] = [];
  const events: ProviderEvent[] = [];
  const bindings: Array<{ inputId: string; scope: string }> = [];
  let turnNumber = 0;
  const server = {
    process: {
      stdin: {
        write(line: string) {
          const request = JSON.parse(line) as Request;
          requests.push(request);
          queueMicrotask(() => {
            if (request.method === 'turn/start') {
              const id = `turn-${++turnNumber}`;
              notify('turn/started', { threadId: 'thread-steering', turn: { id } });
              respond(request, { result: { turn: { id } } });
            } else if (request.method === 'turn/steer') {
              if (options.holdSteerResponse) return;
              respond(
                request,
                options.steerError ? { error: options.steerError } : { result: { turnId: `turn-${turnNumber}` } },
              );
            } else if (request.method === 'turn/interrupt') {
              respond(request, { result: {} });
              notify('turn/completed', {
                threadId: 'thread-steering',
                turn: { id: `turn-${turnNumber}`, status: 'interrupted' },
              });
            }
          });
          return true;
        },
      },
    },
    pending: new Map(),
    notificationHandlers: [] as Array<(notification: JsonRpcNotification) => void>,
    serverRequestHandlers: [],
    readline: { close() {} },
  } as unknown as AppServer;
  function notify(method: string, params: Record<string, unknown>): void {
    for (const handler of [...server.notificationHandlers]) handler({ method, params });
  }
  function respond(request: Request, response: Omit<JsonRpcResponse, 'id'>): void {
    const pending = server.pending.get(request.id);
    if (!pending) return;
    server.pending.delete(request.id);
    pending.resolve({ id: request.id, ...response });
  }
  const codex = new CodexProvider(
    { env: { CODEX_MODEL: 'test-model' } },
    {
      syncManagedSkillLinks: () => [],
      writeMcpConfig: () => {},
      createConfigOverrides: () => [],
      spawnServer: () => server,
      attachAutoApproval: () => {},
      initializeServer: async () => {},
      startThread: async () => 'thread-steering',
      terminateServer: async () => {},
    },
  );
  // Observe the production provider stream without changing acceptance or resolution.
  const provider: AgentProvider = {
    supportsNativeSlashCommands: codex.supportsNativeSlashCommands,
    isSessionInvalid: codex.isSessionInvalid.bind(codex),
    query(input) {
      const query = codex.query(input);
      return {
        ...query,
        events: (async function* () {
          for await (const event of query.events) {
            events.push(event);
            yield event;
          }
        })(),
      };
    },
  };
  insertMessage('initial', 'Long task', 1);
  const controller = new AbortController();
  const loop = runPollLoop({
    provider,
    providerName: 'codex',
    cwd: '/tmp',
    signal: controller.signal,
    bindGwsCorrelation: async (inputId, _routeKey, _messageIds, _claimToken, acceptanceScope) => {
      bindings.push({ inputId, scope: acceptanceScope });
      if (acceptanceScope === 'followup') await options.followupGate;
    },
    releaseGwsCorrelation: async () => {},
  });
  return {
    requests,
    events,
    bindings,
    acknowledgeSteer() {
      const request = requests.find((candidate) => candidate.method === 'turn/steer');
      if (!request) throw new Error('No steer request to acknowledge');
      respond(request, { result: { turnId: `turn-${turnNumber}` } });
    },
    complete() {
      notify('item/completed', {
        threadId: 'thread-steering',
        item: { type: 'agentMessage', text: '<message to="discord-steering">Task complete.</message>' },
      });
      notify('turn/completed', {
        threadId: 'thread-steering',
        turn: { id: `turn-${turnNumber}`, status: 'completed' },
      });
    },
    async stop() {
      controller.abort();
      await loop;
    },
  };
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-steering', 'discord-steering', 'channel', ?, ?, NULL)`,
    )
    .run(scope.channelType, scope.platformId);
});
afterEach(() => closeSessionDb());

describe('Codex steering with accumulate-only host claims', () => {
  it('waits for native steer acknowledgement before completing either shared-input claim', async () => {
    const h = harness({ holdSteerResponse: true });
    try {
      await waitFor(() => h.requests.some((request) => request.method === 'turn/start'));
      insertMessage('context', 'Additional details consumed by the active turn', 0);
      await waitFor(() => h.requests.some((request) => request.method === 'turn/steer'));
      const activitiesBeforeCompletion = h.events.filter((event) => event.type === 'activity').length;
      h.complete();
      await waitFor(
        () => h.events.filter((event) => event.type === 'activity').length >= activitiesBeforeCompletion + 2,
      );
      expect(ackStatus('initial')).toBe('processing');
      expect(ackStatus('context')).toBe('processing');
      h.acknowledgeSteer();
      await waitFor(() => ackStatus('context') === 'completed');
      expect(ackStatus('initial')).toBe('completed');
      expect(h.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
      expect(listRecoveryEntries(scope)).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });

  it('keeps a known rejected steer unresolved until its deferred native turn finishes', async () => {
    const h = harness({ steerError: { code: -32600, message: 'no active turn to steer' } });
    try {
      await waitFor(() => h.requests.some((request) => request.method === 'turn/start'));
      insertMessage('context', 'Additional details', 0);
      await waitFor(() => h.requests.some((request) => request.method === 'turn/steer'));
      h.complete();
      await waitFor(() => h.requests.filter((request) => request.method === 'turn/start').length === 2);
      expect(ackStatus('initial')).toBe('completed');
      expect(ackStatus('context')).toBe('processing');
      h.complete();
      await waitFor(() => ackStatus('context') === 'completed');
      expect(h.bindings).toEqual([
        { inputId: 'host-initial', scope: 'initial' },
        { inputId: 'host-initial', scope: 'followup' },
      ]);
      expect(listRecoveryEntries(scope)).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });

  it('keeps the exact follow-up claim unresolved when completion wins its trusted gate', async () => {
    let release!: () => void;
    const followupGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ followupGate });
    try {
      await waitFor(() => h.requests.some((request) => request.method === 'turn/start'));
      insertMessage('context', 'Details arriving as the turn finishes', 0);
      await waitFor(() => h.bindings.some((binding) => binding.scope === 'followup'));
      h.complete();
      release();
      await waitFor(() => h.requests.filter((request) => request.method === 'turn/start').length === 2);
      expect(h.requests.some((request) => request.method === 'turn/steer')).toBe(false);
      expect(ackStatus('context')).toBe('processing');
      h.complete();
      await waitFor(() => ackStatus('context') === 'completed');
      expect(listRecoveryEntries(scope)).toHaveLength(0);
    } finally {
      release();
      await h.stop();
    }
  });

  it('keeps an explicitly queued accumulate-only claim separate from the initial result', async () => {
    const h = harness();
    try {
      await waitFor(() => h.requests.some((request) => request.method === 'turn/start'));
      insertMessage('context', '*Later details', 0);
      await waitFor(() => ackStatus('context') === 'processing');
      h.complete();
      await waitFor(() => h.requests.filter((request) => request.method === 'turn/start').length === 2);
      expect(h.requests.some((request) => request.method === 'turn/steer')).toBe(false);
      expect(ackStatus('context')).toBe('processing');
      const secondStart = h.requests.filter((request) => request.method === 'turn/start')[1];
      expect(JSON.stringify(secondStart.params.input)).toContain('Later details');
      expect(JSON.stringify(secondStart.params.input)).not.toContain('*Later details');
      h.complete();
      await waitFor(() => ackStatus('context') === 'completed');
      expect(listRecoveryEntries(scope)).toHaveLength(0);
    } finally {
      await h.stop();
    }
  });

  it('keeps an ambiguously failed accumulate-only steer in recovery without resubmitting it', async () => {
    const h = harness({ steerError: { code: -32603, message: 'transport failed after submit' } });
    try {
      await waitFor(() => h.requests.some((request) => request.method === 'turn/start'));
      insertMessage('context', 'Details whose native acceptance is uncertain', 0);
      await waitFor(() => ackStatus('context') === 'recovery');
      expect(h.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
      expect(h.requests.filter((request) => request.method === 'turn/steer')).toHaveLength(1);
      expect(listRecoveryEntries(scope)[0].acceptedUnresolvedInputs[0].messageIds).toEqual(['initial', 'context']);
    } finally {
      await h.stop();
    }
  });
});
