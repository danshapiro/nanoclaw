# Primary Channel Agent Invariant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the Yente-wide invariant that the primary channel-wired agent owns user-channel communication while subagents report only to their caller/parent.

**Architecture:** Add a host-owned channel-wiring predicate, use it while projecting destination maps so subagents do not see channel destinations, keep hidden blocked-channel names only for clear guessed-name errors, and add a host-side delivery guard so stale or forged subagent channel sends cannot reach a user channel. This preserves full text delivery when the primary agent deliberately forwards it.

**Tech Stack:** TypeScript, SQLite via better-sqlite3, Vitest, Bun test runner for agent-runner tests, NanoClaw v2 session inbound/outbound DBs.

---

## File Structure

- Create `AGENTS.md`: root contributor note. The entire file must contain only the two sentences requested by the product owner.
- Modify `src/db/messaging-groups.ts`: add `isAgentChannelWired(agentGroupId)` as the host-owned predicate for whether an agent group may talk to user channels.
- Modify `src/modules/agent-to-agent/write-destinations.ts`: project channel destinations only for channel-wired primary agents; project blocked channel destination names for subagents as hidden `blocked_channel` rows so guessed names return a specific error.
- Modify `src/db/session-db.ts`: widen the session destination row type to allow hidden `blocked_channel` rows.
- Modify `src/db/schema.ts`: document the `blocked_channel` destination row type in the session DB schema comment.
- Modify `container/agent-runner/src/db/connection.ts`: document the same session destination row type in the test/in-memory schema comment.
- Modify `container/agent-runner/src/destinations.ts`: hide `blocked_channel` rows from destination listings and prompt text; expose `findBlockedChannelByName(name)` for precise guessed-channel errors.
- Modify `container/agent-runner/src/mcp-tools/core.ts`: make `send_message` and other destination-resolving tools return the invariant error when a subagent guesses a blocked channel destination name.
- Modify `container/agent-runner/src/poll-loop.ts`: make final `<message to="...">` blocks addressed to hidden blocked channels fail with the same invariant text and no outbound row.
- Modify `src/delivery.ts`: add the authoritative host delivery guard and structured warning `subagent_channel_delivery_blocked`.
- Add `src/modules/agent-to-agent/write-destinations.test.ts`: host projection coverage for primary vs subagent destination visibility.
- Add or extend `container/agent-runner/src/mcp-tools/core.test.ts`: guessed blocked channel destination returns the clear error and does not write `messages_out`.
- Extend `container/agent-runner/src/integration.test.ts`: final output to a blocked channel is not routed, while output to parent still routes.
- Extend `src/delivery.test.ts`: stale/forged subagent channel outbound is blocked before adapter delivery and parent/primary behavior remains intact.
- Modify `src/modules/scheduling/drain.test.ts`: seed channel wiring in the existing channel-delivery fixture so it remains a primary-agent fixture under the new invariant.

## Shared Constants

Use this exact error text everywhere an agent-facing denial is returned:

```ts
export const SUBAGENT_CHANNEL_BLOCKED_MESSAGE =
  'Subagents report to the caller/parent, not directly to the user. Only the primary channel-wired agent is authorized to communicate with user channels.';
```

Keep the `AGENTS.md` text exactly:

```text
The primary channel-wired agent owns communicating with the user. Subagents report to the caller/parent, not directly to the user.
```

## Task 1: Host Channel-Wiring Predicate And Destination Projection

**Files:**
- Modify: `src/db/messaging-groups.ts`
- Modify: `src/modules/agent-to-agent/write-destinations.ts`
- Modify: `src/db/session-db.ts`
- Modify: `src/db/schema.ts`
- Test: `src/modules/agent-to-agent/write-destinations.test.ts`

- [ ] **Step 1: Write the failing projection tests**

Create `src/modules/agent-to-agent/write-destinations.test.ts`:

```ts
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  testDir: '/tmp/nanoclaw-test-write-destinations',
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: mocks.testDir };
});

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { inboundDbPath, resolveSession } from '../../session-manager.js';
import { createDestination } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgent(id: string, name: string): void {
  createAgentGroup({
    id,
    name,
    folder: id,
    agent_provider: null,
    created_at: now(),
  });
}

function readDestinations(agentGroupId: string, sessionId: string): Array<{ name: string; type: string }> {
  const db = new Database(inboundDbPath(agentGroupId, sessionId));
  try {
    return db.prepare('SELECT name, type FROM destinations ORDER BY name').all() as Array<{ name: string; type: string }>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  fs.rmSync(mocks.testDir, { recursive: true, force: true });
  fs.mkdirSync(mocks.testDir, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  seedAgent('ag-primary', 'Primary');
  seedAgent('ag-child', 'Child');
  seedAgent('ag-parent', 'Parent');
  createMessagingGroup({
    id: 'mg-user',
    channel_type: 'discord',
    platform_id: 'discord:channel',
    name: 'User Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(mocks.testDir, { recursive: true, force: true });
});

describe('writeDestinations channel projection policy', () => {
  it('projects channel destinations for a primary channel-wired agent', () => {
    createMessagingGroupAgent({
      id: 'mga-primary',
      messaging_group_id: 'mg-user',
      agent_group_id: 'ag-primary',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    const { session } = resolveSession('ag-primary', 'mg-user', null, 'shared');

    writeDestinations('ag-primary', session.id);

    expect(readDestinations('ag-primary', session.id)).toContainEqual({ name: 'user-channel', type: 'channel' });
  });

  it('hides channel destinations from a subagent and keeps only a blocked marker for guessed-name errors', () => {
    createDestination({
      agent_group_id: 'ag-child',
      local_name: 'user-channel',
      target_type: 'channel',
      target_id: 'mg-user',
      created_at: now(),
    });
    createDestination({
      agent_group_id: 'ag-child',
      local_name: 'parent',
      target_type: 'agent',
      target_id: 'ag-parent',
      created_at: now(),
    });
    const { session } = resolveSession('ag-child', null, null, 'agent-shared');

    writeDestinations('ag-child', session.id);

    expect(readDestinations('ag-child', session.id)).toEqual([
      { name: 'parent', type: 'agent' },
      { name: 'user-channel', type: 'blocked_channel' },
    ]);
  });
});
```

- [ ] **Step 2: Run the failing projection tests**

Run:

```bash
pnpm test -- src/modules/agent-to-agent/write-destinations.test.ts
```

Expected: failure because `blocked_channel` is not implemented and subagents still receive channel destinations as normal `channel` rows.

- [ ] **Step 3: Add the host-owned channel-wiring predicate**

In `src/db/messaging-groups.ts`, append this function after `getMessagingGroupsByAgentGroup`:

```ts
/** True when an agent group is directly wired to at least one user channel. */
export function isAgentChannelWired(agentGroupId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM messaging_group_agents WHERE agent_group_id = ? LIMIT 1')
    .get(agentGroupId);
  return !!row;
}
```

- [ ] **Step 4: Widen session destination row type and schema comments**

In `src/db/session-db.ts`, change `DestinationRow.type` to:

```ts
  type: 'channel' | 'agent' | 'blocked_channel';
```

In `src/db/schema.ts`, update the `destinations.type` comment to:

```sql
  type            TEXT NOT NULL,   -- 'channel' | 'agent' | 'blocked_channel'
```

In `container/agent-runner/src/db/connection.ts`, update the in-memory test schema comment around `destinations.type` only if there is a nearby comment; otherwise leave the SQL unchanged because SQLite has no CHECK constraint.

- [ ] **Step 5: Project hidden blocked channel destinations for subagents**

In `src/modules/agent-to-agent/write-destinations.ts`, merge the existing messaging-group import so it becomes:

```ts
import { getMessagingGroup, isAgentChannelWired } from '../../db/messaging-groups.js';
```

Then replace the full `for (const row of rows) { ... }` loop with:

```ts
  const allowChannelDestinations = isAgentChannelWired(agentGroupId);

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = getMessagingGroup(row.target_id);
      if (!mg) continue;
      if (!allowChannelDestinations) {
        resolved.push({
          name: row.local_name,
          display_name: mg.name ?? row.local_name,
          type: 'blocked_channel',
          channel_type: mg.channel_type,
          platform_id: mg.platform_id,
          agent_group_id: null,
        });
        continue;
      }
      resolved.push({
        name: row.local_name,
        display_name: mg.name ?? row.local_name,
        type: 'channel',
        channel_type: mg.channel_type,
        platform_id: mg.platform_id,
        agent_group_id: null,
      });
    } else if (row.target_type === 'agent') {
      const ag = getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({
        name: row.local_name,
        display_name: ag.name,
        type: 'agent',
        channel_type: null,
        platform_id: null,
        agent_group_id: ag.id,
      });
    }
  }
```

- [ ] **Step 6: Run the projection tests**

Run:

```bash
pnpm test -- src/modules/agent-to-agent/write-destinations.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit Task 1**

Run:

```bash
git add src/db/messaging-groups.ts src/db/session-db.ts src/db/schema.ts src/modules/agent-to-agent/write-destinations.ts src/modules/agent-to-agent/write-destinations.test.ts
git commit -m "Enforce channel destination projection policy"
```

## Task 2: Agent-Runner Error For Guessed Blocked Channels

**Files:**
- Modify: `container/agent-runner/src/destinations.ts`
- Modify: `container/agent-runner/src/mcp-tools/core.ts`
- Modify: `container/agent-runner/src/poll-loop.ts`
- Test: `container/agent-runner/src/mcp-tools/core.test.ts`
- Test: `container/agent-runner/src/integration.test.ts`

- [ ] **Step 1: Write failing MCP and final-output tests**

In `container/agent-runner/src/mcp-tools/core.test.ts`, add:

```ts
  it('returns a clear invariant error when a subagent guesses a blocked channel destination', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('user-channel', 'User Channel', 'blocked_channel', 'discord', 'chan-user', NULL)`,
      )
      .run();

    const result = await sendMessage.handler({ to: 'user-channel', text: 'full diff text' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Subagents report to the caller/parent, not directly to the user.');
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS count FROM messages_out').get()).toEqual({ count: 0 });
  });
```

Also update that file's import from `../db/connection.js` so it includes `getOutboundDb`:

```ts
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
```

In `container/agent-runner/src/integration.test.ts`, add:

```ts
  it('does not route final message blocks to hidden blocked channel destinations', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('parent', 'Parent', 'agent', NULL, NULL, 'ag-parent')`,
      )
      .run();
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('user-channel', 'User Channel', 'blocked_channel', 'discord', 'chan-user', NULL)`,
      )
      .run();
    insertMessage('m-blocked', { sender: 'Parent', text: 'report only to parent' }, { platformId: 'ag-parent', channelType: 'agent' });

    const provider = new MockProvider(
      {},
      () =>
        '<message to="user-channel">should not reach user</message><message to="parent">complete report for parent</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('agent');
    expect(out[0].platform_id).toBe('ag-parent');
    expect(JSON.parse(out[0].content).text).toBe('complete report for parent');

    await loopPromise.catch(() => {});
  });
```

- [ ] **Step 2: Run the failing agent-runner tests**

Run:

```bash
pnpm test -- container/agent-runner/src/mcp-tools/core.test.ts container/agent-runner/src/integration.test.ts
```

Expected: failure because `blocked_channel` is not recognized and guessed names return the generic unknown-destination path.

- [ ] **Step 3: Add hidden blocked-channel lookup**

In `container/agent-runner/src/destinations.ts`, add:

```ts
export const SUBAGENT_CHANNEL_BLOCKED_MESSAGE =
  'Subagents report to the caller/parent, not directly to the user. Only the primary channel-wired agent is authorized to communicate with user channels.';
```

Change `DestRow.type` to:

```ts
  type: 'channel' | 'agent' | 'blocked_channel';
```

Change `getAllDestinations()` to:

```ts
export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb()
    .prepare("SELECT * FROM destinations WHERE type IN ('channel', 'agent') ORDER BY name")
    .all() as DestRow[];
  return rows.map(rowToEntry);
}
```

Change `findByName(name)` to:

```ts
export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb()
    .prepare("SELECT * FROM destinations WHERE name = ? AND type IN ('channel', 'agent')")
    .get(name) as DestRow | undefined;
  return row ? rowToEntry(row) : undefined;
}
```

Add:

```ts
export function findBlockedChannelByName(name: string): boolean {
  const row = getInboundDb()
    .prepare("SELECT 1 FROM destinations WHERE name = ? AND type = 'blocked_channel' LIMIT 1")
    .get(name);
  return !!row;
}
```

- [ ] **Step 4: Return the invariant error from MCP destination resolution**

In `container/agent-runner/src/mcp-tools/core.ts`, change the destinations import to:

```ts
import { findBlockedChannelByName, findByName, getAllDestinations, SUBAGENT_CHANNEL_BLOCKED_MESSAGE } from '../destinations.js';
```

In `resolveRouting`, replace the unknown-destination branch with:

```ts
  const dest = findByName(to);
  if (!dest) {
    if (findBlockedChannelByName(to)) return { error: SUBAGENT_CHANNEL_BLOCKED_MESSAGE };
    return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  }
```

- [ ] **Step 5: Drop final blocked-channel message blocks with the invariant text**

In `container/agent-runner/src/poll-loop.ts`, change the destinations import to:

```ts
import {
  findBlockedChannelByName,
  findByName,
  findByRouting,
  getAllDestinations,
  SUBAGENT_CHANNEL_BLOCKED_MESSAGE,
  type DestinationEntry,
} from './destinations.js';
```

In `dispatchResultText`, replace the unknown-destination branch with:

```ts
    const dest = findByName(toName);
    if (!dest) {
      if (findBlockedChannelByName(toName)) {
        log(`Blocked channel destination in <message to="${toName}">: ${SUBAGENT_CHANNEL_BLOCKED_MESSAGE}`);
        scratchpadParts.push(`[dropped: ${SUBAGENT_CHANNEL_BLOCKED_MESSAGE}] ${body}`);
        continue;
      }
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
```

- [ ] **Step 6: Run the agent-runner tests**

Run:

```bash
pnpm test -- container/agent-runner/src/mcp-tools/core.test.ts container/agent-runner/src/integration.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add container/agent-runner/src/destinations.ts container/agent-runner/src/mcp-tools/core.ts container/agent-runner/src/poll-loop.ts container/agent-runner/src/mcp-tools/core.test.ts container/agent-runner/src/integration.test.ts
git commit -m "Return clear errors for blocked channel destinations"
```

## Task 3: Authoritative Host Delivery Guard

**Files:**
- Modify: `src/delivery.ts`
- Test: `src/delivery.test.ts`
- Test: `src/modules/scheduling/drain.test.ts`

- [ ] **Step 1: Write failing delivery guard tests**

First update the import from `./db/index.js` in `src/delivery.test.ts` to include `createMessagingGroupAgent`, and extend the existing `seedAgentAndChannel()` helper so all current channel-delivery tests represent a primary channel-wired agent:

```ts
import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
```

At the end of `seedAgentAndChannel()` add:

```ts
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
```

Then add this subagent guard test in `src/delivery.test.ts`:

```ts
  it('blocks stale or forged subagent channel outbound before adapter delivery', async () => {
    seedAgentAndChannel();
    createAgentGroup({
      id: 'ag-child',
      name: 'Child Agent',
      folder: 'child-agent',
      agent_provider: null,
      created_at: now(),
    });
    const { session } = resolveSession('ag-child', null, null, 'agent-shared');
    insertOutbound('ag-child', session.id, 'out-child-channel', 'should not send');

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(content);
        return 'platform-message';
      },
    });

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    expect(delivered).toEqual([]);
    expect(deliveredRows('ag-child', session.id)).toEqual([
      { message_out_id: 'out-child-channel', platform_message_id: null, status: 'failed' },
    ]);
  });
```

Also update the existing `seedAgentAndChannel()` helper in `src/modules/scheduling/drain.test.ts` so its channel-delivery fixture is primary/channel-wired under the new guard. Add `createMessagingGroupAgent` to the import from `../../db/index.js`, then add this at the end of that helper:

```ts
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
```

Finally add this explicit primary delivery test in `src/delivery.test.ts`:

```ts

  it('continues to allow primary channel-wired agent delivery', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-primary-channel', 'primary sends');

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(JSON.parse(content).text as string);
        return 'platform-message';
      },
    });

    await deliverSessionMessages(session);

    expect(delivered).toEqual(['primary sends']);
    expect(deliveredRows('ag-1', session.id)).toEqual([
      { message_out_id: 'out-primary-channel', platform_message_id: 'platform-message', status: 'delivered' },
    ]);
  });
```

- [ ] **Step 2: Run the failing delivery tests**

Run:

```bash
pnpm test -- src/delivery.test.ts src/modules/scheduling/drain.test.ts
```

Expected: failure because a subagent channel outbound still reaches the adapter or fails for the wrong reason.

- [ ] **Step 3: Add host delivery guard and warning**

In `src/delivery.ts`, import the predicate:

```ts
import { getMessagingGroupByPlatform, isAgentChannelWired } from './db/messaging-groups.js';
```

After the `mg` lookup and before `const isOriginChat = ...`, add:

```ts
    if (!isAgentChannelWired(session.agent_group_id)) {
      log.warn('subagent_channel_delivery_blocked', {
        agentGroupId: session.agent_group_id,
        sessionId: session.id,
        messageOutId: msg.id,
        channelType: msg.channel_type,
        platformId: msg.platform_id,
        threadId: msg.thread_id,
      });
      throw new Error(
        'Subagents report to the caller/parent, not directly to the user. Only the primary channel-wired agent is authorized to communicate with user channels.',
      );
    }
```

Keep the existing origin-chat and explicit `agent_destinations` checks after this guard. Those checks now apply only to primary channel-wired agents.

- [ ] **Step 4: Run delivery tests**

Run:

```bash
pnpm test -- src/delivery.test.ts src/modules/scheduling/drain.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add src/delivery.ts src/delivery.test.ts src/modules/scheduling/drain.test.ts
git commit -m "Block subagent delivery to user channels"
```

## Task 4: Contributor Note And Full Verification

**Files:**
- Create: `AGENTS.md`
- Verify: all files touched above

- [ ] **Step 1: Add the exact root AGENTS note**

Create `AGENTS.md` with exactly:

```text
The primary channel-wired agent owns communicating with the user. Subagents report to the caller/parent, not directly to the user.
```

- [ ] **Step 2: Run focused verification**

Run:

```bash
pnpm test -- src/modules/agent-to-agent/write-destinations.test.ts container/agent-runner/src/mcp-tools/core.test.ts container/agent-runner/src/integration.test.ts src/delivery.test.ts src/modules/scheduling/drain.test.ts
```

Expected: pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: pass.

- [ ] **Step 4: Run full test suite**

Run:

```bash
pnpm test
```

Expected: pass.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add AGENTS.md
git commit -m "Document primary channel agent invariant"
```

## Self-Review

**Spec coverage:** The plan covers non-exposure of channel destinations to subagents, clear non-scolding errors for guessed channel names, host-side authoritative blocking with a structured warning, parent reporting intact, primary full-text channel routing intact, and the exact `AGENTS.md` text requested.

**Placeholder scan:** No placeholder tokens or vague “add tests” instructions remain. Each task has concrete code and exact verification commands.

**Type consistency:** `blocked_channel` is introduced in the host session projection type and consumed only by container destination lookup/filtering. User-visible routing still uses existing `channel` and `agent` destination types.
