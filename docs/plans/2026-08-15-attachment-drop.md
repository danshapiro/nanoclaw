# Attachment-Only Discord Message Drop Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Discord messages that carry attachments but have empty text (a file posted with no caption) must reach the router and wake the agent session in the NanoClaw (Yente) runtime, instead of being silently dropped; the Discord route ledger must record a message as routed only when a dispatch handler actually accepted it, so anything genuinely unhandled stays eligible for catch-up retry; regression tests prove both behaviors.

### Explicit constraints
- Keep the change minimal (KISS/YAGNI) — implement only this fix; do not expand scope even if reviewers request it.
- Work only in the dedicated worktree on branch the-usual/attachment-drop of the danshapiro/nanoclaw fork (overlay lineage); follow repo conventions (pnpm, colocated vitest tests, strict TypeScript with ESM .js import specifiers, conventional commits); new regression tests must fail before the production change and pass after.
- No deploys, merges, or production mutations in this run.

### Accepted tradeoffs and residuals
- Deploying the fix (overlay branch integration, source-pin update in the shapiroserver2 config repo, host deploy, and e2e smoke) is a separate later step that requires explicit approval and is outside this run.
- The broader subscription/engagement-gating redesign (e.g., subscribe-on-engage) is explicitly rejected.

**Goal:** Posting a file with no caption to a Yente Discord thread wakes the agent session, and the route ledger only claims `routed` for messages a dispatch handler actually accepted.

**Architecture:** Two one-line-scale production changes plus tests. (1) Widen the Chat SDK bridge's plain-message catch-all registration from `/./` to `/[\s\S]*/` so empty-text messages (attachment-only posts) dispatch to the router instead of matching no handler. (2) Add an acceptance signal — `onForwarded`/`onInboundForwarded` hook in the bridge plus a consume-on-read `wasMessageHandled` tracker wired in the Discord channel — so the discord route wrapper records `routed` only when a handler actually accepted the message, and records `failed` (catch-up eligible, cursor not advanced) otherwise. The router itself needs no change: empty-text-with-attachments already flows cleanly through engage evaluation and attachment materialization; a guard test pins that.

**Tech Stack:** TypeScript (strict, ESM `.js` import specifiers), vitest (colocated `*.test.ts`), better-sqlite3, Chat SDK `chat@4.26.0` / `@chat-adapter/discord@4.26.0` (vendored, read-only), pnpm 10.33.0 on node v22.

## Global Constraints

- No new runtime or dev dependencies. Chat SDK packages under `node_modules/` are vendored and read-only; never edit them.
- pnpm via corepack (`pnpm 10.33.0`, node v22.21.1). Install with `pnpm install --frozen-lockfile`; never `--no-frozen-lockfile`.
- Test fixtures must not touch the network: attachment fixtures either carry inline base64 `data` or have no `url`/`fetchData` (both forms avoid fetches; see `serializeChatSdkAttachmentForInbound`).
- All work happens in this worktree on branch `the-usual/attachment-drop`. Do not commit anything under `.worktrees/.the-usual-logs/` (untracked log area).
- A husky pre-commit hook runs prettier (`pnpm run format:fix` equivalent) on staged files; keep code prettier-clean. Scoped verification per task: `pnpm run typecheck` (whole repo, fast) and `pnpm exec eslint <changed files>`.
- Commit messages: conventional style matching history, e.g. `fix(channels): ...`.

---

### Task 1: Dispatch every plain message, including empty-text attachment-only posts

**Files:**
- Modify: `src/channels/chat-sdk-bridge.ts:496-505` (comment block + `chat.onNewMessage(/./, ...)` registration)
- Test: `src/channels/chat-sdk-bridge.test.ts`

**Interfaces:**
- Consumes: existing `createChatSdkBridge` (src/channels/chat-sdk-bridge.ts:346), Chat SDK dispatch semantics (exclusive: subscribed → mention → pattern), SDK `Message` class and `parseMarkdown` (both exported from `chat`).
- Produces: no new exported interface; behavior change only — the plain-message handler now also fires for empty-text messages.

Root cause this fixes: `chat.onNewMessage(/./, handler)` — `/./.test('')` is `false`, so an attachment-only Discord message (Discord sends `content: ""`) matches no registered handler in an unsubscribed thread, and the Chat SDK resolves dispatch with only a logger line (the bridge sets `logger: 'silent'`), leaving nothing forwarded to the router.

- [ ] **Step 1: Write the failing behavioral test**

Append this describe block to `src/channels/chat-sdk-bridge.test.ts` (the file already imports `createChatSdkBridge`, `closeDb`, `initTestDb`, `runMigrations`, `vi`, `describe`, `expect`, `it`; add imports `Message, parseMarkdown` from `'chat'` and `type ChannelSetup` is already present — extend the existing import statements as needed):

```ts
describe('plain-message catch-all dispatch', () => {
  type DispatchDriver = {
    handleIncomingMessage: (adapter: unknown, threadId: string, message: Message) => Promise<void>;
  };

  function makeMessage(overrides: Record<string, unknown> = {}): Message {
    return new Message({
      id: 'm-1',
      threadId: 'thread-1',
      text: '',
      formatted: parseMarkdown(''),
      raw: {},
      author: { userId: 'user-1', userName: 'user-1', fullName: 'User One', isBot: false, isMe: false },
      metadata: { dateSent: new Date('2026-08-15T04:09:31.975Z'), edited: false },
      attachments: [],
      ...overrides,
    });
  }

  async function makeDispatchHarness(bridgeConfig: { dedupeTtlMs?: number } = {}) {
    const db = initTestDb();
    runMigrations(db);
    const onInbound = vi.fn().mockResolvedValue(undefined);
    let captured: DispatchDriver | null = null;
    const fakeAdapter = {
      name: 'discord',
      userName: 'yente-test',
      initialize: async (chat: unknown) => {
        captured = chat as DispatchDriver;
      },
      channelIdFromThreadId: (threadId: string) => threadId,
      startGatewayListener: async () => new Response('ok'),
    };
    const bridge = createChatSdkBridge({
      adapter: fakeAdapter as never,
      supportsThreads: true,
      botToken: 'test-token',
      ...bridgeConfig,
    });
    await bridge.setup({
      onInbound,
      onInboundEvent: async () => {},
      onMetadata: async () => {},
      onAction: async () => {},
    } as never);
    if (!captured) throw new Error('Chat SDK did not initialize the adapter');
    const driver: DispatchDriver = captured;
    return { bridge, driver, fakeAdapter, onInbound };
  }

  it('forwards an attachment-only message (empty text) to the router', async () => {
    const { bridge, driver, fakeAdapter, onInbound } = await makeDispatchHarness();
    try {
      await driver.handleIncomingMessage(
        fakeAdapter,
        'thread-1',
        makeMessage({
          id: 'm-empty-attach',
          attachments: [{ type: 'file', name: 'report.pdf', size: 3 }],
        }),
      );
      expect(onInbound).toHaveBeenCalledTimes(1);
      const [channelId, threadId, inbound] = onInbound.mock.calls[0] as [
        string,
        string,
        { content: { text?: unknown; attachments?: Array<Record<string, unknown>> } },
      ];
      expect(channelId).toBe('thread-1');
      expect(threadId).toBe('thread-1');
      expect(inbound.content.text).toBe('');
      expect(inbound.content.attachments?.[0]?.name).toBe('report.pdf');
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });

  it('still forwards ordinary text messages (control)', async () => {
    const { bridge, driver, fakeAdapter, onInbound } = await makeDispatchHarness();
    try {
      await driver.handleIncomingMessage(
        fakeAdapter,
        'thread-1',
        makeMessage({ id: 'm-text', text: 'hello', formatted: parseMarkdown('hello') }),
      );
      expect(onInbound).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });

  it('delivers exactly once for a subscribed thread (widening must not double-fire)', async () => {
    const { bridge, driver, fakeAdapter, onInbound } = await makeDispatchHarness();
    try {
      // bridge.subscribe(_platformId, threadId) blind-upserts into
      // chat_sdk_subscriptions (no thread-existence prerequisite); the SDK's
      // subscribed dispatch branch early-returns before the pattern loop, so
      // a subscribed thread takes the subscribed path exactly once even with
      // the widened catch-all.
      await bridge.subscribe!('ignored', 'thread-1'); // (non-null assertion: ChannelAdapter.subscribe is optional; strict tsc requires it here)
      await driver.handleIncomingMessage(
        fakeAdapter,
        'thread-1',
        makeMessage({ id: 'm-sub', text: 'hi there', formatted: parseMarkdown('hi there') }),
      );
      expect(onInbound).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });
});
```

Notes for the implementer:

- The fake adapter mirrors the existing `onGatewayWebhookReady hook` test's harness in this file (`initialize`, `channelIdFromThreadId`, `startGatewayListener`). The Chat SDK calls `adapter.initialize(chat)`-style construction during `new Chat({...})`; capturing through `initialize` is how the test obtains the dispatch driver. `handleIncomingMessage` is a public (deprecated-for-adapters) method on the SDK Chat instance: `handleIncomingMessage(adapter, threadId, message)` — the vendored discord adapter calls it the same way at runtime.
- The attachment fixture has neither `url` nor `fetchData`, so serialization performs no network access.
- `makeDispatchHarness` asserts capture non-null via an explicit throw and a re-assignment to satisfy `strict` narrowing (the closure-assigned variable pattern defeats TS control-flow narrowing without it).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm test src/channels/chat-sdk-bridge.test.ts -t "attachment-only"`

Expected: FAIL because the catch-all is currently `/./`, which does not match the empty string, so no handler fires and `onInbound` is never called. (The control and subscribed-once tests PASS even before the fix; only the attachment-only test fails.)

- [ ] **Step 3: Add the minimal production implementation**

In `src/channels/chat-sdk-bridge.ts`, replace the comment + registration (currently lines 495-505):

```ts
      // Plain messages in unsubscribed threads.
      //
      // Chat SDK dispatch (handling-events.mdx §"Handler dispatch order") is
      // exclusive: subscribed → onSubscribedMessage; unsubscribed+mention →
      // onNewMention; unsubscribed+pattern-match → onNewMessage. Registering
      // with `/[\s\S]*/` — which intentionally also matches the empty string —
      // lets the router see every plain message on every unsubscribed thread
      // the bot can see, including attachment-only posts: Discord sends those
      // with empty content, and the previous `/./` silently dropped them
      // (2026-08-15 incident). The router short-circuits via
      // getMessagingGroupWithAgentCount (~1 DB read) for unwired channels,
      // so forwarding every one is cheap enough to not need a bridge-side
      // flood gate.
      chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
```

(the handler body is unchanged.)

- [ ] **Step 4: Run the focused test**

Run: `pnpm test src/channels/chat-sdk-bridge.test.ts -t "catch-all"`

Expected: PASS (all three tests in the new describe block; `-t "catch-all"` matches the describe name).

- [ ] **Step 5: Refactor while green**

No refactor needed: the production change is a one-token regex widening plus a comment. The test harness is new but small and mirrors the file's existing fake-adapter style; keep it as-is.

- [ ] **Step 6: Run impacted-test verification**

The change widens which messages dispatch in the bridge. Only `src/channels/chat-sdk-bridge.test.ts` exercises bridge dispatch; downstream router tests drive `routeInbound` directly and are unaffected (verified: no existing test relies on empty-text messages being dropped — the baseline suite is green and contains no such expectation).

Run: `pnpm test src/channels/chat-sdk-bridge.test.ts && pnpm run typecheck && pnpm exec eslint src/channels/chat-sdk-bridge.ts src/channels/chat-sdk-bridge.test.ts`

Expected: PASS (exit 0 for each command).

- [ ] **Step 7: Commit the task**

```bash
git add src/channels/chat-sdk-bridge.ts src/channels/chat-sdk-bridge.test.ts
git commit -m "fix(channels): dispatch empty-text plain messages instead of dropping them"
```

---

### Task 2: Bridge acceptance hook (`onForwarded` / `onInboundForwarded`)

**Files:**
- Modify: `src/channels/chat-sdk-bridge.ts` (config interface ~line 148 after `onGatewayWebhookReady`, `forwardChatSdkInboundMessage` ~lines 311-344, `forwardInboundMessage` ~lines 420-440)
- Modify: `src/channels/discord.ts` (YenteDiscordWrapOptions type, new exported tracker constructor, factory wiring) — the sole production `createChatSdkBridge` caller MUST migrate in this same commit: with `onInboundForwarded` required, deferring the factory to Task 3 would fail this task's whole-repo typecheck gate (plan-review round-3 finding 1). The wrapper does not yet CONSUME the new option (Task 3 owns the consult), so Task 2 wires it live but behavior-inert.
- Test: `src/channels/chat-sdk-bridge.test.ts`

**Interfaces:**
- Consumes: existing exported `forwardChatSdkInboundMessage` and its `opts` bag; internal `forwardInboundMessage` closure inside `createChatSdkBridge`; the Task 1 `makeDispatchHarness` (same test file) which already spreads an optional `{ dedupeTtlMs }` arg into `createChatSdkBridge`.
- Produces:
  - `ChatSdkBridgeConfig.onInboundForwarded: (messageId: string) => void` — **required** config-level hook (compile-gated against factory omission), fired by the bridge after every successful inbound forward.
  - `forwardChatSdkInboundMessage` opts field `onForwarded?: (messageId: string) => void` — per-call hook fired with the message id after `onInbound` completes, only on the `'forwarded'` path (not on the same-bot `'dropped'` path).
  - `ChatSdkBridgeConfig.dedupeTtlMs?: number` — plumbed straight into `new Chat({...})` (`dedupeTtlMs: config.dedupeTtlMs`; the SDK defaults to 300000 via `??` when undefined). Task 3 sets it under the discord route lease so catch-up re-presentations of a message id actually re-dispatch (SDK default 300s vs 120s lease would otherwise swallow them pre-dispatch: validated V3). Never use `0` — the SDK's sqlite dedupe treats 0 as permanent (`expires_at = null`), the opposite of disabling.
  - `YenteDiscordWrapOptions.wasMessageHandled?: (messageId: string) => boolean` — added OPTIONAL in this task (the wrapper ignores it until Task 3 flips it required and adds the consult); needed now only so the factory wiring below is type-correct.
  - `createDiscordHandledTracker(): { noteHandled: (id: string) => void; wasHandled: (id: string) => boolean }` — exported from `src/channels/discord.ts`; the factory builds it in this task and Task 3's chain test uses the same constructor.

This is the plumbing Task 3 wires to truthful route bookkeeping. The Chat SDK's dispatch resolves `void` whether or not any handler matched, and the vendored discord adapter's forward resolves either way, so without this hook the wrapper cannot distinguish "handler accepted the message" from "no handler matched".

- [ ] **Step 1: Write the failing behavioral test**

Add two things to `src/channels/chat-sdk-bridge.test.ts`:

(a) A re-dispatch test appended INSIDE the Task 1 `'plain-message catch-all dispatch'` describe (it reuses `makeDispatchHarness` and `makeMessage` from Task 1 — the harness already accepts the optional `{ dedupeTtlMs?: number }` bag that Task 1 added for exactly this purpose, and the spread into `createChatSdkBridge({...})` keeps the pre-fix run free of excess-property type errors; textually it lives there, but it is implemented in this task because the plumbing it proves is this task's production change):

```ts
  it('re-dispatches a re-presented message id once the configured dedupeTtlMs has elapsed', async () => {
    const { bridge, driver, fakeAdapter, onInbound } = await makeDispatchHarness({ dedupeTtlMs: 1 });
    try {
      const msg = makeMessage({
        id: 'm-redeliver',
        threadId: 'thread-9',
        text: 'ping',
        formatted: parseMarkdown('ping'),
      });
      await driver.handleIncomingMessage(fakeAdapter, 'thread-9', msg);
      expect(onInbound).toHaveBeenCalledTimes(1);
      // Configured dedupe TTL is 1ms; the awaited dispatch above plus this
      // sleep guarantee expiry. This models catch-up re-presentation (minutes
      // later in production); the SDK's 300s default would swallow it.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await driver.handleIncomingMessage(fakeAdapter, 'thread-9', msg);
      expect(onInbound).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });
```

(b) This describe block, next to the existing `'Chat SDK bridge same-bot ingress guard'` describe (which already imports and unit-tests `forwardChatSdkInboundMessage`):

```ts
describe('forward acknowledgment hook', () => {
  const userAuthor = { userId: 'user-1', userName: 'user-1', fullName: 'User One', isBot: false, isMe: false };
  const botSelfAuthor = { userId: 'bot-1', userName: 'bot-1', fullName: 'bot-1', isBot: true, isMe: true };

  function ackHarness() {
    return {
      onInbound: vi.fn().mockResolvedValue(undefined),
      toInbound: vi.fn().mockResolvedValue({
        id: 'm1',
        kind: 'chat-sdk',
        content: {},
        timestamp: new Date().toISOString(),
        isMention: false,
        isGroup: true,
      }),
      onForwarded: vi.fn(),
    };
  }

  it('fires onForwarded with the message id after a successful inbound forward', async () => {
    const { onInbound, toInbound, onForwarded } = ackHarness();
    await expect(
      forwardChatSdkInboundMessage({
        adapterName: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
        message: { id: 'm1', author: userAuthor },
        isMention: false,
        isGroup: true,
        source: 'plain',
        onInbound,
        toInbound,
        onForwarded,
      }),
    ).resolves.toBe('forwarded');
    expect(onForwarded).toHaveBeenCalledTimes(1);
    expect(onForwarded).toHaveBeenCalledWith('m1');
  });

  it('does not fire onForwarded when the same-bot guard drops the message', async () => {
    const { onInbound, toInbound, onForwarded } = ackHarness();
    await expect(
      forwardChatSdkInboundMessage({
        adapterName: 'discord',
        channelId: 'channel-1',
        threadId: 'thread-1',
        message: { id: 'm-self', author: botSelfAuthor },
        isMention: false,
        isGroup: true,
        source: 'plain',
        onInbound,
        toInbound,
        onForwarded,
      }),
    ).resolves.toBe('dropped');
    expect(onForwarded).not.toHaveBeenCalled();
    expect(onInbound).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `pnpm test src/channels/chat-sdk-bridge.test.ts -t "re-dispatches"` and `pnpm test src/channels/chat-sdk-bridge.test.ts -t "acknowledgment"`

Expected: the re-dispatch test FAILS because the bridge does not plumb `dedupeTtlMs` yet — the SDK default of 300s swallows the second dispatch of the same message id, so `onInbound` is called only once. (Runtime ignores unknown config fields, so there is no typecheck noise here: spreading an options object into `createChatSdkBridge({...})` does not trigger excess-property checks.) The acknowledgment tests FAIL because `forwardChatSdkInboundMessage` does not accept or invoke `onForwarded` yet — the first test observes `onForwarded` called zero times; additionally strict typecheck rejects the unknown option until the implementation lands.

- [ ] **Step 3: Add the minimal production implementation**

Four edits in `src/channels/chat-sdk-bridge.ts`:

1. In `ChatSdkBridgeConfig`, after the `onGatewayWebhookReady` field (end of the interface), add:

```ts
  /**
   * Called with the platform message id immediately after a message is
   * actually forwarded inbound — i.e. a registered Chat SDK handler accepted
   * it and the host `onInbound` completed. Chat SDK dispatch resolves void
   * whether or not any handler matched, and the vendored adapters' forwards
   * resolve either way, so channels that keep route bookkeeping (Discord) use
   * this to distinguish "dispatched to a handler" from "no handler matched".
   * REQUIRED (not optional) so that wiring it is compile-gated: an optional
   * hook could be silently dropped by a channel factory, leaving every routed
   * message recorded as failed (plan-review round-2 finding 2).
   */
  onInboundForwarded: (messageId: string) => void;
  /**
   * Override for the Chat SDK's incoming-message dedupe TTL (default 300s).
   * Channels with their own idempotent claim/replay layer (Discord's
   * message-route claim + catch-up) set this BELOW their re-presentation
   * cadence so a re-presented message id dispatches again; the SDK layer
   * then only absorbs same-process duplicate bursts. Never set 0: the SDK's
   * sqlite dedupe treats 0 as no-expiry (permanent dedupe).
   */
  dedupeTtlMs?: number;
```

2. In `forwardChatSdkInboundMessage`, extend the `opts` type with `onForwarded?: (messageId: string) => void;`, add it to the destructure, and invoke it after the forward:

```ts
export async function forwardChatSdkInboundMessage<
  TMessage extends {
    id: string;
    author?: { isMe?: boolean; userId?: string; userName?: string };
  },
>(opts: {
  adapterName: string;
  channelId: string;
  threadId: string | null;
  message: TMessage;
  isMention: boolean;
  isGroup: boolean;
  source: ChatSdkForwardSource;
  onInbound: ChannelSetup['onInbound'];
  toInbound: (message: TMessage, isMention: boolean, isGroup: boolean) => Promise<InboundMessage>;
  onForwarded?: (messageId: string) => void;
}): Promise<'dropped' | 'forwarded'> {
  const { adapterName, channelId, threadId, message, isMention, isGroup, source, onInbound, toInbound, onForwarded } =
    opts;
  if (isOwnChatSdkMessageForTest(message)) {
    // ... unchanged same-bot guard body ...
  }

  await onInbound(channelId, threadId, await toInbound(message, isMention, isGroup));
  onForwarded?.(message.id);
  return 'forwarded';
}
```

3. In `forwardInboundMessage` (closure inside `createChatSdkBridge`), pass the config hook through:

```ts
  async function forwardInboundMessage(
    channelId: string,
    threadId: string,
    message: ChatMessage,
    isMention: boolean,
    isGroup: boolean,
    source: ChatSdkForwardSource,
  ): Promise<void> {
    await forwardChatSdkInboundMessage({
      adapterName: adapter.name,
      channelId,
      threadId,
      message,
      isMention,
      isGroup,
      source,
      // Prefer the strict variant so router failures propagate and the
      // acceptance hook stays silent — the message remains catch-up eligible
      // instead of being falsely marked routed (delta-review round-1 fix).
      onInbound: setupConfig.onInboundStrict ?? setupConfig.onInbound,
      toInbound: messageToInbound,
      onForwarded: config.onInboundForwarded,
    });
  }
```

(The strict-preferred pass-through was added by delta-review remediation; two acceptance-contract tests — strict path preferred, hook silent when strict rejects — live in the same describe block. The harness gained an optional `setupOverrides` bag to support them; see commit 0da9782f.)

4. Plumb the dedupe override into the Chat construction in `setup()` (the SDK is fine with an explicit `undefined` — it consumes the value via `?? DEDUPE_TTL_MS`):

```ts
      chat = new Chat({
        adapters: { [adapter.name]: adapter },
        userName: adapter.userName || 'NanoClaw',
        concurrency: config.concurrency ?? 'concurrent',
        dedupeTtlMs: config.dedupeTtlMs,
        state,
        logger: 'silent',
      });
```

5. Because `onInboundForwarded` is required, update every existing `createChatSdkBridge` construction that does not yet pass it (complete census, verified by grep):
   - `src/channels/chat-sdk-bridge.test.ts:138` and `:285` (outbound-splitting tests): add `onInboundForwarded: vi.fn()`;
   - `src/channels/chat-sdk-bridge.test.ts:405` (onGatewayWebhookReady test): add `onInboundForwarded: vi.fn()`;
   - Task 1's `makeDispatchHarness` (same file, its `createChatSdkBridge` call): add `onInboundForwarded: vi.fn()`.

6. In `src/channels/discord.ts`, add the OPTIONAL wrapper option (the consult arrives in Task 3; this exists now so the factory wiring is type-correct):

```ts
  /**
   * Consume-on-read acceptance probe wired from the bridge's onInboundForwarded
   * hook: returns true exactly once per message id a dispatch handler actually
   * forwarded. Optional in this task; the wrapper begins consulting it (and
   * the option becomes required) in the follow-up bookkeeping change.
   */
  wasMessageHandled?: (messageId: string) => boolean;
```

7. In `src/channels/discord.ts`, add the exported tracker constructor (module scope, near `wrapYenteDiscordChannelIds`; no cap — plan-review round-1 finding 5: a FIFO cap can evict a still-pending acknowledgment under wide concurrency, and no leak path exists: entries are added only by a successful inbound forward and always consumed by the consult that the same forward reaches; reject paths throw before the hook fires):

```ts
/**
 * Acceptance tracker shared by the chat-sdk bridge's onInboundForwarded hook
 * (writer) and the wrapped adapter's outcome block (consume-on-read reader
 * via Set.delete). Entries are added only by a successful inbound forward and
 * always consumed by the consult that the same forward reaches, so the set
 * stays near zero by construction. Exported so production and tests build the
 * tracker from the SAME constructor.
 */
export function createDiscordHandledTracker(): { noteHandled: (id: string) => void; wasHandled: (id: string) => boolean } {
  const handled = new Set<string>();
  return {
    noteHandled: (id) => {
      handled.add(id);
    },
    wasHandled: (id) => handled.delete(id),
  };
}
```

8. In the discord channel factory, just before `return createChatSdkBridge({`, build the tracker and wire BOTH ends (the bridge hook — required from this task — and the wrapper option — inert until Task 3):

```ts
    const handledTracker = createDiscordHandledTracker();
```

```ts
      adapter: wrapYenteDiscordChannelIds(discordAdapter, botToken, autoCreateThreadChannelIds, {
        monitoredChannelIds: channelIds,
        routeLeaseMs: catchupConfig.routeLeaseMs,
        onGatewayEvent: (type) => catchup?.onGatewayEvent(type),
        wasMessageHandled: handledTracker.wasHandled,
      }),
```

```ts
      onInboundForwarded: handledTracker.noteHandled,
```

- [ ] **Step 4: Run the focused tests**

Run: `pnpm test src/channels/chat-sdk-bridge.test.ts -t "re-dispatches"` and `pnpm test src/channels/chat-sdk-bridge.test.ts -t "acknowledgment"`

Expected: PASS (both)

- [ ] **Step 5: Refactor while green**

No refactor needed: two optional config fields and one pass-through hook added along existing options-bag paths, mirroring the file's conventions.

- [ ] **Step 6: Run impacted-test verification**

The bridge module, its direct consumers, and the discord factory change. `forwardChatSdkInboundMessage`'s only production caller is `forwardInboundMessage` in the same file; the factory wiring is behavior-inert until Task 3, but discord tests run to prove the factory edit and optional wrapper field break nothing.

Run: `pnpm test src/channels/chat-sdk-bridge.test.ts src/channels/discord.test.ts && pnpm run typecheck && pnpm exec eslint src/channels/chat-sdk-bridge.ts src/channels/chat-sdk-bridge.test.ts src/channels/discord.ts`

Expected: PASS (exit 0 for each command).

- [ ] **Step 7: Commit the task**

```bash
git add src/channels/chat-sdk-bridge.ts src/channels/chat-sdk-bridge.test.ts src/channels/discord.ts
git commit -m "feat(channels): acceptance-forwarded hook, dedupe TTL, and live-but-inert discord acceptance wiring"
```

---

### Task 3: Truthful Discord route bookkeeping via the acceptance signal

**Files:**
- Modify: `src/channels/discord.ts` (`YenteDiscordWrapOptions` type ~lines 419-425, `wrapYenteDiscordChannelIds` signature + option destructuring ~lines 426-432, wrapper pre-claim area + step-3 outcome block ~lines 495-576, channel factory wiring ~lines 83-115)
- Modify: `src/channels/discord-catchup.ts` (`DiscordCatchupDeps` type ~line 108, `DiscordCatchupRunSummary` type ~line 92 + init ~line 376, walk message loop ~lines 218-235)
- Modify (call-site updates only, all in `src/channels/`): `discord-catchup.test.ts` helper ~line 154 plus direct constructions at ~lines 379 and 523, `discord-catchup.integration.test.ts:125` (all gain `botUserId`), `discord-catchup.integration.test.ts:77` and the two direct calls in `discord.test.ts` at ~lines 466 and 520 (all gain `wasMessageHandled`; these with the production factory at discord.ts:100 and the helper at discord.test.ts:393 are the COMPLETE inventory of `wrapYenteDiscordChannelIds` calls — verified by grep — just as the five `createDiscordCatchup` constructions are the complete inventory for the deps change)
- Test: `src/channels/discord.test.ts` (extend the `wrap()` helper; add tests), `src/channels/discord-catchup.test.ts` (add the walk-skip test)

**Interfaces:**
- Consumes: `ChatSdkBridgeConfig.onInboundForwarded` (required) and `ChatSdkBridgeConfig.dedupeTtlMs` from Task 2; the optional `YenteDiscordWrapOptions.wasMessageHandled`, the exported `createDiscordHandledTracker`, and the live-but-inert factory wiring (tracker + both ends) all landed in Task 2; `DiscordAdapter.botUserId` (public readonly, set at adapter construction — verified in vendored `@chat-adapter/discord` dist); the applicationId string the factory already resolves for the adapter constructor.
- Produces:
  - `YenteDiscordWrapOptions.wasMessageHandled: (messageId: string) => boolean` — flipped from optional to **required** here; the wrapper outcome block now consults it (consume-on-read acceptance probe wired by Task 2's `createDiscordHandledTracker`, which the chain test also uses — round-2 finding 2: hand-mirrored wiring in tests proves nothing about production).
  - `dedupeTtlForRouteLease(routeLeaseMs: number): number` — exported pure derivation (`Math.max(1, Math.floor(routeLeaseMs / 4))`) used by the factory and unit-tested.
  - `DiscordCatchupDeps.botUserId: string` — **required**; the catch-up walk skips own-bot messages (advance cursor, continue) or the wrapper's bypass would wedge the walk at a row-less message (plan-review round-2 finding 1).

Current bug this fixes: after `originalHandleForwardedMessage` resolves, the wrapper calls `markDiscordMessageRouted` unconditionally (src/channels/discord.ts:552). The vendored adapter resolves even when no dispatch handler matched (e.g. the Task 1 drop), so the ledger recorded a never-handled message as terminal `routed` and catch-up could never retry it.

Design: the Discord channel factory holds a shared `Set<string>`. The bridge's `onInboundForwarded` hook adds ids; the wrapper's step-3 outcome consults via `Set.delete` (consume-on-read: one forward → one consult). The bot's OWN messages are bypassed BEFORE the claim and forward entirely (they are intentionally never dispatched — the SDK filters them pre-dispatch via isMe and the bridge same-bot guard drops any remainder), so they never enter the ledger: that keeps the invariant "`routed` is recorded only when a dispatch handler actually accepted the message" true by construction, with no falsely-terminal rows and no catch-up churn (plan-review finding 3).

Retry-honesty alignment (from load-bearing validation V3, confirmed): the Chat SDK dedupes incoming message ids for a per-instance TTL defaulting to 300s, planted before dispatch with no compensation delete. The discord route lease (default 120s, env-configurable down to milliseconds) is the minimum catch-up re-presentation cadence, and attempts increment only on claim (cap 3), so without an override a message marked `failed` for "no handler matched" can be abandoned after as few as two in-window sweeps — each re-claim burns an attempt while the dedupe entry short-circuits the re-presentation BEFORE dispatch, no handler ever runs, and the row goes terminal with zero real retries. The factory therefore sets `dedupeTtlMs: dedupeTtlForRouteLease(catchupConfig.routeLeaseMs)` — one quarter of the configured lease, clamped to ≥1ms (the SDK treats 0 as permanent dedupe) — so every catch-up re-presentation reaches dispatch and burns an attempt only when a handler actually did not accept the message again. A fixed 30s constant was rejected at plan review (finding 2) because it is only safe against the default lease; the derivation tracks whatever lease is configured.

- [ ] **Step 1: Write the failing behavioral tests**

1. Extend the `wrap()` helper inside the existing `'wrapYenteDiscordChannelIds ingress claim'` describe in `src/channels/discord.test.ts` to accept the probe (default preserving the fake's always-handles semantics):

```ts
  function wrap(
    fake: ReturnType<typeof fakeAdapter>,
    autoThread: string[] = [],
    monitored: string[] = ['chan-1'],
    // Default matches this fake adapter's semantics: its handleForwardedMessage
    // always "handles" the message.
    wasMessageHandled: (messageId: string) => boolean = () => true,
  ) {
    return wrapYenteDiscordChannelIds(
      fake as unknown as Parameters<typeof wrapYenteDiscordChannelIds>[0],
      'test-token',
      new Set(autoThread),
      { monitoredChannelIds: () => new Set(monitored), routeLeaseMs: 120000, wasMessageHandled },
    ) as unknown as {
      handleForwardedMessage: (data: unknown, options: unknown) => Promise<unknown>;
      forwardGatewayEvent: (webhookUrl: string, event: { type: string }) => Promise<void>;
    };
  }
```

2. Add these tests to the same describe block (import `getDiscordMessageRouteStatus`, `getDiscordChannelCursor`, `listRetriableDiscordMessageRoutes` from `./discord-state.js` — extend the existing state import):

```ts
  it('marks a message failed, not routed, when no dispatch handler accepted it', async () => {
    const fake = fakeAdapter();
    const forwardSpy = fake.handleForwardedMessage;
    const wrapped = wrap(fake, [], ['chan-1'], () => false);
    const cursorBefore = getDiscordChannelCursor('chan-1');

    await wrapped.handleForwardedMessage(message('m-unhandled'), {});

    expect(forwardSpy).toHaveBeenCalledTimes(1); // message is still forwarded to the SDK
    expect(getDiscordMessageRouteStatus('chan-1', 'm-unhandled')).toBe('failed');
    expect(isDiscordMessageTerminal('chan-1', 'm-unhandled')).toBe(false);
    expect(getDiscordChannelCursor('chan-1')).toBe(cursorBefore); // cursor not advanced

    // Catch-up eligibility: failed + attempts < max + lease expired (lease is 120s).
    const horizon = '2020-01-01T00:00:00.000Z';
    const afterLease = new Date(Date.now() + 121_000).toISOString();
    expect(listRetriableDiscordMessageRoutes(afterLease, horizon, 50).map((r) => r.message_id)).toContain(
      'm-unhandled',
    );
  });

  it("bypasses the ledger and the SDK entirely for the bot's own messages", async () => {
    const fake = { ...fakeAdapter(), botUserId: 'bot-1' };
    const forwardSpy = fake.handleForwardedMessage;
    const wrapped = wrap(fake, [], ['chan-1'], () => false);
    const cursorBefore = getDiscordChannelCursor('chan-1');
    const ownMessage = { ...message('m-own'), author: { id: 'bot-1', bot: true } };

    const result = await wrapped.handleForwardedMessage(ownMessage, {});

    expect(result).toBeUndefined();
    // The SDK filters isMe messages pre-dispatch, so forwarding them is
    // pointless — and no ledger row may exist for a message no dispatch
    // handler could ever accept (the requested invariant).
    expect(forwardSpy).not.toHaveBeenCalled();
    expect(getDiscordMessageRouteStatus('chan-1', 'm-own')).toBeNull();
    expect(getDiscordChannelCursor('chan-1')).toBe(cursorBefore);
  });
```

3. Add a `dedupeTtlForRouteLease` unit-test describe. Use a dynamic import so the missing-export red fails only THIS test (a static import of a not-yet-exported symbol would fail the whole file at module load):

```ts
describe('dedupeTtlForRouteLease', () => {
  it('derives a dedupe TTL strictly below any configured route lease, never zero', async () => {
    const mod = (await import('./discord.js')) as unknown as {
      dedupeTtlForRouteLease?: (routeLeaseMs: number) => number;
    };
    if (!mod.dedupeTtlForRouteLease) throw new Error('dedupeTtlForRouteLease not exported');
    const derive = mod.dedupeTtlForRouteLease;
    expect(derive(120_000)).toBe(30_000); // default lease
    expect(derive(100)).toBe(25);
    expect(derive(3)).toBe(1); // clamped: 0 would mean permanent dedupe in the SDK
    expect(derive(1)).toBe(1);
  });
});
```

4. Add ONE chain integration test (plan-review findings: round-1 finding 4 — unit tests inject the probe manually; round-2 finding 2 — hand-mirrored factory wiring proves nothing; round-3 finding 2 — resolved by sequencing, since Task 2 already exports the constructor). New top-level describe in `src/channels/discord.test.ts` — it uses `createDiscordHandledTracker` (the SAME constructor the production factory uses, exported statically in Task 2; add it to the existing `./discord.js` import alongside `wrapYenteDiscordChannelIds`), and needs `Message` and `parseMarkdown` from `'chat'` and `createChatSdkBridge` from `./chat-sdk-bridge.js` added to imports:

```ts
describe('discord ingress chain: bridge dispatch → acceptance hook → ledger', () => {
  it('marks routed only when the real dispatch chain accepted the message', async () => {
    const db = initTestDb();
    runMigrations(db);
    const onInbound = vi.fn().mockResolvedValue(undefined);
    // Same tracker constructor as the production factory; bridge hook writes,
    // wrapper consults via consume-on-read delete.
    const tracker = createDiscordHandledTracker();
    let captured: {
      handleIncomingMessage(adapter: unknown, threadId: string, message: Message): Promise<void>;
    } | null = null;
    const fake = {
      name: 'discord',
      userName: 'yente-test',
      initialize: async (chat: unknown) => {
        captured = chat as never;
      },
      channelIdFromThreadId: (threadId: string) => threadId,
      startGatewayListener: async () => new Response('ok'),
      // The wrapper binds the outbound methods at wrap time; stub them like fakeAdapter().
      postMessage: vi.fn(async () => 'mid'),
      editMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
      removeReaction: vi.fn(async () => undefined),
      startTyping: vi.fn(async () => undefined),
      // Mirrors the vendored adapter: its forward awaits chat.handleIncomingMessage.
      handleForwardedMessage: vi.fn(
        async (data: { id: string; channel_id: string; author: { id: string }; content: string }) => {
          const driver = captured; // closure assignment defeats narrowing; re-check
          if (!driver) throw new Error('Chat SDK did not initialize the adapter');
          await driver.handleIncomingMessage(
            fake,
            data.channel_id,
            new Message({
              id: data.id,
              threadId: data.channel_id,
              text: data.content,
              formatted: parseMarkdown(data.content),
              raw: data,
              author: {
                userId: data.author.id,
                userName: data.author.id,
                fullName: data.author.id,
                isBot: false,
                isMe: false,
              },
              metadata: { dateSent: new Date(), edited: false },
              attachments: [],
            }),
          );
          return 'handled';
        },
      ),
    };
    const wrappedAdapter = wrapYenteDiscordChannelIds(fake as never, 'test-token', new Set(), {
      monitoredChannelIds: () => new Set(['chan-1']),
      routeLeaseMs: 120000,
      wasMessageHandled: tracker.wasHandled,
    });
    // Same structural cast as the wrap() helper: handleForwardedMessage is
    // private on the vendored adapter's class type.
    const wrapped = wrappedAdapter as unknown as {
      handleForwardedMessage: (data: unknown, options: unknown) => Promise<unknown>;
    };
    const bridge = createChatSdkBridge({
      adapter: wrappedAdapter as never,
      supportsThreads: true,
      botToken: 'test-token',
      onInboundForwarded: tracker.noteHandled,
    });
    try {
      await bridge.setup({
        onInbound,
        onInboundEvent: async () => {},
        onMetadata: async () => {},
        onAction: async () => {},
      } as never);
      if (!captured) throw new Error('Chat SDK did not initialize the adapter');

      await wrapped.handleForwardedMessage(
        {
          id: 'm-chain',
          channel_id: 'chan-1',
          guild_id: 'guild-1',
          author: { id: 'user-1', bot: false },
          content: 'hello',
          mentions: [],
          attachments: [],
        },
        {},
      );

      // A real dispatch handler accepted the message.
      expect(onInbound).toHaveBeenCalledTimes(1);
      // The wrapper consumed the acceptance signal (regression pin: pre-fix
      // the wrapper never consults the probe, so the entry is still pending
      // and this second consult observes it).
      expect(tracker.wasHandled('m-chain')).toBe(false);
      // ...so the ledger says routed and the monitored cursor advanced.
      expect(getDiscordMessageRouteStatus('chan-1', 'm-chain')).toBe('routed');
      expect(isDiscordMessageTerminal('chan-1', 'm-chain')).toBe(true);
      expect(getDiscordChannelCursor('chan-1')).toBe('m-chain');
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });
});
```

5. Update the three remaining direct `wrapYenteDiscordChannelIds` call sites to pass `wasMessageHandled: () => true` with the same "fake always handles" comment, since the option becomes required:
   - `src/channels/discord-catchup.integration.test.ts:77`;
   - `src/channels/discord.test.ts` ~line 466 (`'marks the route failed (keeping the lease) and rethrows; immediate retries drop, post-lease retries route'` — its final assertion expects the post-lease re-claim to be marked `routed`, which the always-handles probe preserves);
   - `src/channels/discord.test.ts` ~line 520 (`'taps gateway event types before forwarding'` — never calls `handleForwardedMessage`, but the type is required).

6. Add the catch-up walk own-bot skip test to `src/channels/discord-catchup.test.ts` (plan-review round-2 finding 1: without a walk-side skip, the bypassed own-bot message wedges the walk; round-3 finding 4's fixture corrections are incorporated: needle `'/channels/chan-1'` — the channel-info URL carries no query, so a `'...chan-1?'` needle never matches; `restMessage(id, overrides)` builds page messages; the cursor is pre-seeded with `advanceDiscordChannelCursor`, no init run; `webhookPosts` entries expose `.data.id`; `getDiscordChannelCursor` is already imported in this file):

```ts
  it("skips the bot's own messages in the walk (advance cursor, no POST, no stall)", async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    const page = [
      restMessage('601', { author: { id: 'bot-1', bot: true }, content: 'yente reply' }),
      restMessage('602', { content: 'missed question' }),
    ];
    const { fetchImpl, webhookPosts } = fakeTransport({
      // Insertion order matters: the page URL also contains '/channels/chan-1'.
      'messages?after=': [json(page), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('periodic');

    // Without the skip, the own-bot message 601 POSTs too, stays row-less
    // (the wrapper bypass never writes a row), and the walk stops at it
    // forever — the user message 602 behind it is never presented.
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['602']);
    expect(summary?.skippedOwnBot).toBe(1);
    expect(summary?.routed).toBe(1);
    // The skip advanced the cursor past the own-bot message (no stall, no
    // unbounded re-presentation; the user's message advanced it to its own id).
    expect(getDiscordChannelCursor('chan-1')).toBe('602');
  });
```

7. Add `botUserId` to every existing `createDiscordCatchup` construction (the deps field becomes required; complete census, verified by grep):
   - `src/channels/discord-catchup.test.ts` — the `makeEngine` helper (~line 154): add `botUserId: 'bot-1'`; the two direct constructions (~lines 379 and 523): add `botUserId: 'bot-1'` (their existing pages never carry `author.id: 'bot-1'`, so behavior is unchanged);
   - `src/channels/discord-catchup.integration.test.ts:125`: add `botUserId: 'bot-1'`.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `pnpm test src/channels/discord.test.ts src/channels/discord-catchup.test.ts`

Expected: five intended reds (pre-existing tests stay green):
- `'marks a message failed, not routed, when no dispatch handler accepted it'` FAILS because the wrapper still marks every message `routed` unconditionally — it observes status `routed` instead of `failed`.
- `'bypasses the ledger and the SDK entirely for the bot's own messages'` FAILS because there is no pre-claim bypass yet — the wrapper claims and forwards, so `forwardSpy` HAS been called and a `routed` row exists.
- `'dedupeTtlForRouteLease ... never zero'` FAILS because `dedupeTtlForRouteLease` is not exported yet (the dynamic import exposes `undefined` and the test throws).
- the chain test FAILS on `expect(tracker.wasHandled('m-chain')).toBe(false)` because the pre-fix wrapper never consults the acceptance signal — even though the Task 2 hook correctly wrote `m-chain` (so `onInbound` and `routed` assertions already hold). The consumed-entry assertion is the chain's fail-first pin; the rest is characterization.
- the walk skip test FAILS pre-fix on two counts: `webhookPosts` contains BOTH `601` and `602` (no skip), and `summary?.skippedOwnBot` is undefined (field does not exist yet).

- [ ] **Step 3: Add the minimal production implementation**

All edits in `src/channels/discord.ts`:

1. `YenteDiscordWrapOptions` — flip the Task-2 optional probe to required (update its doc comment to drop the "Optional in this task" sentence):

```ts
export type YenteDiscordWrapOptions = {
  monitoredChannelIds?: () => Set<string>;
  routeLeaseMs?: number;
  onGatewayEvent?: (type: string) => void;
  now?: () => string;
  /**
   * Consume-on-read acceptance signal wired from the chat-sdk bridge's
   * onInboundForwarded hook at the channel factory: returns true exactly once
   * per message id a dispatch handler actually forwarded. Chat SDK dispatch
   * resolves void whether or not a handler matched, and the vendored adapter's
   * forward resolves either way, so without this signal the wrapper cannot
   * tell "handler accepted" apart from "no handler matched".
   */
  wasMessageHandled: (messageId: string) => boolean;
};
```

2. `wrapYenteDiscordChannelIds` — remove the now-illegal `= {}` default (plan-review finding 1: with `wasMessageHandled` required, `{}` is not assignable; every call site passes options — census verified) and destructure alongside `monitoredChannelIds`:

```ts
export function wrapYenteDiscordChannelIds(
  adapter: DiscordAdapterInstance,
  botToken: string,
  autoCreateThreadChannelIds: Set<string> = new Set(),
  options: YenteDiscordWrapOptions,
): DiscordAdapterInstance {
```

```ts
  const wasMessageHandled = options.wasMessageHandled;
```

3. Pre-claim own-bot bypass (plan-review finding 3) — insert immediately BEFORE the `// 1. Idempotency gate` claim section:

```ts
    // The bot's own messages are intentionally never dispatched (the SDK
    // filters isMe messages before dispatch), so no dispatch handler can ever
    // accept one. Bypass the ledger and the forward entirely: a route row
    // could only ever be a lie against the invariant "'routed' means a
    // dispatch handler accepted the message".
    const authorId = (data?.author as { id?: string } | undefined)?.id;
    if (authorId !== undefined && authorId === rawAdapter.botUserId) {
      return undefined;
    }
```

4. Wrapper step-3 outcome block — replace the unconditional bookkeeping with:

```ts
    // 3. Forward, then record the outcome (fail-open on state errors). The
    //    bridge dispatches with concurrency 'concurrent', so the acceptance
    //    hook written during dispatch is synchronously visible by the time the
    //    vendored forward resolves.
    try {
      const result = await originalHandleForwardedMessage(dataArg, opts, ...rest);
      try {
        const routedAt = nowIso();
        if (wasMessageHandled(messageId)) {
          markDiscordMessageRouted(channelId, messageId, routedAt);
          const monitored = monitoredChannelIds();
          const parentId = (dataArg as Record<string, any>)?.thread?.parent_id as string | undefined;
          if (monitored.has(channelId) || (parentId !== undefined && monitored.has(parentId))) {
            advanceDiscordChannelCursor(channelId, messageId, routedAt);
          }
        } else {
          // No dispatch handler accepted this message. Record it failed (not
          // routed) and leave the cursor behind so catch-up keeps
          // re-presenting it; the attempts cap still bounds a poison message.
          log.warn('Discord message accepted by no dispatch handler; marked failed for catch-up', {
            channelId,
            messageId,
          });
          markDiscordMessageFailed(channelId, messageId, routedAt, 'no dispatch handler matched');
        }
      } catch (error) {
        log.error('Discord route bookkeeping failed', { channelId, messageId, error: String(error) });
      }
      return result;
    } catch (error) {
```

(the trailing `catch` block is unchanged).

(post-remediation, delta review round 4: markDiscordMessageFailed carries a `status != 'routed'` guard — routed rows are monotonic and never regress)

(post-remediation, delta review round 6: catch-up replay is idempotent at the router's deterministic session-write seam, so a partially delivered route can be re-presented without PK collisions; the quarter-of-lease dedupe guarantee is documented as strict for leases ≥ 2 ms, with degenerate sub-2 ms leases an accepted residual)

5. The tracker constructor, factory wiring of BOTH acceptance ends, and the wrap options were landed live-but-inert in Task 2 — nothing further to add here. This task's only remaining factory edit is the lease-derived dedupe alignment on the `createChatSdkBridge({...})` config object:

```ts
      // Derived from the configured route lease (never 0 — the SDK treats 0
      // as permanent dedupe): the SDK's 300s default would let catch-up
      // re-presentations short-circuit before dispatch and burn the 3-attempt
      // cap with zero real retries (load-bearing V3).
      dedupeTtlMs: dedupeTtlForRouteLease(catchupConfig.routeLeaseMs),
```

6. Add the exported pure derivation (module scope, near `wrapYenteDiscordChannelIds`):

```ts
/**
 * SDK incoming-message dedupe TTL derived from the configured route lease:
 * the lease is the minimum catch-up re-presentation cadence, so a TTL of one
 * quarter guarantees every re-presentation lands after the SDK dedupe entry
 * expired and genuinely re-dispatches. Clamped to >= 1ms because the SDK's
 * sqlite dedupe treats 0 as no-expiry (permanent dedupe).
 */
export function dedupeTtlForRouteLease(routeLeaseMs: number): number {
  return Math.max(1, Math.floor(routeLeaseMs / 4));
}
```

7. Catch-up walk own-bot skip (in `src/channels/discord-catchup.ts`):
   a. `DiscordCatchupDeps` gains a required field `botUserId: string;` (compile-gated against factory omission, same discipline as the bridge hook).
   b. `DiscordCatchupRunSummary` gains `skippedOwnBot: number;`, initialized to `0` next to `skippedTerminal: 0` in the summary builder.
   c. In `catchUpTarget`'s per-message loop, after the `ROUTABLE_MESSAGE_TYPES` check and before the terminal check, insert:

```ts
        if ((message.author as { id?: string } | undefined)?.id === deps.botUserId) {
          // The wrapper bypasses the bot's own messages entirely (never
          // dispatched, no ledger row). The walk must skip them too: without
          // this, a presented-by-catch-up own-bot message stays row-less, is
          // neither 'routed' nor attempts-exhausted, and the walk stops at it
          // — wedging every missed user message behind it (plan-review
          // round-2 finding 1).
          summary.skippedOwnBot += 1;
          advance();
          continue;
        }
```

8. Wire the bot id through the factory (in `src/channels/discord.ts`): the applicationId expression currently appears inline twice — extract it once so the adapter constructor and the catch-up engine provably share one value:

```ts
    const discordApplicationId = process.env.DISCORD_APPLICATION_ID || env.DISCORD_APPLICATION_ID || commandSync.applicationId;
    const discordAdapter = createDiscordAdapter({
      botToken,
      publicKey: process.env.DISCORD_PUBLIC_KEY || env.DISCORD_PUBLIC_KEY || commandSync.publicKey,
      applicationId: discordApplicationId,
    });
```

and in the `createDiscordCatchup({...})` call add:

```ts
          botUserId: discordApplicationId,
```

- [ ] **Step 4: Run the focused tests**

Run: `pnpm test src/channels/discord.test.ts src/channels/discord-catchup.test.ts`

Expected: PASS (both whole files — the extended helpers must keep all pre-existing tests green).

- [ ] **Step 5: Refactor while green**

No refactor needed: the tracker is a one-line `Set` at its only call site; the closures are inline at the wiring; extracting anything would add names without second consumers (YAGNI).

- [ ] **Step 6: Run impacted-test verification**

The wrapper is Discord's live-message choke point; every discord channel test crosses it. The state module is unchanged, but its eligibility semantics are exercised here.

Run: `pnpm test src/channels/ && pnpm run typecheck && pnpm exec eslint src/channels/discord.ts src/channels/discord.test.ts src/channels/discord-catchup.ts src/channels/discord-catchup.test.ts src/channels/discord-catchup.integration.test.ts`

Expected: PASS (exit 0 for each command).

- [ ] **Step 7: Commit the task**

```bash
git add src/channels/discord.ts src/channels/discord.test.ts src/channels/discord-catchup.ts src/channels/discord-catchup.test.ts src/channels/discord-catchup.integration.test.ts
git commit -m "fix(channels): truthful discord route bookkeeping — acceptance signal, own-bot bypass+walk skip, lease-aligned dedupe"
```

---

### Task 4: Guard coverage — attachment-only messages reach the session and wake the container

**Files:**
- Modify: `src/router.test.ts` (config mock `vi.mock('./config.js', ...)` ~line 35; add a test to the main describe)
- Test: `src/router.test.ts` (same file)

**Interfaces:**
- Consumes: `routeInbound`, the existing test wiring (`mg-discord` messaging group with `engage_mode: 'pattern'`, `engage_pattern: '.'`, agent `ag-yente` folder `yente`), `getSessionsByAgentGroup`, `inboundDbPath`, mocked `wakeContainer`.
- Produces: no new interface; coverage only.

Why no red test here: the silent drop happened at bridge dispatch (fixed in Task 1); the router half of the story was never broken — `evaluateEngage` short-circuits engage pattern `'.'` without regexing the text, and attachment materialization appends metadata to `parsed.text`, so empty text is fine. This test PASSES at baseline; it is characterization coverage pinning the downstream half of the user story (message lands in the session ledger as a trigger with materialized attachment, container wakes) so a future router-side change cannot reintroduce a silent no-op. A plan-level reviewer should treat this as deliberate, not as a missing red step.

- [ ] **Step 1: Write the failing behavioral test**

Two edits to `src/router.test.ts`:

1. Extend the config mock so attachment materialization writes under the test temp dir, not the real repo `groups/` (`GROUPS_DIR` is `path.resolve(PROJECT_ROOT, 'groups')`; without this override the new test would write into the worktree):

```ts
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router', GROUPS_DIR: '/tmp/nanoclaw-test-router/groups' };
});
```

2. Add the test:

```ts
  it('routes an attachment-only message (empty text) to the session and wakes the container', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');
    vi.mocked(wakeContainer).mockClear();

    const raw = 'todo list contents';
    await routeInbound({
      channelType: 'discord',
      platformId: DISCORD_PLATFORM_ID,
      threadId: DISCORD_THREAD_ID,
      message: {
        id: 'msg-attach-only',
        kind: 'chat-sdk',
        content: JSON.stringify({
          sender: 'discord:admin',
          senderId: 'discord:admin',
          senderName: 'Admin',
          text: '',
          attachments: [
            {
              id: 'att-1',
              name: 'message.txt',
              mimeType: 'text/plain; charset=utf-8',
              size: Buffer.from(raw).length,
              data: Buffer.from(raw).toString('base64'),
            },
          ],
        }),
        timestamp: now(),
        isMention: false,
        isGroup: true,
      },
    });

    const session = getSessionsByAgentGroup('ag-yente')[0];
    expect(session).toBeDefined();
    const db = new Database(inboundDbPath('ag-yente', session.id));
    const rows = db
      .prepare("SELECT content, trigger FROM messages_in WHERE id LIKE 'msg-attach-only%'")
      .all() as Array<{ content: string; trigger: number }>;
    db.close();
    expect(rows).toHaveLength(1);

    const parsed = JSON.parse(rows[0].content) as {
      text: string;
      attachments: Array<{ workspacePath: string }>;
    };
    expect(rows[0].trigger).toBe(1); // engage '.' fired — this message wakes the session
    expect(parsed.text).toContain('message.txt');
    expect(parsed.text).toContain('/workspace/agent/attachments/discord/');
    expect(parsed.attachments[0].workspacePath).toMatch(/^\/workspace\/agent\/attachments\/discord\//);

    // Derive the host path from the workspace path exactly as the container
    // mount maps it, instead of hardcoding the sanitized message folder name.
    const hostPath = parsed.attachments[0].workspacePath.replace('/workspace/agent', '/tmp/nanoclaw-test-router/groups/yente');
    expect(fs.readFileSync(hostPath, 'utf8')).toBe(raw);

    expect(wakeContainer).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the test — expect PASS at baseline**

Run: `pnpm test src/router.test.ts -t "attachment-only"`

Expected: PASS even before any production change (deliberate guard coverage — see the task preamble). If it FAILS at baseline, stop task work and report: the router half of the story is broken too, which contradicts the root-cause analysis and requires plan revision.

- [ ] **Step 3: Production implementation**

None — coverage only (config-mock override + test). Explicitly nothing to change in `src/router.ts` or `src/session-manager.ts`: investigation showed the empty-text + attachments path is already clean end to end (engage `'.'` short-circuit at src/router.ts:~407-408; attachment metadata appended to `parsed.text` by `extractAttachmentFiles`; no `!text` guards on the inbound path). (with one exception landed post-execution by delta-review remediation round 6: the replay-idempotency guard at the router's deterministic session-write seam — see 'Post-execution delta-review remediations')

- [ ] **Step 4: Re-confirm after Tasks 1-3**

Run: `pnpm test src/router.test.ts`

Expected: PASS (whole file — the added `GROUPS_DIR` override must keep all pre-existing tests green).

- [ ] **Step 5: Refactor while green**

No refactor needed.

- [ ] **Step 6: Run impacted-test verification**

The config-mock override affects only this file. Adjacent consumer of the same materialization semantics: `src/host-core.test.ts` (mocks its own dirs; unaffected, run to prove it).

Run: `pnpm test src/router.test.ts src/host-core.test.ts && pnpm run typecheck && pnpm exec eslint src/router.test.ts`

Expected: PASS (exit 0 for each command).

- [ ] **Step 7: Commit the task**

```bash
git add src/router.test.ts
git commit -m "test(router): cover attachment-only messages reaching the session and waking the container"
```

## Post-execution delta-review remediations

- Round 1 (0da9782): acceptance hook follows `setupConfig.onInboundStrict ?? setupConfig.onInbound` so router failures propagate and stay catch-up eligible; two contract tests in chat-sdk-bridge.test.ts.
- Round 2 (115c0da): plan-doc alignment for the strict-inbound pass-through (documentation only).
- Round 4 (3a9ce95): `markDiscordMessageFailed` gained `AND status != 'routed'` (monotonic terminality against overlapping re-claims); red-first unit regression in discord-state.test.ts.
- Round 6 (327862e): `sessionMessageExists` in session-manager.ts + skip-before-insert guard in router.ts `deliverToAgent` making catch-up replay idempotent (no PK collision after partial delivery); two replay-idempotency tests in router.test.ts; `dedupeTtlForRouteLease` strict-below-lease guarantee documented for leases ≥ 2 ms with degenerate sub-2 ms leases an accepted residual, plus a property assertion in discord.test.ts.
- Round 7 (4071ffa, production half reverted by delta review round 8): bridge webhook-server teardown change was reverted as an out-of-scope lifecycle repair; the leak remediation was scoped to the test harnesses — dispatch fakes no longer advertise `startGatewayListener`, so no per-test server starts.
- Round 8 (this commit): the replay guard validates the stored route identity (platform, channel, thread, messaging group, platform message id, timestamp) before skipping — a distinct message colliding on a provider-local id throws loudly instead of being swallowed; harness gateway advertisement removed per the reverted round-7 production change.
