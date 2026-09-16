# Discord Catch-up Thread-Context Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix the NanoClaw Discord catch-up bug that silently drops thread messages arriving while the Discord gateway is down (the 2026-09-16 00:21 incident), verify the fix with tests, deploy the fixed runtime to shapiroserver2 production via the standard deploy lane, and run the canonical post-deploy e2e smoke.

### Explicit constraints
- Work in the dedicated the-usual worktree on the nanoclaw fork; runtime changes land on branch overlay/shapiroserver2, never upstream main.
- Production deploy is explicitly authorized by the user; use the standard deploy lanes (srv/nanoclaw deploy-host lane + source.conf pin update), not manual ssh/docker.
- Push what is deployed (fork + shapiroserver2 config repo).
- Run the canonical e2e smoke on the host after deploy.

### Accepted tradeoffs and residuals
- The one already-lost 00:21 message is not backfilled into the session; the fix protects future messages.

**Goal:** A user message sent in an active thread of a monitored channel while the gateway is down (or the service is restarting) is recovered by catch-up and routed into the correct per-thread session — with the same platform identity live traffic produces — instead of being silently swallowed with a terminal 'routed' row. Threads archived between the message and the catch-up run remain outside walk coverage (no row exists for the sweep either) — an accepted residual carried over from the original 2026-07-30 design (spec §7), restated in Known residuals below.

**Architecture:** The catch-up engine synthesizes `GATEWAY_MESSAGE_CREATE` events from REST-fetched messages. Live in-thread gateway traffic demonstrably resolves the three-part identity `discord:<guild>:<parent>:<thread>` in production (journal 2026-09-16 00:18:27 and 00:49:53; the vendored gateway listener forwards raw `packet.d` unmodified, so live payloads carry thread-resolving context the adapter consumes — whether the embedded thread data or the `channel_type` fallback, the identity outcome is the same). REST-fetched message objects carry no such context, so the vendored `@chat-adapter/discord` adapter cannot resolve a thread message's parent channel: it encodes the identity as `discord:<guild>:<threadId>` (two-part), the router's messaging-group lookup keys on the THREAD id, finds no wiring, and silently returns — while the choke point's acceptance bookkeeping marks the row terminal 'routed' (the 2026-09-16 00:21 incident: message lost, no trace, no retry). The fix injects the thread context the engine already knows (thread targets are enumerated from `/guilds/{id}/threads/active` with `parent_id` in hand; the sweep already GETs `/channels/{id}` for guild resolution, which returns `parent_id` for threads) into both synthesis sites as `thread: { id, parent_id }` — the adapter's first resolution branch — so synthesized payloads resolve to the same three-part identity live traffic produces. No router, wrapper, or vendored-dependency changes.

**Tech Stack:** TypeScript (strict, NodeNext ESM with `.js` relative import extensions), vitest (in-memory SQLite per test via `initTestDb()` + `runMigrations(db)`), pnpm. No new dependencies.

## Global Constraints

- Branch: `the-usual/catchup-thread-context` (from `overlay/shapiroserver2` at `83e7a84935b1cc4f2529766f438c79d679c5e69f`); landing target is fork branch `overlay/shapiroserver2` — never upstream `main`.
- Style: single quotes, 120 cols (prettier; husky pre-commit runs `format:fix` and re-stages); `log.<level>('Sentence Case message', { fields })` with errors stringified into a field — never an `err` key in `src/channels/discord*.ts`.
- No new dependencies (supply-chain gate `minimumReleaseAge` would also block fresh versions).
- Tests are hermetic: no network, no Docker; fake `fetchImpl`, injected clocks, in-memory SQLite.
- The `'routed' means verified-routed` invariant (row-status verification after every POST) and all existing A11/A16 semantics (single-attempt POST, bounded abandon, sweep-never-moves-cursors, no first-sight replay) remain unchanged.
- Commit subjects follow the fork's conventional style, e.g. `fix(channels): …`.
- The one pre-existing baseline failure (`src/gws-finalization.test.ts > sealAndDrainGwsCorrelation > accepts systemd credential mode 0440 only from its protected credential directory`, WSL file-mode sensitivity, reproduces at base_ref) is a recorded exception; everything else must be green.

---

### Task 1: Thread-target walk payloads carry thread context

**Files:**
- Modify: `src/channels/discord-catchup.ts` (TargetInfo type at line 123; `resolveThreadTargets` at lines 187–204; `catchUpTarget` synthesis at lines 245–249)
- Test: `src/channels/discord-catchup.test.ts` (new test inside the `createDiscordCatchup runOnce` describe)
- Test: `src/channels/discord.test.ts` (new describe pinning the vendored-adapter contract)

**Interfaces:**
- Consumes: `resolveThreadTargets`' existing source data — active-thread objects already carry `parent_id` (guaranteed non-null by the `monitored.has(thread.parent_id)` filter).
- Produces: `type TargetInfo = { id: string; guildId: string; kind: 'channel' } | { id: string; guildId: string; kind: 'thread'; parentId: string }` (discriminated union). Synthesized walk payloads for thread targets gain `thread: { id: string; parent_id: string }` alongside the existing hard-required `guild_id`.

- [ ] **Step 1: Write the failing behavioral test**

Add to `src/channels/discord-catchup.test.ts`, inside `describe('createDiscordCatchup runOnce', ...)` right after the existing `'backfills active threads whose parent is monitored, with their own cursors'` test (line 271–288):

```ts
it('injects thread context into thread-target payloads so the adapter resolves the parent channel', async () => {
  // 2026-09-16 incident: without thread context the vendored adapter encoded
  // a two-part identity (discord:guild:thread), the router keyed the
  // messaging-group lookup on the THREAD id, found no wiring, and silently
  // dropped the message while its route row went terminal 'routed'.
  advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
  advanceDiscordChannelCursor('thread-1', '600', '2026-07-30T00:00:00.000Z');
  const { fetchImpl, webhookPosts } = fakeTransport({
    '/channels/chan-1?': [json(CHANNEL_INFO)],
    '/guilds/guild-1/threads/active': [
      json({ threads: [{ id: 'thread-1', parent_id: 'chan-1', last_message_id: '601' }] }),
    ],
    '/channels/chan-1/messages': [json([restMessage('502')]), json([])],
    '/channels/thread-1/messages': [json([restMessage('601', { channel_id: 'thread-1' })]), json([])],
    '/channels/chan-1': [json(CHANNEL_INFO)],
  });
  const engine = makeEngine(fetchImpl);
  const summary = await engine.runOnce('periodic');
  expect(summary?.routed).toBe(2);
  const threadPost = webhookPosts.find((p) => p.data.id === '601');
  expect(threadPost?.data.thread).toEqual({ id: 'thread-1', parent_id: 'chan-1' });
  expect(threadPost?.data.guild_id).toBe('guild-1');
  const channelPost = webhookPosts.find((p) => p.data.id === '502');
  expect(channelPost?.data.thread).toBeUndefined(); // channel targets carry no thread context
  expect(getDiscordChannelCursor('thread-1')).toBe('601');
});
```

Also add the vendored-adapter contract pins (these document WHY the fix is load-bearing; they pass against current code and must stay green — they pin external dependency behavior, not a production change). Add to `src/channels/discord.test.ts` as a new top-level describe (add `createDiscordAdapter` to the existing `@chat-adapter/discord` import that `src/channels/discord.ts` already uses — import it directly from `'@chat-adapter/discord'` — and import `yenteDiscordPlatformIdFromThreadId` from `'./discord.js'` if not already imported):

```ts
describe('vendored adapter thread-context contract (catch-up payload parity)', () => {
  const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as NonNullable<Parameters<typeof createDiscordAdapter>[0]>['logger'];

  function vendoredAdapter() {
    const adapter = createDiscordAdapter({
      botToken: 'test-token',
      publicKey: 'a'.repeat(64),
      applicationId: 'app-1',
      logger: silentLogger,
    });
    const handleIncomingMessage = vi.fn();
    return { adapter, handleIncomingMessage };
  }

  // The vendored adapter's .d.ts declares handleForwardedMessage private, but
  // the runtime method is exactly what the bridge's webhook dispatches to.
  // Cast structurally — the same pattern the integration tests already use on
  // the wrapped adapter — so the host typecheck (tsc compiles src/**, tests
  // included) stays green.
  function vendoredForward(
    adapter: ReturnType<typeof createDiscordAdapter>,
  ): (data: unknown, options: unknown) => Promise<void> {
    return (
      adapter as unknown as {
        handleForwardedMessage: (data: unknown, options: unknown) => Promise<void>;
      }
    ).handleForwardedMessage.bind(adapter);
  }

  const basePayload = {
    id: 'm1',
    channel_id: 'thread-1',
    guild_id: 'guild-1',
    content: 'missed in-thread message',
    author: { id: 'user-1', username: 'dan', bot: false },
    mentions: [],
    attachments: [],
    timestamp: '2026-07-30T00:00:00.000Z',
  };

  it('resolves a three-part identity from data.thread, like live in-thread events', async () => {
    const { adapter, handleIncomingMessage } = vendoredAdapter();
    await adapter.initialize({ handleIncomingMessage } as never);
    await vendoredForward(adapter)({ ...basePayload, thread: { id: 'thread-1', parent_id: 'chan-1' } }, {});
    expect(handleIncomingMessage).toHaveBeenCalledTimes(1);
    expect(handleIncomingMessage.mock.calls[0]?.[1]).toBe('discord:guild-1:chan-1:thread-1');
  });

  it('encodes a two-part identity (thread AS the channel) when thread context is missing', async () => {
    // The 2026-09-16 incident identity: without data.thread the vendored
    // adapter treats the thread as a top-level channel. The router then keys
    // on the thread id, finds no messaging group, and silently drops the
    // message while the row goes terminal 'routed'. This pin documents the
    // failure mode the catch-up thread-context injection exists to prevent.
    const { adapter, handleIncomingMessage } = vendoredAdapter();
    await adapter.initialize({ handleIncomingMessage } as never);
    await vendoredForward(adapter)({ ...basePayload }, {});
    const threadId = handleIncomingMessage.mock.calls[0]?.[1] as string;
    expect(threadId).toBe('discord:guild-1:thread-1');
    expect(yenteDiscordPlatformIdFromThreadId(threadId)).toBe('thread-1');
  });
});
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts src/channels/discord.test.ts`

Expected: FAIL — the new `injects thread context into thread-target payloads…` test fails on `expect(threadPost?.data.thread).toEqual({ id: 'thread-1', parent_id: 'chan-1' })` (received `undefined`); the two vendored-adapter contract pins PASS (they pin current dependency behavior).

- [ ] **Step 3: Add the minimal production implementation**

In `src/channels/discord-catchup.ts`:

Replace the `TargetInfo` type (line 123):

```ts
type TargetInfo = { id: string; guildId: string; kind: 'channel' } | { id: string; guildId: string; kind: 'thread'; parentId: string };
```

In `resolveThreadTargets`, replace the loop body's final `targets.push` (line 201) so the parent id survives the filter without a cast:

```ts
      // parent_id is guaranteed non-null by the monitored.has(thread.parent_id) filter above.
      if (!thread.parent_id) continue;
      targets.push({ id: thread.id, guildId, kind: 'thread', parentId: thread.parent_id });
```

In `catchUpTarget`, replace the synthesis (lines 245–249):

```ts
        const event = {
          type: 'GATEWAY_MESSAGE_CREATE',
          timestamp: now(),
          data: {
            ...message,
            guild_id: target.guildId,
            // REST message objects lack the thread context live gateway
            // events carry; without it the vendored adapter resolves the
            // identity as discord:<guild>:<thread> and the router sees an
            // unwired channel (2026-09-16 incident).
            ...(target.kind === 'thread' ? { thread: { id: target.id, parent_id: target.parentId } } : {}),
          },
        };
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm run typecheck && pnpm exec vitest run src/channels/discord-catchup.test.ts src/channels/discord.test.ts`

Expected: typecheck PASS (the vendored adapter's `.d.ts` declares `handleForwardedMessage` private — the structural `vendoredForward` cast exists precisely so this gate stays green) and all tests in both files PASS.

- [ ] **Step 5: Refactor while green**

No refactor expected: the change is a type narrowing plus a two-line synthesis change. If the discriminated union forces a `kind` narrowing elsewhere, prefer explicit `target.kind === 'thread'` checks over casts.

- [ ] **Step 6: Run impacted-test verification**

The change touches the catch-up engine's target typing and synthesis; `resolveThreadTargets`, `catchUpTarget`, and `doRun` are shared by every engine test. The impacted set is the whole catch-up test file plus the choke-point/bridge files that consume synthesized payloads.

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts src/channels/discord-catchup.integration.test.ts src/channels/discord.test.ts src/channels/discord-state.test.ts src/channels/chat-sdk-bridge.test.ts src/router.test.ts`

Expected: PASS (all).

- [ ] **Step 7: Commit the task**

```bash
git add src/channels/discord-catchup.ts src/channels/discord-catchup.test.ts src/channels/discord.test.ts
git commit -m "fix(channels): catch-up thread targets carry thread context — synthesized payloads resolve the monitored parent, not the thread id (2026-09-16 silent-drop incident)"
```

---

### Task 2: Sweep re-presentation carries thread context

**Files:**
- Modify: `src/channels/discord-catchup.ts` (add a `threadParentCache` beside `guildCache` at line 131; restructure the guild-resolution GET in `sweepRetriableRoute` at lines 312–318; synthesis at lines 352–356)
- Test: `src/channels/discord-catchup.test.ts` (new test inside the `createDiscordCatchup runOnce` describe, after the sweep test at line 472–501)

**Interfaces:**
- Consumes: the `/channels/{id}` GET `sweepRetriableRoute` already performs for guild resolution — the same response carries `parent_id` for thread channels (Discord returns the full channel object, including `parent_id`, for threads — active or archived).
- Produces: none beyond Task 1's payload contract (`thread: { id, parent_id }` in sweep-synthesized payloads for thread rows).

- [ ] **Step 1: Write the failing behavioral test**

Add to `src/channels/discord-catchup.test.ts`, right after the existing `'sweeps a stranded failed row from BEHIND the cursor and re-routes it without moving the cursor'` test:

```ts
it('sweep re-presents a stranded THREAD row with thread context from the channel lookup', async () => {
  // Incident shape: a thread message whose first presentation predates the
  // thread-context fix — its row sits behind the thread cursor forever, so
  // only the sweep can recover it.
  claimDiscordMessage(
    'thread-1',
    '698',
    { guildId: 'guild-1', authorId: 'user-1', source: 'gateway' },
    '2026-07-30T00:00:00.000Z',
    '2026-07-30T00:02:00.000Z',
  );
  markDiscordMessageFailed('thread-1', '698', '2026-07-30T00:00:01.000Z', 'transient dispatch error');
  advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:02.000Z');
  advanceDiscordChannelCursor('thread-1', '700', '2026-07-30T00:00:02.000Z');
  const { fetchImpl, webhookPosts } = fakeTransport({
    '/channels/chan-1?': [json(CHANNEL_INFO)],
    '/guilds/guild-1/threads/active': [json({ threads: [] })],
    '/channels/chan-1/messages': [json([])],
    // Insertion order matters: message-by-id and the thread channel-info
    // needles must precede any catch-all.
    '/channels/thread-1/messages/698': [json(restMessage('698', { channel_id: 'thread-1' }))],
    '/channels/thread-1': [json({ id: 'thread-1', guild_id: 'guild-1', parent_id: 'chan-1' })],
    '/channels/chan-1': [json(CHANNEL_INFO)],
  });
  const engine = makeEngine(fetchImpl, {}, () => Date.parse('2026-07-30T01:00:00.000Z'));
  const summary = await engine.runOnce('periodic');
  expect(webhookPosts.map((p) => p.data.id)).toEqual(['698']);
  expect(webhookPosts[0]?.data.guild_id).toBe('guild-1');
  expect(webhookPosts[0]?.data.thread).toEqual({ id: 'thread-1', parent_id: 'chan-1' });
  expect(summary?.routed).toBe(1);
  expect(getDiscordMessageRouteStatus('thread-1', '698')).toBe('routed');
  expect(getDiscordChannelCursor('thread-1')).toBe('700'); // the sweep NEVER moves the cursor
});
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts`

Expected: FAIL — the new test fails on `expect(webhookPosts[0]?.data.thread).toEqual({ id: 'thread-1', parent_id: 'chan-1' })` (received `undefined`).

- [ ] **Step 3: Add the minimal production implementation**

In `src/channels/discord-catchup.ts`, add the cache beside `guildCache` (line 131):

```ts
  const guildCache = new Map<string, string | null>();
  // channelId -> parent channel id for threads (null = plain channel). Lets
  // the sweep inject thread context into re-presented stranded rows.
  const threadParentCache = new Map<string, string | null>();
```

In `sweepRetriableRoute`, replace the guild-resolution block (lines 312–318) so the same GET also captures the thread parent — and a guild-cache hit never triggers a second GET (`guildCache` is only populated for monitored non-thread channels by `resolveChannelTarget`, or by this sweep alongside the parent):

```ts
    let guildId = guildCache.get(row.channel_id);
    let parentId = threadParentCache.get(row.channel_id);
    if (guildId === undefined) {
      const info = await discordGetJson<{ guild_id?: string; parent_id?: string }>(
        `/channels/${encodeURIComponent(row.channel_id)}`,
      );
      if (!info) return; // channel unreadable THIS run (transient); the SQL horizon bounds how long such rows can hold a budget slot
      guildId = typeof info.guild_id === 'string' && info.guild_id.length > 0 ? info.guild_id : null;
      guildCache.set(row.channel_id, guildId);
      parentId = typeof info.parent_id === 'string' && info.parent_id.length > 0 ? info.parent_id : null;
      threadParentCache.set(row.channel_id, parentId);
    } else if (parentId === undefined) {
      // A cached guild implies a monitored (non-thread) channel or a prior
      // sweep that captured the parent — no thread context applies here.
      parentId = null;
      threadParentCache.set(row.channel_id, parentId);
    }
```

And replace the sweep synthesis (lines 352–356):

```ts
    const event = {
      type: 'GATEWAY_MESSAGE_CREATE',
      timestamp: now(),
      data: {
        ...message,
        guild_id: guildId, // same hard-required injection as the walk
        ...(parentId ? { thread: { id: row.channel_id, parent_id: parentId } } : {}),
      },
    };
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts`

Expected: PASS (all tests in the file).

- [ ] **Step 5: Refactor while green**

No refactor expected. If desired, the comment on the old `if (!info) return` line is preserved verbatim in the replacement block above.

- [ ] **Step 6: Run impacted-test verification**

The sweep shares state helpers (`guildCache`) with the walk; all engine tests plus the choke-point and state tests are the impacted set.

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts src/channels/discord-catchup.integration.test.ts src/channels/discord.test.ts src/channels/discord-state.test.ts`

Expected: PASS (all).

- [ ] **Step 7: Commit the task**

```bash
git add src/channels/discord-catchup.ts src/channels/discord-catchup.test.ts
git commit -m "fix(channels): sweep re-presents stranded thread rows with thread context resolved from the existing channel lookup"
```

---

### Task 3: Integration regression — incident shape through the real choke point

**Files:**
- Test: `src/channels/discord-catchup.integration.test.ts` (add a second `it` in the existing describe; factor the inline webhook server creation into a small local helper reused by both tests)

**Interfaces:**
- Consumes: Task 1's payload contract (`thread: { id, parent_id }` on thread-target payloads); `wrapYenteDiscordChannelIds`' existing bookkeeping (cursor advance when `monitored.has(data.thread.parent_id)`); `discord-state` cursor helpers.
- Produces: none (test-only).

- [ ] **Step 1: Write the failing behavioral test**

First factor the webhook server creation (current lines 90–109) into a helper at describe scope so both tests share it:

```ts
  function startWebhookServer(
    dispatch: (event: { type: string; data: Record<string, unknown> }) => Promise<unknown>,
  ): Promise<http.Server> {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const event = JSON.parse(Buffer.concat(chunks).toString()) as {
            type: string;
            data: Record<string, unknown>;
          };
          void dispatch(event).then(
            () => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end('{"ok":true}');
            },
            () => {
              res.writeHead(500);
              res.end('{"error":"internal"}');
            },
          );
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
  }

  function serverUrl(srv: http.Server): string {
    const port = (srv.address() as { port: number }).port;
    return `http://127.0.0.1:${port}/webhook`;
  }
```

Rewire the existing first test onto the helpers (behavior unchanged), then add the incident regression:

```ts
  it('recovers a missed in-thread message with thread context and advances the thread cursor at the choke point', async () => {
    // 2026-09-16 incident shape: a user message arrived in an ACTIVE thread
    // of a monitored channel while the service was restarting. Pre-fix, the
    // synthesized payload lost the thread context, the choke point could not
    // see the monitored parent, and the message vanished behind a terminal
    // 'routed' row.
    const THREAD = '1549090599121059931'; // the incident thread
    const THREAD_CURSOR = unixMsToSnowflake(NOW_MS - 60 * 60 * 1000);
    const MSG_T1 = unixMsToSnowflake(NOW_MS - 30 * 60 * 1000);
    const threadRestMessage = (id: string): Record<string, unknown> => ({
      id,
      type: 0,
      channel_id: THREAD,
      content: `missed thread message ${id}`,
      author: { id: 'dan', bot: false },
      mentions: [],
      attachments: [],
      timestamp: '2026-07-30T00:00:00.000Z',
    });

    const inner = {
      handleForwardedMessage: vi.fn(async (..._args: unknown[]) => 'handled'),
      createDiscordThread: vi.fn(async () => ({ id: 'thread-new' })),
      postMessage: vi.fn(async () => 'mid'),
      editMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
      removeReaction: vi.fn(async () => undefined),
      startTyping: vi.fn(async () => undefined),
      channelIdFromThreadId: (threadId: string) => threadId,
    };
    const forwardSpy = inner.handleForwardedMessage;
    const wrapped = wrapYenteDiscordChannelIds(
      inner as unknown as Parameters<typeof wrapYenteDiscordChannelIds>[0],
      'test-token',
      new Set([]), // no auto-thread channels: this thread pre-exists
      {
        monitoredChannelIds: () => new Set([CHANNEL]),
        routeLeaseMs: 120000,
        wasMessageHandled: () => true,
      },
    ) as unknown as { handleForwardedMessage: (data: unknown, options: unknown) => Promise<unknown> };

    server = await startWebhookServer((event) =>
      wrapped.handleForwardedMessage(event.data, {}),
    );
    const webhookUrl = serverUrl(server);

    const pages: Record<string, unknown[]> = {
      [THREAD_CURSOR]: [threadRestMessage(MSG_T1)],
      [MSG_T1]: [],
      [CURSOR]: [], // parent channel has nothing new
    };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1')) return fetch(input as never, init);
      if (url.includes(`/channels/${THREAD}/messages`)) {
        const after = new URL(url).searchParams.get('after') ?? '';
        return new Response(JSON.stringify(pages[after] ?? []), { status: 200 });
      }
      if (url.includes(`/channels/${CHANNEL}/messages`)) {
        const after = new URL(url).searchParams.get('after') ?? '';
        return new Response(JSON.stringify(pages[after] ?? []), { status: 200 });
      }
      if (url.includes('/threads/active')) {
        return new Response(
          JSON.stringify({ threads: [{ id: THREAD, parent_id: CHANNEL, last_message_id: MSG_T1 }] }),
          { status: 200 },
        );
      }
      if (url.includes(`/channels/${CHANNEL}`)) {
        return new Response(JSON.stringify({ id: CHANNEL, guild_id: GUILD, last_message_id: MSG_1 }), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    // The gap: channel AND thread cursors sit 1h back; MSG_T1 arrived in the
    // thread while the gateway was down.
    advanceDiscordChannelCursor(CHANNEL, CURSOR, '2026-07-30T00:00:00.000Z');
    advanceDiscordChannelCursor(THREAD, THREAD_CURSOR, '2026-07-30T00:00:00.000Z');

    const engine = createDiscordCatchup({
      botToken: 'test-token',
      botUserId: 'bot-1',
      webhookUrl,
      monitoredChannelIds: () => new Set([CHANNEL]),
      env: {},
      fetchImpl,
      sleep: async () => {},
      now: () => NOW_MS,
    });

    const summary = await engine.runOnce('ready');

    // The missed thread message is presented WITH thread context.
    expect(summary?.routed).toBe(1);
    expect(summary?.threads).toBe(1);
    expect(forwardSpy).toHaveBeenCalledTimes(1);
    const presented = forwardSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(presented.thread).toEqual({ id: THREAD, parent_id: CHANNEL });
    expect(presented.guild_id).toBe(GUILD);
    // Thread context means the choke point treats it as already-in-thread:
    // no auto-thread attempt from a thread message.
    expect(inner.createDiscordThread).not.toHaveBeenCalled();
    // The choke point sees the monitored parent and advances the THREAD cursor
    // (monitored.has(data.thread.parent_id)) — the same bookkeeping live
    // in-thread traffic gets.
    expect(getDiscordChannelCursor(THREAD)).toBe(MSG_T1);

    const rows = getDb()
      .prepare(`SELECT message_id, status, source FROM discord_message_routes ORDER BY message_id`)
      .all() as Array<{ message_id: string; status: string; source: string }>;
    expect(rows).toEqual([{ message_id: MSG_T1, status: 'routed', source: 'catchup' }]);

    // Restart idempotency: nothing new on the second run.
    const second = await engine.runOnce('periodic');
    expect(second?.routed).toBe(0);
    expect(forwardSpy).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm exec vitest run src/channels/discord-catchup.integration.test.ts`

Expected: FAIL — `expect(presented.thread).toEqual({ id: THREAD, parent_id: CHANNEL })` receives `undefined` (pre-fix synthesis). This is the single discriminating assertion: pre-fix, the engine still verifies the row as routed and advances the thread cursor itself, so the cursor and row assertions pass on both sides — they pin the post-fix choke-point bookkeeping, not the regression.

- [ ] **Step 3: Add the minimal production implementation**

None — Tasks 1 and 2 carry the production change; this task is the end-to-end regression that proves the incident path through the REAL choke point (claim → forward → acceptance bookkeeping → cursor advance). If the test fails, the fix is incomplete: do not patch the test to match production behavior.

- [ ] **Step 4: Run the focused test**

Run: `pnpm exec vitest run src/channels/discord-catchup.integration.test.ts`

Expected: PASS (both tests in the file).

- [ ] **Step 5: Refactor while green**

The webhook-server helper extraction IS the refactor; no further cleanup expected.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm exec vitest run src/channels/discord-catchup.integration.test.ts src/channels/discord-catchup.test.ts src/channels/discord.test.ts`

Expected: PASS (all).

- [ ] **Step 7: Commit the task**

```bash
git add src/channels/discord-catchup.integration.test.ts
git commit -m "test(channels): incident regression — catch-up recovers an in-thread gap message with thread context through the real choke point"
```

---

### Task 4: Correct the superseded payload-equivalence design note

**Files:**
- Modify: `docs/plans/2026-07-30-discord-catchup.md` (the design note at line 69 beginning `Do NOT enrich synthesized payloads with `channel_type` or a fabricated `thread` field.`)

**Interfaces:**
- Consumes: the production evidence recorded in this plan's Architecture section.
- Produces: none.

- [ ] **Step 1: Write the failing behavioral test**

Not applicable — this is a documentation correction with no testable behavior; the executable proof of the correction is Tasks 1–3.

- [ ] **Step 2: Run the test and verify the intended failure**

Not applicable (no test).

- [ ] **Step 3: Add the minimal production implementation**

In `docs/plans/2026-07-30-discord-catchup.md`, immediately after the line-69 bullet (`Do NOT enrich synthesized payloads with `channel_type` or a fabricated `thread` field. …`), append this correction paragraph (do not rewrite the original text — the plan is a historical record):

```markdown
> **Correction (2026-09-16):** The equivalence claim above was wrong for threads. Live in-thread MESSAGE_CREATE traffic resolves the three-part identity `discord:<guild>:<parent>:<thread>` in production (journal 2026-09-16 00:18:27/00:49:53; the gateway listener forwards raw `packet.d` unmodified, so live payloads carry thread-resolving context the vendored adapter consumes), while REST-fetched message objects do not — so synthesized payloads took the two-part fall-through and the router silently dropped them as unwired-channel chatter with the row terminal `routed` (the 2026-09-16 00:21 incident). Catch-up now injects `thread: { id, parent_id }` (known from the active-threads listing / sweep channel lookup) into synthesized payloads for thread rows; see `docs/plans/2026-09-16-catchup-thread-context.md`. The `guild_id` injection requirement and the no-`channel_type` rule stand unchanged.
```

- [ ] **Step 4: Run the focused test**

Run: `rg -nF "Correction (2026-09-16)" docs/plans/2026-07-30-discord-catchup.md`

Expected: exactly one match (use `-F`: the parentheses are literal text, and the default `rg` pattern mode treats them as a regex capture group).

- [ ] **Step 5: Refactor while green**

None.

- [ ] **Step 6: Run impacted-test verification**

Not applicable — markdown only; no behavior.

- [ ] **Step 7: Commit the task**

```bash
git add docs/plans/2026-07-30-discord-catchup.md
git commit -m "docs: correct the superseded catch-up payload-equivalence note — live in-thread events self-describe threads; synthesized payloads must too"
```

---

### Task 5: Land, deploy, and verify on production (user-mandated; runs only after the delta review passes)

This is the documented **coordinated GWS / NanoClaw / Ringdown release** (docs/nanoclaw/Deployment.md "Coordinated GWS, NanoClaw, and Ringdown release"; runbook: docs/nanoclaw/how-to-add-gws-google-account.md): a new runtime pin makes the deploy a new release, the strict new-release gate requires a fresh GWS source-sync receipt whose `wrapperSha` equals this deploy's wrapper, and the GWS cutover's outage contract stops `nanoclaw.service` plus the `ringdown` and `gws-proxy` containers behind an idle gate. Follow the documented sequence — do not use a partial or alternate one, and do not bypass the idle gate (no active Ringdown call, no active NanoClaw session tool operation).

**Files:**
- Modify (repo `danshapiro/nanoclaw`, branch `overlay/shapiroserver2`): merge of `the-usual/catchup-thread-context`
- Modify (repo `danshapiro/shapiroserver2-private`, branch `main`): `srv/nanoclaw/source.conf`, `changes.md`
- Modify (branch `deploy/nanoclaw`, generated publication): squashed sync from `main`

**Interfaces:**
- Consumes: the full-suite gate result on final HEAD (Step 0 produces it; the executing stage's end-of-execution gate is the same evidence), plus the delta-review PASSED marker.
- Produces: a deployed, smoke-verified production release pinned by `source.conf` and published on `origin/deploy/nanoclaw`.

- [ ] **Step 0: Full-suite gate on the final HEAD (the deploy precondition)**

Run, in the worktree, on the exact commit to be landed:

```bash
pnpm run typecheck && pnpm run lint && pnpm test
```

Expected: typecheck PASS, lint PASS, full vitest suite green excluding the ledger-recorded baseline exception (`src/gws-finalization.test.ts > sealAndDrainGwsCorrelation > accepts systemd credential mode 0440…`, WSL file-mode sensitivity, reproduction receipt in `reports/baseline-gws-failure-receipt.md`). The container/Bun suite (`container/agent-runner`, `bun test` in CI) is out of scope for this gate: this change touches no file under `container/` (reasoning recorded here; CI covers it independently). Any NEW red blocks the deploy.

- [ ] **Step 1: Land on `overlay/shapiroserver2` and push**

```bash
cd /home/dan/code/nanoclaw-catchup-threadctx
git fetch origin
git checkout -B overlay/shapiroserver2 origin/overlay/shapiroserver2
git merge --ff-only the-usual/catchup-thread-context   # if this refuses, rebase the work branch on origin/overlay/shapiroserver2, re-run the full suite, and retry
git push origin overlay/shapiroserver2
git rev-parse HEAD   # record this SHA as NANO_SHA
```

- [ ] **Step 2: Pin the release on shapiroserver2 `main`, push, and publish `deploy/nanoclaw`**

In `/home/dan/code/shapiroserver2` (checkout stays on `main`):

- Set `ref=` in `srv/nanoclaw/source.conf` to NANO_SHA.
- Add a `changes.md` entry (match the file's top-entry dated format) describing the fix, the incident, the release SHA, and a smoke-result placeholder.
- Commit, push `main`, then publish the generated branch with a single squashed commit on the origin tip (tree = `main`, message carrying the full `main` SHA — the one-commit-per-publish shape; the deploy guard refuses otherwise):

```bash
git add srv/nanoclaw/source.conf changes.md
git commit -m "nanoclaw: pin catch-up thread-context fix (<short sha>)"
git push origin main
SHAPIRO_SHA="$(git rev-parse HEAD)"
# Publish deploy/nanoclaw: one squashed commit on the origin tip, tree = main,
# message carrying the full main SHA (the one-commit-per-publish shape the
# deploy guard requires; there is no helper script — this is the documented
# manual form from the 2026-09-16 deploy record).
git fetch origin deploy/nanoclaw
PUBLISH_SHA="$(git commit-tree "main^{tree}" -p origin/deploy/nanoclaw -m "publish shapiroserver2 main ${SHAPIRO_SHA} (catch-up thread-context pin)")"
git push origin "$PUBLISH_SHA:refs/heads/deploy/nanoclaw"
# Pre-check the guard's own invariant: the pin must be byte-identical across refs.
diff <(git show origin/main:srv/nanoclaw/source.conf) <(git show origin/deploy/nanoclaw:srv/nanoclaw/source.conf)
```

The publication step must leave `source.conf` byte-identical across worktree, `main`, `origin/main`, and `origin/deploy/nanoclaw` (deploy-host.sh `require_prod_publication_state`).

- [ ] **Step 3: Resolve the deploy variables (all read-only, BEFORE stopping anything)**

- `NANO_SHA` (Step 1), `SHAPIRO_SHA` (Step 2).
- `GWS_SHA` = canonical `/home/dan/code/gws-skill` tip (`git -C /home/dan/code/gws-skill rev-parse HEAD`).
- Ringdown restart receipts: read the live `/srv/ringdown/.deploy-source.json` (`sourceSha` components: ringdown, gws, familiar, local-skills) on the host before the outage so Step 7 can pin the exact expected SHAs (they are unchanged by this deploy).

- [ ] **Step 4: Idle gate and three-service stop (runbook Step 4)**

Run the documented `CUTOVER_QUIESCE_AND_STOP` block verbatim from `docs/nanoclaw/how-to-add-gws-google-account.md` §4 (idle gate: no in-progress Twilio calls; no `processing` claims, no active `current_tool`, no fresh session heartbeats; then stop `nanoclaw`, session containers, `ringdown`, `gws-proxy`; assert all three inactive). If the idle gate fails, stop and report — an approved outage does not authorize interrupting active calls or work.

- [ ] **Step 5: GWS cutover (refreshes the receipt's wrapperSha)**

```bash
bash srv/deploy.sh gws-proxy --expected-wrapper-sha "$SHAPIRO_SHA" --expected-source-sha "$GWS_SHA"
```

Expected: gws-proxy rebuilt and healthy; `/srv/gws-proxy/.source-sync.json` wrapperSha now `SHAPIRO_SHA`. (GWS content is unchanged — the 2026-09-16 and 2026-08-17 deploy records show exactly this step for new-release deploys with an unchanged GWS bundle.)

- [ ] **Step 6: NanoClaw deploy (starts nanoclaw on the new release)**

```bash
bash srv/nanoclaw/deploy-host.sh --target prod --expected-wrapper-sha "$SHAPIRO_SHA" --expected-nano-sha "$NANO_SHA"
```

Expected: release staged under `/srv/nanoclaw/releases/<NANO_SHA>/`, `current`/`previous` flipped, `nanoclaw.service` active and healthy. The lane fails closed on any publication/pin mismatch or active backup window — do not bypass.

- [ ] **Step 7: Restart Ringdown last (runbook Step 6 consumer order)**

```bash
bash srv/deploy.sh ringdown \
  --expected-wrapper-sha "$SHAPIRO_SHA" \
  --expected-ringdown-sha "$RINGDOWN_SHA" \
  --expected-gws-sha "$GWS_SHA" \
  --expected-familiar-sha "$FAMILIAR_SHA" \
  --expected-local-skills-sha "$LOCAL_SKILLS_SHA"
```

(with the receipt SHAs read in Step 3). Then run the runbook §6 `VERIFY_RECEIPTS` block verbatim: `nanoclaw` active, `gws-proxy` and `ringdown` healthy, all deployment receipts match the reviewed inputs.

- [ ] **Step 8: Run the canonical e2e smoke**

```bash
ssh shapiroserver2-lan 'sudo /srv/nanoclaw/run-e2e-smoke.sh'
```

Expected: green, EXCEPT rows attributable to the two documented standing-red katas (the codex plan/todo tool-surface gap and the msgvault-e2e stale session-path check — both kata'd and pre-existing before this deploy; triage with evidence like the 2026-09-16 deploy record did). Any failure in a catch-up/Discord row — or any NEW red not covered by those katas — blocks the run. Full-suite runs re-run up to 2 failed tests once in isolation; a retry-passed row is a flake signal, not a hidden failure.

- [ ] **Step 9: Record the smoke result and close out**

Update the `changes.md` entry's smoke placeholder with the actual result (and the outage/receipt facts: wrapper SHA, GWS receipt, ringdown restart, previous release retained for rollback), commit, and push. A deploy must not leave local-only commits behind: verify `git log origin/main..main` is empty in shapiroserver2, the fork and `deploy/nanoclaw` are pushed, and both repos' `git status` is clean.

- [ ] **Step 10: Run impacted-test verification**

Read-only production checks: journal shows the new release running (`sudo journalctl -u nanoclaw -n 5` on the host), the deployed `current` symlink resolves to `<NANO_SHA>`, and (for a few minutes of watch) Discord catch-up startup runs report `routed=…/failed=0` with no abandon lines.

- [ ] **Step 11: Commit the task**

The commits are Steps 2 and 9 (config repo), the landed merge (fork), and the published squash (deploy/nanoclaw). Verify nothing unpushed remains in any of the three refs.

---

## Self-review

- **Spec coverage:** "Fix the catch-up bug" → Tasks 1–2 (both synthesis sites) + Task 3 (incident path through the real choke point). "Verify with tests" → red/green unit tests, dependency-contract pins, integration regression, full-suite gate with the recorded baseline exception. "Deploy via the standard lane" → Task 5 (source.conf pin + `deploy-host.sh`, both user-authorized). "Run the canonical e2e smoke" → Task 5 Step 4. "Push what is deployed" → Task 5 Steps 1–2, 5.
- **No silent deferrals:** the vendored-adapter contract pins are deliberate dependency-contract tests (green by design, commented as such), not deferred behavior. The pre-existing `gws-finalization` WSL failure is a recorded baseline exception with a reproduction receipt, not a deferral introduced by this plan.
- **File/interface consistency:** `TargetInfo` discriminated union introduced in Task 1 is the only typed-interface change; Task 2's cache and synthesis reuse it; Task 3 consumes only the payload contract. Paths match the worktree layout (`src/channels/...`, `docs/plans/...`).
- **Executable tests:** each red test names the exact assertion that fails pre-fix (`thread` field undefined) and passes post-fix; expected failure reasons match the missing behavior, not setup accidents. The Task 1 pins are explicitly green-by-design dependency pins.
- **Operational completeness:** rollback = pin flip back to `83e7a849` (the immutable previous release; `srv/nanoclaw/rollback-host.sh`). The deploy lane enforces its own backup-window lock. No migrations, no new env keys, no config changes. Production verification is read-only journal checks + the canonical smoke.
- **Known residuals (documented, not deferred):** first-sight threads/channels still skip history replay (original design, unchanged); threads archived between a gap message and the catch-up run remain outside walk coverage and leave no row for the sweep (accepted residual carried over from the original 2026-07-30 design, spec §7 — the fix does not expand coverage there); the already-lost 00:21 message is not backfilled (accepted tradeoff); a monitored-channel message that genuinely fails router engagement after the fix still follows the design's existing terminal-'routed' semantics.
