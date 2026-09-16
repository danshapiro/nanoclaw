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

**Architecture:** The catch-up engine synthesizes `GATEWAY_MESSAGE_CREATE` events from REST-fetched messages. Live in-thread gateway traffic demonstrably resolves the three-part identity `discord:<guild>:<parent>:<thread>` in production (journal 2026-09-16 00:18:27 and 00:49:53), while the same adapter, fed a REST-fetched message, produced the two-part identity `discord:<guild>:<threadId>` and the router silently dropped the message (the 2026-09-16 00:21 incident: no `Message routed` log, message absent from the session DB, route row terminal `routed`, no trace, no retry). The fix restores the observed live identity outcome for recovered messages: injecting `thread: { id, parent_id }` — the parent is already known to the engine (thread targets are enumerated from `/guilds/{id}/threads/active` with `parent_id` in hand; the sweep already GETs `/channels/{id}` for guild resolution, which returns `parent_id` for threads) into both synthesis sites feeds the vendored adapter's documented first resolution branch and yields the same three-part identity. This plan claims only that identity outcome, which production journals prove; it does not assert WHICH field live gateway payloads carry (the installed discord-api-types describe neither `thread` for ordinary thread replies nor a `channel_type` gateway extra, so any mechanism claim beyond the observed outcome would be unproven). No router, wrapper, or vendored-dependency changes.

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
> **Correction (2026-09-16):** The equivalence claim above was wrong for threads. Live in-thread MESSAGE_CREATE traffic resolves the three-part identity `discord:<guild>:<parent>:<thread>` in production (journal 2026-09-16 00:18:27/00:49:53), while REST-fetched message objects take the two-part fall-through and the router silently drops them as unwired-channel chatter with the row terminal `routed` (the 2026-09-16 00:21 incident). Catch-up now injects `thread: { id, parent_id }` (known from the active-threads listing / sweep channel lookup) into synthesized payloads for thread rows, yielding the same identity live traffic is observed to resolve; see `docs/plans/2026-09-16-catchup-thread-context.md`. This correction claims only the observed identity outcome, not the live payload's mechanism (the installed discord-api-types describe neither `thread` for ordinary thread replies nor a `channel_type` gateway extra). The `guild_id` injection requirement and the no-`channel_type` rule stand unchanged.
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

This is the documented **coordinated GWS / NanoClaw / Ringdown release** (docs/nanoclaw/Deployment.md "Coordinated GWS, NanoClaw, and Ringdown release"). A new runtime pin makes the deploy a new release; the strict new-release gate requires a fresh GWS source-sync receipt at the same reviewed wrapper SHA, and the owning runbook — `docs/nanoclaw/how-to-add-gws-google-account.md`, which is explicitly "also the required coordinated-release procedure when a NanoClaw/Yente deployment needs a GWS proxy receipt at the same reviewed wrapper SHA" — is executed COMPLETE: source selection and freeze, the pre-outage contract gate, the idle-gated three-service stop, the stopped-state GWS/skills installation and proof, the Ringdown-last consumer start with receipt proof, and the full acceptance section (Ringdown offline suite and real-Twilio live-call harness are hard gates). Use one coordinated outage; Dan sends no requests during the window; stop on the first failed command; the `BACKUP_RECEIPT`-named backup is the recovery boundary.

The plan does NOT duplicate the runbook's command blocks: run the blocks with these markers, verbatim, in the runbook's documented order — `CUTOVER_SOURCE_SELECTION`, `CUTOVER_FREEZE`, `CUTOVER_PRE_OUTAGE_NANO_GATE`, `CUTOVER_QUIESCE_AND_STOP`, `CUTOVER_STOPPED_INSTALL`, `CUTOVER_START_CONSUMERS`, `CUTOVER_RINGDOWN_ACCEPTANCE`, `CUTOVER_ACCEPTANCE` — resolving the nine inputs plus the backup receipt as this task's steps specify. Do not use a partial or alternate sequence, and do not declare success with any mandatory block unrun.

**Files:**
- Modify (repo `danshapiro/nanoclaw`, branch `overlay/shapiroserver2`): merge of `the-usual/catchup-thread-context`
- Modify (repo `danshapiro/shapiroserver2-private`, branch `main`): `srv/nanoclaw/source.conf`, `changes.md`
- Modify (branch `deploy/nanoclaw`, generated publication): squashed sync from `main`

**Interfaces:**
- Consumes: the full-suite gate result on final HEAD (Step 0 produces it), plus the delta-review PASSED marker.
- Produces: a deployed release pinned by `source.conf`, published on `origin/deploy/nanoclaw`, with the runbook's receipt proof and acceptance evidence.

- [ ] **Step 0: Full-suite gate on the final HEAD (the deploy precondition)**

Run, in the worktree, on the exact commit to be landed:

```bash
pnpm run typecheck && pnpm run lint && pnpm test
```

Expected: typecheck PASS, lint PASS, full vitest suite green, with ONE allowed exception — `src/gws-finalization.test.ts > sealAndDrainGwsCorrelation > accepts systemd credential mode 0440 only from its protected credential directory` (WSL file-mode environment sensitivity). The exception is procedural, not taken on faith: verify it at gate time with

```bash
pnpm exec vitest run src/gws-finalization.test.ts   # expect: 1 failed | 9 passed — the credential-mode row
```

If that test does NOT reproduce its failure exactly as described at the base commit `83e7a84935b1cc4f2529766f438c79d679c5e69f`, it is not an exception and blocks the deploy. The container/Bun suite (`container/agent-runner`, `bun test` in CI) is out of scope for this gate: this change touches no file under `container/` (reasoning recorded here; CI covers it independently). Any NEW red blocks the deploy.

- [ ] **Step 1: Land on `overlay/shapiroserver2` from a dedicated landing worktree and push**

Keep the primary checkout on `main` untouched; land from a second dedicated worktree:

```bash
cd /home/dan/code/nanoclaw-catchup-threadctx
git fetch origin
git worktree add --track -b overlay/shapiroserver2 .worktrees/landing-overlay origin/overlay/shapiroserver2
git -C .worktrees/landing-overlay merge --ff-only the-usual/catchup-thread-context   # if this refuses, rebase the work branch on origin/overlay/shapiroserver2, re-run the Step 0 gate, and retry
git -C .worktrees/landing-overlay push origin overlay/shapiroserver2
git -C .worktrees/landing-overlay rev-parse HEAD   # record this SHA as NANO_SHA
```

- [ ] **Step 2: Pin the release on shapiroserver2 `main`, push, and publish `deploy/nanoclaw`**

All shapiroserver2 edits, commits, and pushes happen in a DEDICATED detached config worktree — the shared root checkout at /home/dan/code/shapiroserver2 is never edited or committed in; it is only fast-forwarded before the deploy lanes run (the lanes require a real `main`-branch checkout at the synchronized tip: deploy-host.sh's `require_exact_wrapper_handoff` refuses detached HEADs and requires HEAD == upstream == origin/main tip).

```bash
# 1. Dedicated config worktree at the current pushed main tip (detached; never touches the root).
git -C /home/dan/code/shapiroserver2 fetch origin
git -C /home/dan/code/shapiroserver2 worktree add --detach \
  /home/dan/code/shapiroserver2/.worktrees/catchup-deploy-config origin/main
cd /home/dan/code/shapiroserver2/.worktrees/catchup-deploy-config

# 2. Edit srv/nanoclaw/source.conf (ref=NANO_SHA) and add the changes.md entry here,
#    then commit detached and push to main.
git add srv/nanoclaw/source.conf changes.md
git commit -m "nanoclaw: pin catch-up thread-context fix (<short sha>)"
git push origin HEAD:refs/heads/main
SHAPIRO_SHA="$(git rev-parse HEAD)"

# 3. Publish deploy/nanoclaw from this same worktree: one squashed commit on
#    the origin tip, tree = main, message carrying the full main SHA (the
#    observed one-commit-per-publish shape, verified byte-identical to main).
git fetch origin deploy/nanoclaw
PUBLISH_SHA="$(git commit-tree "HEAD^{tree}" -p origin/deploy/nanoclaw -m "publish deploy/nanoclaw from main ${SHAPIRO_SHA}")"
git push origin "$PUBLISH_SHA:refs/heads/deploy/nanoclaw"
diff <(git show origin/main:srv/nanoclaw/source.conf) <(git show origin/deploy/nanoclaw:srv/nanoclaw/source.conf)
```

Documented deviation, recorded not compressed: the runbook §0 freeze block also tests `rev-parse origin/deploy/nanoclaw = SHAPIRO_SHA` (publication tip == wrapper commit). That literal equality contradicts the repo's actual publication shape (squash commit with a different SHA, message carrying the wrapper SHA — the shape `origin/deploy/nanoclaw` itself has today, and the shape the 2026-09-16 deploy used). Follow the observed canonical shape and the deploy guard's byte-identity invariant; record this deviation in the changes.md entry.

Before any lane runs, fast-forward the shared root checkout so the lanes see the synchronized `main` (fail closed if another agent's in-flight work blocks it — wait and retry, never force):

```bash
git -C /home/dan/code/shapiroserver2 pull --ff-only origin main   # root stays a convenience checkout on main, never edited
```

- [ ] **Step 3: Source selection and freeze (runbook §0 + §1 + §2)**

Resolve the nine inputs exactly as the runbook's `CUTOVER_SOURCE_SELECTION` and freeze blocks define:

- `NANO_SHA` from `srv/nanoclaw/source.conf` (Step 1's landed SHA);
- `GWS_SHA` from `srv/gws-proxy/reviewed-source.conf` and `RINGDOWN_SHA` from `srv/ringdown/reviewed-source.conf` via `bash srv/lib/read-reviewed-source.sh` (both unchanged by this run — no GWS or Ringdown content changes);
- `SHAPIRO_SHA` (Step 2's main HEAD);
- `LOCAL_SKILLS_SHA`, `YENTE_CONTEXT_SHA`, `FAMILIAR_SHA`, `NYNE_SHA`, `SUMMARIZE_DND_SHA` from the live receipts they must match (read the managed status `/srv/nanoclaw/shared/repos/projects/.managed/status.json` and the runtime manifest on the host read-only, matching what the runbook's `VERIFY_STOPPED`/`VERIFY_RECEIPTS` blocks assert, so the freeze inputs are the deployed-unchanged values);
- `BACKUP_RECEIPT` = the newest complete backup set on the host (newest `daily/*/.backup-complete` set; a partial set never qualifies). All ten values must be nonempty; the nine SHAs must each match `^[0-9a-f]{40}$`.

Run the runbook's `CUTOVER_FREEZE` block (the `prove_main`/`prove_overlay` clean-tree/upstream/remote-tip proofs over all repos, with the Step 2 publication deviation noted above). Record the input TSV as the runbook directs. If personal GWS OAuth consent has expired (runbook §1 verifier), stop and report — Dan must complete a Google consent page before the outage can proceed.

- [ ] **Step 4: Pre-outage NanoClaw contract gate (runbook §3)**

```bash
bash tests/test-full-qa-pass-contract.sh
```

Expected: PASS. This is the repository-owned contract test that the pinned NanoClaw commit's FullQAPass producer matches the repo-owned consumer — a static contract gate, distinct from the live-agent proof capture in Step 8. It must pass before any stop command.

- [ ] **Step 5: Idle gate and three-service stop (runbook §4)**

Run the `CUTOVER_QUIESCE_AND_STOP` block verbatim (no in-progress Twilio calls; no `processing` claims, no active `current_tool`, no fresh session heartbeats; then stop `nanoclaw`, session containers, `ringdown`, `gws-proxy`; assert all three inactive). If the idle gate fails, stop and report — an approved outage does not authorize interrupting active calls or work.

- [ ] **Step 6: Stopped-state installation and proof (runbook §5)**

Run the `CUTOVER_STOPPED_INSTALL` block verbatim: side-effect signing setup, `setup-gws.sh` for both accounts, `srv/deploy.sh gws-proxy --expected-wrapper-sha "$SHAPIRO_SHA" --expected-source-sha "$GWS_SHA"`, `deploy-local-skills.sh`, `apply-managed-repos.sh`, then the full `VERIFY_STOPPED` proof (managed status, runtime manifest including the 25 `gws-*` skills at `GWS_SHA`, `.deploy-source.json` pairing, `promote-gws-skills.sh --validate-only`, and all three consumers still stopped).

- [ ] **Step 7: Start consumers, Ringdown last, with receipt proof (runbook §6)**

Run the `CUTOVER_START_CONSUMERS` block verbatim: `srv/nanoclaw/deploy-host.sh --target prod --expected-wrapper-sha "$SHAPIRO_SHA" --expected-nano-sha "$NANO_SHA"`, then `srv/deploy.sh ringdown --expected-wrapper-sha "$SHAPIRO_SHA" --expected-ringdown-sha "$RINGDOWN_SHA" --expected-gws-sha "$GWS_SHA" --expected-familiar-sha "$FAMILIAR_SHA" --expected-local-skills-sha "$LOCAL_SKILLS_SHA"`, then the `VERIFY_RECEIPTS` block (nanoclaw active; gws-proxy and ringdown healthy; all deployment receipts match the reviewed inputs).

- [ ] **Step 8: Full acceptance (runbook §7)**

Run the `CUTOVER_RINGDOWN_ACCEPTANCE` and `CUTOVER_ACCEPTANCE` blocks verbatim. Hard gates and expectations:

- Ringdown offline suite (`UV_PROJECT_ENVIRONMENT=.venv-wsl uv run pytest -q` in the reviewed `RINGDOWN_WORKTREE`) and the canonical real-Twilio live-call harness (`tests/live_test_all_functions.py`, credentials sourced from the production host into the process only) must both pass; live-call exit 1 is failure, exit 2 is inconclusive and must be rerun.
- The canonical Discord/Yente smoke (`sudo /srv/nanoclaw/run-e2e-smoke.sh --allow-production-mutation`) — the user-requested smoke. Expect green for every GWS judgment scenario and every catch-up/Discord row; failures attributable to the two documented standing-red katas (codex plan/todo tool-surface gap; msgvault-e2e stale session-path check) are triaged with evidence like the 2026-09-16 deploy record, recorded separately and honestly — never described as green when they are not.
- `test-nanoclaw-local-proxies-e2e.sh`, `test-gws-e2e.sh`, `test-full-qa-pass.sh`, current-state-docs, active-contracts: run as the block directs. The broader proof capture (`capture-nanoclaw-live-proof.sh`) is subject to the runbook's own triage: if it is blocked only by the identified unrelated standing red, record the exact blocker, keep focused acceptance standing, and describe broader proof as pending (no fabricated receipt, no hand-written `deployed-release.json`).
- When the capture succeeds, `tests/validate.sh` must report `DEPLOY GATE PASS: deployed NanoClaw release receipt matches source.conf` before any success claim.

- [ ] **Step 9: Record the deploy and push everything**

Update the `changes.md` entry with the actual results (smoke, Ringdown acceptance, standing-red triage, the Step 2 publication deviation, wrapper/GWS/ringdown receipts, previous release retained for rollback) using the SAME dedicated config-worktree flow as Step 2 (detached worktree at the current `origin/main` tip, edit, commit, `git push origin HEAD:refs/heads/main`, then fast-forward the shared root with `git pull --ff-only`). A deploy must not leave local-only commits behind: after pushing, re-fetch and confirm `origin/main` equals the pushed SHA; `deploy/nanoclaw` is pushed; the fork is pushed; all checkouts are clean.

- [ ] **Step 10: Run impacted-test verification**

Read-only production checks: journal shows the new release running (`sudo journalctl -u nanoclaw -n 5` on the host), `current` resolves to `<NANO_SHA>`, and (for a few minutes of watch) Discord catch-up startup runs report `routed=…/failed=0` with no abandon lines.

- [ ] **Step 11: Commit the task**

The commits are Steps 2 and 9 (config repo), the landed merge (fork), and the published squash (deploy/nanoclaw). Verify nothing unpushed remains in any of the three refs.

---

## Self-review

- **Spec coverage:** "Fix the catch-up bug" → Tasks 1–2 (both synthesis sites) + Task 3 (incident path through the real choke point). "Verify with tests" → red/green unit tests, dependency-contract pins, integration regression, full-suite gate (Task 5 Step 0, with the baseline exception verified procedurally at gate time). "Deploy via the standard lane" → Task 5 (source.conf pin + the coordinated GWS/NanoClaw/Ringdown ceremony, user-authorized). "Run the canonical e2e smoke" → Task 5 Step 8. "Push what is deployed" → Task 5 Steps 1–2 (fork + main + deploy/nanoclaw publication) and Step 9 (post-smoke record push).
- **No silent deferrals:** the vendored-adapter contract pins are deliberate dependency-contract tests (green by design, commented as such), not deferred behavior. The pre-existing `gws-finalization` WSL failure is a recorded baseline exception with a reproduction receipt, not a deferral introduced by this plan.
- **File/interface consistency:** `TargetInfo` discriminated union introduced in Task 1 is the only typed-interface change; Task 2's cache and synthesis reuse it; Task 3 consumes only the payload contract. Paths match the worktree layout (`src/channels/...`, `docs/plans/...`).
- **Executable tests:** each red test names the exact assertion that fails pre-fix (`thread` field undefined) and passes post-fix; expected failure reasons match the missing behavior, not setup accidents. The Task 1 pins are explicitly green-by-design dependency pins.
- **Operational completeness:** rollback = pin flip back to `83e7a849` (the immutable previous release; `srv/nanoclaw/rollback-host.sh`). The deploy lane enforces its own backup-window lock. No migrations, no new env keys, no config changes. Production verification is read-only journal checks + the canonical smoke.
- **Known residuals (documented, not deferred):** first-sight threads/channels still skip history replay (original design, unchanged); threads archived between a gap message and the catch-up run remain outside walk coverage and leave no row for the sweep (accepted residual carried over from the original 2026-07-30 design, spec §7 — the fix does not expand coverage there); the already-lost 00:21 message is not backfilled (accepted tradeoff); a monitored-channel message that genuinely fails router engagement after the fix still follows the design's existing terminal-'routed' semantics.
