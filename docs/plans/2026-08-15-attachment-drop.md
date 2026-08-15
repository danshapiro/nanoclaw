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
    subscribe: (threadId: string) => Promise<void>;
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

  async function makeDispatchHarness() {
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
      await driver.subscribe('thread-1');
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
- Test: `src/channels/chat-sdk-bridge.test.ts`

**Interfaces:**
- Consumes: existing exported `forwardChatSdkInboundMessage` and its `opts` bag; internal `forwardInboundMessage` closure inside `createChatSdkBridge`.
- Produces:
  - `ChatSdkBridgeConfig.onInboundForwarded?: (messageId: string) => void` — config-level hook, fired by the bridge after every successful inbound forward.
  - `forwardChatSdkInboundMessage` opts field `onForwarded?: (messageId: string) => void` — per-call hook fired with the message id after `onInbound` completes, only on the `'forwarded'` path (not on the same-bot `'dropped'` path).

This is the plumbing Task 3 wires to truthful route bookkeeping. The Chat SDK's dispatch resolves `void` whether or not any handler matched, and the vendored discord adapter's forward resolves either way, so without this hook the wrapper cannot distinguish "handler accepted the message" from "no handler matched".

- [ ] **Step 1: Write the failing behavioral test**

Add this describe block to `src/channels/chat-sdk-bridge.test.ts`, next to the existing `'Chat SDK bridge same-bot ingress guard'` describe (which already imports and unit-tests `forwardChatSdkInboundMessage`):

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

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm test src/channels/chat-sdk-bridge.test.ts -t "acknowledgment"`

Expected: FAIL because `forwardChatSdkInboundMessage` does not accept or invoke `onForwarded` yet (the hook never fires; additionally strict typecheck rejects the unknown option until the implementation lands).

- [ ] **Step 3: Add the minimal production implementation**

Three edits in `src/channels/chat-sdk-bridge.ts`:

1. In `ChatSdkBridgeConfig`, after the `onGatewayWebhookReady` field (end of the interface), add:

```ts
  /**
   * Called with the platform message id immediately after a message is
   * actually forwarded inbound — i.e. a registered Chat SDK handler accepted
   * it and the host `onInbound` completed. Chat SDK dispatch resolves void
   * whether or not any handler matched, and the vendored adapters' forwards
   * resolve either way, so channels that keep route bookkeeping (Discord) use
   * this to distinguish "dispatched to a handler" from "no handler matched".
   */
  onInboundForwarded?: (messageId: string) => void;
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
      onInbound: setupConfig.onInbound,
      toInbound: messageToInbound,
      onForwarded: config.onInboundForwarded,
    });
  }
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm test src/channels/chat-sdk-bridge.test.ts -t "acknowledgment"`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed: a single optional hook added along one existing options-bag path, mirroring the file's existing conventions.

- [ ] **Step 6: Run impacted-test verification**

Only the bridge module and its direct consumers change; `forwardChatSdkInboundMessage`'s only production caller is `forwardInboundMessage` in the same file, and the config interface addition is optional, so no other channel is affected.

Run: `pnpm test src/channels/chat-sdk-bridge.test.ts && pnpm run typecheck && pnpm exec eslint src/channels/chat-sdk-bridge.ts src/channels/chat-sdk-bridge.test.ts`

Expected: PASS (exit 0 for each command).

- [ ] **Step 7: Commit the task**

```bash
git add src/channels/chat-sdk-bridge.ts src/channels/chat-sdk-bridge.test.ts
git commit -m "feat(channels): add onInboundForwarded acceptance hook to chat-sdk bridge"
```

---

### Task 3: Truthful Discord route bookkeeping via the acceptance signal

**Files:**
- Modify: `src/channels/discord.ts` (`YenteDiscordWrapOptions` type ~lines 419-425, `wrapYenteDiscordChannelIds` option destructuring ~line 432, wrapper step-3 outcome block ~lines 547-576, channel factory wiring ~lines 97-105)
- Modify (call-site update only): `src/channels/discord-catchup.integration.test.ts` (add the new required option to its `wrapYenteDiscordChannelIds` call)
- Test: `src/channels/discord.test.ts` (extend the `wrap()` helper; add a describe block)

**Interfaces:**
- Consumes: `ChatSdkBridgeConfig.onInboundForwarded` from Task 2; `DiscordAdapter.botUserId` (public readonly, set at adapter construction — verified in vendored `@chat-adapter/discord` dist).
- Produces:
  - `YenteDiscordWrapOptions.wasMessageHandled: (messageId: string) => boolean` — **required** consume-on-read acceptance probe: returns `true` exactly once per message id that was actually forwarded inbound by a dispatch handler.

Current bug this fixes: after `originalHandleForwardedMessage` resolves, the wrapper calls `markDiscordMessageRouted` unconditionally (src/channels/discord.ts:552). The vendored adapter resolves even when no dispatch handler matched (e.g. the Task 1 drop), so the ledger recorded a never-handled message as terminal `routed` and catch-up could never retry it.

Design: the Discord channel factory holds a shared `Set<string>`. The bridge's `onInboundForwarded` hook adds ids; the wrapper's step-3 outcome consults via `Set.delete` (consume-on-read: one forward → one consult). Own-bot messages stay terminal `routed` by an explicit carve-out, because the SDK filters them before dispatch and the bridge same-bot guard drops any that slip through — no handler ever fires for them, and that drop is intentional.

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

  it("keeps the bot's own messages terminal even though no dispatch handler fires for them", async () => {
    const fake = { ...fakeAdapter(), botUserId: 'bot-1' };
    const wrapped = wrap(fake, [], ['chan-1'], () => false);
    const ownMessage = { ...message('m-own'), author: { id: 'bot-1', bot: true } };

    await wrapped.handleForwardedMessage(ownMessage, {});

    expect(getDiscordMessageRouteStatus('chan-1', 'm-own')).toBe('routed');
    expect(isDiscordMessageTerminal('chan-1', 'm-own')).toBe(true);
  });
```

3. Update the direct `wrapYenteDiscordChannelIds` call in `src/channels/discord-catchup.integration.test.ts` to pass `wasMessageHandled: () => true` with the same "fake always handles" comment, since the option becomes required. (Check the test's intent: if it asserts catch-up behavior for a message that the fake forwards, `() => true` preserves current behavior exactly.)

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `pnpm test src/channels/discord.test.ts -t "failed, not routed"`

Expected: FAIL because the wrapper still marks every message `routed` unconditionally — the new test observes status `routed` instead of `failed`. (The own-bot test also fails pre-fix for the same reason: status `routed` is expected there, so it passes only after the carve-out — pre-fix it fails because... no: pre-fix the wrapper marks routed unconditionally, so the own-bot test PASSES pre-fix. That is intentional: the own-bot test is a characterization guard against the new acceptance logic stranding self-messages, not a red regression test. The red test for this task is the "failed, not routed" one.)

- [ ] **Step 3: Add the minimal production implementation**

All edits in `src/channels/discord.ts`:

1. `YenteDiscordWrapOptions` — add the required probe:

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

2. `wrapYenteDiscordChannelIds` — destructure alongside `monitoredChannelIds`:

```ts
  const wasMessageHandled = options.wasMessageHandled;
```

3. Wrapper step-3 outcome block — replace the unconditional bookkeeping with:

```ts
    // 3. Forward, then record the outcome (fail-open on state errors). The
    //    bridge dispatches with concurrency 'concurrent', so the acceptance
    //    hook written during dispatch is synchronously visible by the time the
    //    vendored forward resolves.
    try {
      const result = await originalHandleForwardedMessage(dataArg, opts, ...rest);
      try {
        const routedAt = nowIso();
        // The SDK filters the bot's own messages before dispatch (isMe), and
        // the bridge same-bot guard drops any that slip through — neither
        // fires the acceptance hook. That drop is intentional, so own-bot
        // messages stay terminal 'routed' instead of churning catch-up.
        const authorId = (data?.author as { id?: string } | undefined)?.id;
        const isOwnBot = authorId !== undefined && authorId === rawAdapter.botUserId;
        if (wasMessageHandled(messageId) || isOwnBot) {
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

4. Channel factory — add the shared tracker just before `return createChatSdkBridge({`:

```ts
    // Acceptance tracker shared by the bridge hook (writer) and the wrapped
    // adapter below (consume-on-read reader). Consume-on-read keeps the set
    // near zero; the cap only guards a leak if bookkeeping throws between the
    // hook firing and the consult (e.g. a state error after a forward).
    const handledMessageIds = new Set<string>();
    const MAX_HANDLED_MESSAGE_IDS = 1000;
    const noteMessageHandled = (messageId: string): void => {
      if (handledMessageIds.size >= MAX_HANDLED_MESSAGE_IDS) {
        const oldest = handledMessageIds.values().next().value;
        if (oldest !== undefined) handledMessageIds.delete(oldest); // FIFO eviction
      }
      handledMessageIds.add(messageId);
    };
```

then extend the wrap options and the bridge config:

```ts
      adapter: wrapYenteDiscordChannelIds(discordAdapter, botToken, autoCreateThreadChannelIds, {
        monitoredChannelIds: channelIds,
        routeLeaseMs: catchupConfig.routeLeaseMs,
        onGatewayEvent: (type) => catchup?.onGatewayEvent(type),
        wasMessageHandled: (messageId) => handledMessageIds.delete(messageId),
      }),
```

```ts
      onInboundForwarded: noteMessageHandled,
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm test src/channels/discord.test.ts`

Expected: PASS (whole file — the extended helper must keep all pre-existing tests green).

- [ ] **Step 5: Refactor while green**

No refactor needed: the tracker is a six-line closure at its only call site; extracting a helper would add a name without a second consumer (YAGNI).

- [ ] **Step 6: Run impacted-test verification**

The wrapper is Discord's live-message choke point; every discord channel test crosses it. The state module is unchanged, but its eligibility semantics are exercised here.

Run: `pnpm test src/channels/ && pnpm run typecheck && pnpm exec eslint src/channels/discord.ts src/channels/discord.test.ts src/channels/discord-catchup.integration.test.ts`

Expected: PASS (exit 0 for each command).

- [ ] **Step 7: Commit the task**

```bash
git add src/channels/discord.ts src/channels/discord.test.ts src/channels/discord-catchup.integration.test.ts
git commit -m "fix(channels): record discord routes as failed, not routed, when no handler accepted"
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

None — coverage only (config-mock override + test). Explicitly nothing to change in `src/router.ts` or `src/session-manager.ts`: investigation showed the empty-text + attachments path is already clean end to end (engage `'.'` short-circuit at src/router.ts:~407-408; attachment metadata appended to `parsed.text` by `extractAttachmentFiles`; no `!text` guards on the inbound path).

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
