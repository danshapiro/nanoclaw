# Discord Catch-Up on Reconnect Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** After a Discord gateway disconnect→fresh-IDENTIFY gap (or a service stop), fetch missed channel/thread messages via Discord REST and route them through the exact same ingress path as live gateway events — with a durable claim table guaranteeing every message is routed at most once.

**Architecture:** Mirror the AgentMail durability pattern (claim/lease table + cursor + catch-up sweep). A new `discord_message_routes` claim table is written at the single ingress choke point (the wrapped `handleForwardedMessage` in `src/channels/discord.ts`), so live and caught-up messages share one idempotency gate. A new catch-up engine (`src/channels/discord-catchup.ts`) fetches `GET /channels/{id}/messages?after=<cursor>` ascending and POSTs synthesized `GATEWAY_MESSAGE_CREATE` events to the bridge's own local webhook URL — byte-for-byte the same path live events take, so auto-thread creation, Chat SDK dispatch, and routing behave identically. Triggers: debounced `GATEWAY_READY`, startup, and a periodic 5-minute timer. `GATEWAY_RESUMED` is deliberately NOT a trigger (Discord replays events on RESUME).

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import extensions mandatory), better-sqlite3 (central `v2.db`), vitest (colocated `src/**/*.test.ts`, no globals — explicit imports), pnpm.

**Authoritative spec:** `/home/dan/code/shapiroserver2/docs/plans/2026-07-29-nanoclaw-discord-catchup-plan.md` (outside this repo). This plan implements its repo-side scope in full. All `file:line` references below are against this worktree at base ref `7a74df5`.

## Global Constraints

- Repo root (worktree): `/home/dan/code/nanoclaw-reboot-resilience/.worktrees/discord-catchup`, branch `feat/discord-catchup`. All commands below run from this directory.
- Repo-side implementation and tests ONLY. Do NOT deploy, do NOT touch the live host, do NOT run live Discord smokes. The host smoke, maintenance-window catch-up drill, wrapper-repo `Deployment.md`/`changes.md` doc updates, and flap-window validation from spec §8/§9 happen at deploy time, separately (explicitly out of scope per the task statement — this is a user-approved scope boundary, not a silent deferral; the in-repo integration test in Task 12 carries the no-duplicate assertion the e2e smoke will re-verify on the host).
- All existing test suites must remain green: `pnpm exec vitest run` passes at the end of every task.
- Verification commands (CI mirror): `pnpm run format:check && pnpm exec tsc --noEmit && pnpm exec vitest run`. Also run `pnpm run lint` (local-only; `preserve-caught-error` and `no-unused-vars` are error severity).
- Env keys and defaults (exact values, spec §5): `DISCORD_CATCHUP_DISABLED` (unset; `1` = kill switch — only fetch/triggers stop, choke-point state writes continue), `DISCORD_CATCHUP_INTERVAL_MS` = `300000` (`0` disables periodic only), `DISCORD_CATCHUP_READY_DEBOUNCE_MS` = `15000`, `DISCORD_CATCHUP_MAX_MESSAGES` = `200`, `DISCORD_CATCHUP_MAX_AGE_MS` = `259200000` (72 h), `DISCORD_CATCHUP_ROUTE_LEASE_MS` = `120000`, `DISCORD_CATCHUP_MAX_THREADS` = `25`.
- Hard behavioral requirements: fail-open at the choke point (a DB error during claim/bookkeeping must NEVER drop a live message — route anyway, log ERROR; dedicated unit test); `GATEWAY_RESUMED` is NOT a trigger; first-deploy cursor initialization at channel head with NO history replay; 3-attempt abandon (a message is terminally `failed` only after 3 claim attempts, so transient dispatch errors are retried by catch-up — see "Failed-status semantics" below); 429 `Retry-After` honored with sequential fetches (~2 req/s floor); 60 s wall-clock cap per run; migration is additive-only (rollback = pointer flip, no state restore).
- Style: single quotes, 120 cols (prettier; husky pre-commit runs `format:fix`), `strict: true`, `.js` extension on all relative imports, `log.<level>('Sentence Case message', { structuredFields })` with errors stringified into a field (never the `err` key in `src/channels/discord*.ts`).
- README.md is the only end-user markdown doc — do not create new docs (this plan file under `docs/plans/` is a working/agent doc and is fine).
- Commits: focused and atomic, conventional-style subjects (`feat(discord): …`, `test(discord): …`, `docs: …`) matching recent history.

---

## Design Notes (read before starting any task)

### Key repo facts (verified against the worktree)

- `src/channels/discord.ts` (441 lines): the channel self-registers via `registerChannelAdapter('discord', { factory: async () => … })` at L32–72 (anonymous factory; returns `null` without `DISCORD_BOT_TOKEN`). `wrapYenteDiscordChannelIds(adapter, botToken, autoCreateThreadChannelIds)` (L355–441, currently NOT exported) is applied unconditionally at L63, but its `handleForwardedMessage` interception is currently gated on `autoCreateThreadChannelIds.size > 0` (L405). The gateway forwarder monkey-patch (L363–366) replaces the vendored `forwardGatewayEvent` with `forwardDiscordGatewayEventWithRetry` (exported, L292–353; POST with headers `Content-Type: application/json` + `x-discord-gateway-token: <botToken>`; 3 attempts, retries transient network errors and 5xx only; never throws; currently returns `Promise<void>`). `getRegisteredDiscordChannelIds()` (L219–229, private) reads `messaging_groups WHERE channel_type='discord' AND platform_id NOT LIKE 'quarantined:%'`, normalized via `yenteDiscordPlatformIdFromThreadId`.
- `src/channels/chat-sdk-bridge.ts` (942 lines): `setup()` learns the webhook URL at `:541` (`const webhookUrl = await startLocalWebhookServer(…)`, inside `if (gatewayAdapter.startGatewayListener)`); the webhook server is created ONCE per `setup()` (the 24 h gateway restart at `:561–566` reuses the same URL). `handleForwardedEvent` passes non-interaction events to `adapter.handleWebhook` with header `x-discord-gateway-token`; the local server answers `200 {"ok":true}` when handling resolves and `500 {"error":"internal"}` when it rejects (`:781-789`). `ChatSdkBridgeConfig` is at `:111-140`; optional members carry JSDoc rationale blocks.
- Vendored `@chat-adapter/discord/dist/index.js`: `handleWebhook` validates `x-discord-gateway-token === botToken` (else 401) and calls `await this.handleForwardedMessage(event.data, options)` (dist `:724–734`) — two args, second is the `WebhookOptions` bag and is ignored. `handleForwardedMessage` derives `guildId = data.guild_id || '@me'`, `channelId = data.channel_id`, and dereferences `data.mentions` and `data.attachments` unguarded — REST message objects always include both arrays, so synthesized events are safe.
- AgentMail reference: `claimAgentMailMessage` (`src/channels/agentmail-state.ts:36–75`) — transactional claim, terminal statuses refuse, expired lease reclaims with `attempts+1`, time injected as ISO strings (no clock in the state module); `catchUp()`/`scheduleCatchUp()` (`src/channels/agentmail.ts:313–349`); migration shape `export const migration016: Migration = { version, name, up(db) }` registered in `src/db/migrations/index.ts` (import + append to the module-local `migrations` array; idempotency keyed on `name`, next free numeric slot is 017; append at the END of the array).
- DB: `getDb()` from `src/db/connection.js` called inline in every function (never cached — tests swap the singleton via `initTestDb()`/`closeDb()`). Tests: `const db = initTestDb(); runMigrations(db);` in `beforeEach`, `closeDb()` in `afterEach` (`initTestDb` does NOT run migrations).
- Env tunables live in the channel module, not `src/config.ts`: `*FromEnv(env)` parsers that `?.trim()`, default on unset via exported `DEFAULT_<KEY>` consts, and THROW naming the var on malformed values (see `agentmail-config.ts:189–207`).
- `src/channels/discord.test.ts` and `src/channels/chat-sdk-bridge.test.ts` both exist — extend them, do not replace.

### Failed-status semantics (reconciling spec §4/§6/§8)

The spec requires all three of: (a) the wrapper marks a route `failed` when forwarding throws, (b) catch-up retries failed messages ("POST failure: … retried next run"), and (c) bounded abandonment ("3rd failure → terminal failed", "terminal statuses (routed, failed) refuse reclaim"). These are satisfied by making `failed` **conditionally terminal**: `markDiscordMessageFailed` records `status='failed'` with the lease cleared; `claimDiscordMessage` re-claims a `failed` row (bumping `attempts`) while `attempts < DISCORD_ROUTE_MAX_ATTEMPTS (= 3)`, and refuses (`status: 'abandoned'`) once `attempts >= 3`. `isDiscordMessageTerminal` is true for `routed` or (`failed` AND `attempts >= 3`). Net effect: attempt 1 (live or catch-up) fails → retried; attempt 2 fails → retried; attempt 3 fails → terminal, catch-up logs `Discord catch-up abandoned message` (ERROR) and advances the cursor past it — bounded, never wedges a channel, and a single transient dispatch error can never permanently lose a message.

### Source attribution (`source` column) without touching the ingress payload

Live and caught-up messages traverse the identical choke point, so the wrapper cannot distinguish them and always claims with `source: 'gateway'`. To keep the synthesized ingress payload byte-identical to live events (a structural requirement of the spec), catch-up attributes itself post-hoc: after a successful POST it calls `markDiscordMessageSource(channelId, messageId, 'catchup')`. In the rare race where a live event wins the claim a millisecond before the catch-up POST lands, one row may be mislabeled — the same ordering exposure the spec already accepts; the `Discord catch-up routed missed message` journal line remains the authoritative attribution.

### Lifecycle decision (spec §5 allowed "decide at implementation, keep to ≤2 optional hooks")

Exactly ONE new bridge hook is added: `onGatewayWebhookReady?: (webhookUrl: string) => void`. `discord.ts` keeps the catch-up engine handle; the engine's timers are `unref()`d so no `onGatewayStopped`/teardown hook is needed (the bridge `teardown()` only runs at process shutdown in this runtime). The engine is constructed lazily inside the hook (the webhook URL does not exist at factory time), and the forwarder tap calls `onGatewayEvent` through a nullable reference.

### Thread cursor initialization

Per spec §6 step 3/4a, thread targets follow the same no-cursor rule as channels: first time an active thread is seen by catch-up, its cursor initializes at the thread's head without routing anything. With the 5-minute periodic run, threads acquire cursor rows within minutes of creation; the small first-encounter window and archived-during-gap threads are accepted residual risk (spec §7). Live in-thread messages advance the thread's cursor only when the wrapper can see a monitored parent (`data.thread.parent_id`); otherwise correctness still holds via the claim table (catch-up re-fetches, terminal-skips, and advances the cursor then).

### File structure (locked in)

| File | Action | Responsibility |
|---|---|---|
| `src/db/migrations/017-discord-message-routes.ts` | Create | Additive migration: `discord_message_routes` + `discord_channel_cursors` + indexes |
| `src/db/migrations/017-discord-message-routes.test.ts` | Create | Schema-shape assertions |
| `src/db/migrations/index.ts` | Modify | Register `migration017` (import + append at array end) |
| `src/channels/discord-state.ts` | Create | Durable state: claim/lease/mark/terminal, cursors, prune, source. No clock, no fetch — pure DB. |
| `src/channels/discord-state.test.ts` | Create | Claim/cursor/prune semantics |
| `src/channels/discord-catchup.ts` | Create | Config-from-env, snowflake helpers, catch-up engine (`createDiscordCatchup`): REST fetch, synthesis, POST, triggers, bounds |
| `src/channels/discord-catchup.test.ts` | Create | Engine semantics (fake `fetchImpl`, fake timers) |
| `src/channels/discord-catchup.integration.test.ts` | Create | End-user story: gap message → catch-up → exactly-once route with auto-thread; no-duplicate assertion |
| `src/channels/chat-sdk-bridge.ts` | Modify | Add `onGatewayWebhookReady` config hook, invoke in `setup()` (~7 lines) |
| `src/channels/chat-sdk-bridge.test.ts` | Modify | Hook invocation test via `setup()` with a fake gateway adapter |
| `src/channels/discord.ts` | Modify | Unconditional choke-point interception with claim-before-forward (fail-open), mark routed/failed, cursor advance, gateway-event tap, `forwardDiscordGatewayEventWithRetry` returns boolean, export wrapper, factory wiring, `monitoredDiscordChannelIds` |
| `src/channels/discord.test.ts` | Modify | Wrapper claim/duplicate/auto-thread/fail-open tests; forward-retry boolean returns; monitored-set test |

Execution order: tasks are strictly ordered 1 → 13; later tasks import symbols produced by earlier ones.

---

### Task 1: Migration 017 — `discord_message_routes` + `discord_channel_cursors`

**Files:**
- Create: `src/db/migrations/017-discord-message-routes.ts`
- Create: `src/db/migrations/017-discord-message-routes.test.ts`
- Modify: `src/db/migrations/index.ts` (import at top block, append to `migrations` array end)

**Interfaces:**
- Consumes: `Migration` interface from `src/db/migrations/index.ts:19-23` (`{ version: number; name: string; up: (db: Database.Database) => void }`); test helpers `initTestDb`, `closeDb` from `../connection.js`, `runMigrations`, `getDb`.
- Produces: tables `discord_message_routes` (PK `(channel_id, message_id)`; columns `channel_id, message_id, guild_id, author_id, first_seen_at, claimed_at, lease_expires_at, routed_at, failed_at, attempts, status, source, last_error`) and `discord_channel_cursors` (PK `channel_id`; columns `channel_id, last_message_id, updated_at`). Every later task's SQL depends on these exact column names.

- [ ] **Step 1: Write the failing test**

Create `src/db/migrations/017-discord-message-routes.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from '../connection.js';
import { migration017 } from './017-discord-message-routes.js';
import { runMigrations } from './index.js';

function tableColumns(table: string): Set<string> {
  return new Set(
    (getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

describe('migration 017: discord message routes and cursors', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => closeDb());

  it('creates discord_message_routes with the claim/lease/status shape', () => {
    expect(tableColumns('discord_message_routes')).toEqual(
      new Set([
        'channel_id',
        'message_id',
        'guild_id',
        'author_id',
        'first_seen_at',
        'claimed_at',
        'lease_expires_at',
        'routed_at',
        'failed_at',
        'attempts',
        'status',
        'source',
        'last_error',
      ]),
    );
  });

  it('creates discord_channel_cursors keyed by channel', () => {
    expect(tableColumns('discord_channel_cursors')).toEqual(new Set(['channel_id', 'last_message_id', 'updated_at']));
  });

  it('enforces one route row per (channel_id, message_id)', () => {
    const insert = getDb().prepare(
      `INSERT INTO discord_message_routes (channel_id, message_id, first_seen_at) VALUES (?, ?, ?)`,
    );
    insert.run('c1', 'm1', '2026-07-30T00:00:00.000Z');
    expect(() => insert.run('c1', 'm1', '2026-07-30T00:00:01.000Z')).toThrow();
  });

  it('is idempotent when re-applied (IF NOT EXISTS)', () => {
    // runMigrations already dedupes by name; the SQL itself must also be safe.
    expect(() => migration017.up(getDb())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/db/migrations/017-discord-message-routes.test.ts`
Expected: FAIL — cannot resolve `./017-discord-message-routes.js` (module does not exist).

- [ ] **Step 3: Write the migration**

Create `src/db/migrations/017-discord-message-routes.ts`:

```ts
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: '017-discord-message-routes',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS discord_message_routes (
        channel_id       TEXT NOT NULL,
        message_id       TEXT NOT NULL,
        guild_id         TEXT,
        author_id        TEXT,
        first_seen_at    TEXT NOT NULL,
        claimed_at       TEXT,
        lease_expires_at TEXT,
        routed_at        TEXT,
        failed_at        TEXT,
        attempts         INTEGER NOT NULL DEFAULT 0,
        status           TEXT NOT NULL DEFAULT 'processing',
        source           TEXT,
        last_error       TEXT,
        PRIMARY KEY (channel_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_discord_message_routes_status
        ON discord_message_routes(status, lease_expires_at);
      CREATE INDEX IF NOT EXISTS idx_discord_message_routes_seen
        ON discord_message_routes(first_seen_at);

      CREATE TABLE IF NOT EXISTS discord_channel_cursors (
        channel_id      TEXT PRIMARY KEY,
        last_message_id TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
    `);
  },
};
```

`status` values: `'processing' | 'routed' | 'failed'`. `'routed'` means "handed to the shared ingress path" — the router may still legitimately drop it (own message, unwired channel). `source` values: `'gateway' | 'catchup'`.

Register it in `src/db/migrations/index.ts` — add after the `migration016` import:

```ts
import { migration017 } from './017-discord-message-routes.js';
```

and append `migration017,` as the LAST element of the `migrations` array (after `migration016,`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/db/migrations/017-discord-message-routes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full-suite + typecheck + commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
git add src/db/migrations/017-discord-message-routes.ts src/db/migrations/017-discord-message-routes.test.ts src/db/migrations/index.ts
git commit -m "feat(discord): add migration 017 for message routes and channel cursors"
```

---

### Task 2: Claim/lease/status helpers (`discord-state.ts`, part 1)

**Files:**
- Create: `src/channels/discord-state.ts`
- Create: `src/channels/discord-state.test.ts`

**Interfaces:**
- Consumes: `getDb` from `../db/connection.js`; tables from Task 1.
- Produces (exact — later tasks import these):

```ts
export const DISCORD_ROUTE_MAX_ATTEMPTS = 3;

export type DiscordMessageRouteMeta = {
  guildId: string | null;
  authorId: string | null;
  source: 'gateway' | 'catchup';
};

export type DiscordClaimResult =
  | { claimed: true; status: 'processing' }
  | { claimed: false; status: 'already-routed' | 'abandoned' | 'active-lease' };

export function claimDiscordMessage(
  channelId: string,
  messageId: string,
  meta: DiscordMessageRouteMeta,
  now: string,
  leaseExpiresAt: string,
): DiscordClaimResult;
export function markDiscordMessageRouted(channelId: string, messageId: string, routedAt: string): void;
export function markDiscordMessageFailed(channelId: string, messageId: string, failedAt: string, error: string): void;
export function isDiscordMessageTerminal(channelId: string, messageId: string): boolean;
export function getDiscordMessageRouteAttempts(channelId: string, messageId: string): number;
```

Time is always injected as ISO-8601 strings — this module has NO clock (mirrors `agentmail-state.ts`; makes tests deterministic without fake timers).

- [ ] **Step 1: Write the failing tests**

Create `src/channels/discord-state.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import {
  claimDiscordMessage,
  DISCORD_ROUTE_MAX_ATTEMPTS,
  isDiscordMessageTerminal,
  markDiscordMessageFailed,
  markDiscordMessageRouted,
} from './discord-state.js';

const META = { guildId: 'g1', authorId: 'u1', source: 'gateway' as const };
const T0 = '2026-07-30T00:00:00.000Z';
const T0_LEASE = '2026-07-30T00:02:00.000Z';
const T1 = '2026-07-30T00:00:01.000Z';
const T1_LEASE = '2026-07-30T00:02:01.000Z';
const AFTER_LEASE = '2026-07-30T00:02:30.000Z';
const AFTER_LEASE_LEASE = '2026-07-30T00:04:30.000Z';

describe('Discord message route claims', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => closeDb());

  it('first claim wins; second claim while the lease is active is refused', () => {
    expect(claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE)).toEqual({ claimed: true, status: 'processing' });
    expect(claimDiscordMessage('c1', 'm1', META, T1, T1_LEASE)).toEqual({ claimed: false, status: 'active-lease' });
  });

  it('routed messages refuse reclaim and are terminal', () => {
    claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE);
    markDiscordMessageRouted('c1', 'm1', T1);
    expect(claimDiscordMessage('c1', 'm1', META, AFTER_LEASE, AFTER_LEASE_LEASE)).toEqual({
      claimed: false,
      status: 'already-routed',
    });
    expect(isDiscordMessageTerminal('c1', 'm1')).toBe(true);
  });

  it('an expired lease reclaims with attempts+1', () => {
    claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE);
    expect(claimDiscordMessage('c1', 'm1', META, AFTER_LEASE, AFTER_LEASE_LEASE)).toEqual({
      claimed: true,
      status: 'processing',
    });
  });

  it('failed messages stay reclaimable until DISCORD_ROUTE_MAX_ATTEMPTS, then become terminal', () => {
    for (let attempt = 1; attempt <= DISCORD_ROUTE_MAX_ATTEMPTS; attempt += 1) {
      const now = `2026-07-30T00:0${attempt}:00.000Z`;
      const lease = `2026-07-30T00:0${attempt}:30.000Z`;
      expect(claimDiscordMessage('c1', 'm-fail', META, now, lease)).toEqual({ claimed: true, status: 'processing' });
      expect(isDiscordMessageTerminal('c1', 'm-fail')).toBe(false);
      markDiscordMessageFailed('c1', 'm-fail', now, `boom ${attempt}`);
    }
    expect(isDiscordMessageTerminal('c1', 'm-fail')).toBe(true);
    expect(claimDiscordMessage('c1', 'm-fail', META, '2026-07-30T00:09:00.000Z', '2026-07-30T00:09:30.000Z')).toEqual({
      claimed: false,
      status: 'abandoned',
    });
  });

  it('messages in different channels claim independently', () => {
    expect(claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE)).toEqual({ claimed: true, status: 'processing' });
    expect(claimDiscordMessage('c2', 'm1', META, T0, T0_LEASE)).toEqual({ claimed: true, status: 'processing' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/discord-state.test.ts`
Expected: FAIL — cannot resolve `./discord-state.js`.

- [ ] **Step 3: Write the implementation**

Create `src/channels/discord-state.ts` (modeled line-for-line on `agentmail-state.ts:36-75`; `getDb()` called inline, never cached):

```ts
import { getDb } from '../db/connection.js';

/** A route is terminally failed (abandoned) after this many claim attempts. */
export const DISCORD_ROUTE_MAX_ATTEMPTS = 3;

export type DiscordMessageRouteMeta = {
  guildId: string | null;
  authorId: string | null;
  source: 'gateway' | 'catchup';
};

export type DiscordClaimResult =
  | { claimed: true; status: 'processing' }
  | { claimed: false; status: 'already-routed' | 'abandoned' | 'active-lease' };

/**
 * Transactional claim for one Discord message at the ingress choke point.
 * - 'routed' refuses forever (already handed to the shared ingress path).
 * - 'failed' reclaims (attempts+1) until DISCORD_ROUTE_MAX_ATTEMPTS, then
 *   refuses as 'abandoned' — bounded retries, a channel can never wedge.
 * - an active 'processing' lease refuses; an expired lease reclaims.
 * Time is injected (ISO strings) — this module has no clock.
 */
export function claimDiscordMessage(
  channelId: string,
  messageId: string,
  meta: DiscordMessageRouteMeta,
  now: string,
  leaseExpiresAt: string,
): DiscordClaimResult {
  const claim = getDb().transaction((): DiscordClaimResult => {
    const existing = getDb()
      .prepare(
        `SELECT status, lease_expires_at, attempts
           FROM discord_message_routes
          WHERE channel_id = ? AND message_id = ?`,
      )
      .get(channelId, messageId) as
      | { status: string; lease_expires_at: string | null; attempts: number }
      | undefined;

    if (existing?.status === 'routed') return { claimed: false, status: 'already-routed' };
    if (existing?.status === 'failed' && existing.attempts >= DISCORD_ROUTE_MAX_ATTEMPTS) {
      return { claimed: false, status: 'abandoned' };
    }
    if (existing?.lease_expires_at && existing.lease_expires_at > now && existing.status === 'processing') {
      return { claimed: false, status: 'active-lease' };
    }

    getDb()
      .prepare(
        `INSERT INTO discord_message_routes (
           channel_id, message_id, guild_id, author_id, first_seen_at,
           claimed_at, lease_expires_at, attempts, status, source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'processing', ?)
         ON CONFLICT(channel_id, message_id) DO UPDATE SET
           claimed_at = excluded.claimed_at,
           lease_expires_at = excluded.lease_expires_at,
           attempts = discord_message_routes.attempts + 1,
           status = 'processing',
           last_error = NULL`,
      )
      .run(channelId, messageId, meta.guildId, meta.authorId, now, now, leaseExpiresAt, meta.source);

    return { claimed: true, status: 'processing' };
  }) as () => DiscordClaimResult;
  return claim();
}

export function markDiscordMessageRouted(channelId: string, messageId: string, routedAt: string): void {
  getDb()
    .prepare(
      `UPDATE discord_message_routes
          SET status = 'routed',
              routed_at = ?,
              lease_expires_at = NULL,
              last_error = NULL
        WHERE channel_id = ? AND message_id = ?`,
    )
    .run(routedAt, channelId, messageId);
}

export function markDiscordMessageFailed(channelId: string, messageId: string, failedAt: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE discord_message_routes
          SET status = 'failed',
              failed_at = ?,
              lease_expires_at = NULL,
              last_error = ?
        WHERE channel_id = ? AND message_id = ?`,
    )
    .run(failedAt, error.slice(0, 2000), channelId, messageId);
}

/** Terminal = handled: 'routed', or 'failed' with attempts exhausted (abandoned). */
export function isDiscordMessageTerminal(channelId: string, messageId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1
         FROM discord_message_routes
        WHERE channel_id = ? AND message_id = ?
          AND (status = 'routed' OR (status = 'failed' AND attempts >= ?))
        LIMIT 1`,
    )
    .get(channelId, messageId, DISCORD_ROUTE_MAX_ATTEMPTS);
  return Boolean(row);
}

export function getDiscordMessageRouteAttempts(channelId: string, messageId: string): number {
  const row = getDb()
    .prepare(`SELECT attempts FROM discord_message_routes WHERE channel_id = ? AND message_id = ?`)
    .get(channelId, messageId) as { attempts: number } | undefined;
  return row?.attempts ?? 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/discord-state.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full-suite + commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
git add src/channels/discord-state.ts src/channels/discord-state.test.ts
git commit -m "feat(discord): add claim/lease route state for discord messages"
```

---

### Task 3: Cursor, prune, and source helpers (`discord-state.ts`, part 2)

**Files:**
- Modify: `src/channels/discord-state.ts`
- Modify: `src/channels/discord-state.test.ts`

**Interfaces:**
- Consumes: Task 1 tables, Task 2 module.
- Produces (exact):

```ts
export function getDiscordChannelCursor(channelId: string): string | null;
export function advanceDiscordChannelCursor(channelId: string, messageId: string, updatedAt: string): void; // monotonic (BigInt compare), never regresses; inserts when absent
export function pruneDiscordMessageRoutes(cutoff: string): number; // deletes status='routed' rows with routed_at < cutoff; returns count
export function markDiscordMessageSource(channelId: string, messageId: string, source: 'gateway' | 'catchup'): void;
```

- [ ] **Step 1: Add the failing tests**

Append to `src/channels/discord-state.test.ts` (extend the import list with `advanceDiscordChannelCursor, getDiscordChannelCursor, markDiscordMessageSource, pruneDiscordMessageRoutes` and add `getDb` to the `../db/connection.js` import):

```ts
describe('Discord channel cursors and route hygiene', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => closeDb());

  it('cursor advance is monotonic under BigInt snowflake compare', () => {
    expect(getDiscordChannelCursor('c1')).toBeNull();
    advanceDiscordChannelCursor('c1', '100', T0);
    expect(getDiscordChannelCursor('c1')).toBe('100');
    advanceDiscordChannelCursor('c1', '99', T1);
    expect(getDiscordChannelCursor('c1')).toBe('100'); // never regresses
    // mixed string lengths: numeric compare, not lexicographic ('1000' > '999')
    advanceDiscordChannelCursor('c1', '1000', T1);
    expect(getDiscordChannelCursor('c1')).toBe('1000');
    advanceDiscordChannelCursor('c1', '999', T1);
    expect(getDiscordChannelCursor('c1')).toBe('1000');
  });

  it('prune removes only old routed rows', () => {
    claimDiscordMessage('c1', 'm-old-routed', META, '2026-06-01T00:00:00.000Z', '2026-06-01T00:02:00.000Z');
    markDiscordMessageRouted('c1', 'm-old-routed', '2026-06-01T00:00:01.000Z');
    claimDiscordMessage('c1', 'm-new-routed', META, '2026-07-29T00:00:00.000Z', '2026-07-29T00:02:00.000Z');
    markDiscordMessageRouted('c1', 'm-new-routed', '2026-07-29T00:00:01.000Z');
    claimDiscordMessage('c1', 'm-old-failed', META, '2026-06-01T00:00:00.000Z', '2026-06-01T00:02:00.000Z');
    markDiscordMessageFailed('c1', 'm-old-failed', '2026-06-01T00:00:01.000Z', 'boom');

    expect(pruneDiscordMessageRoutes('2026-07-01T00:00:00.000Z')).toBe(1);
    expect(isDiscordMessageTerminal('c1', 'm-new-routed')).toBe(true);
    const remaining = getDb()
      .prepare(`SELECT message_id FROM discord_message_routes ORDER BY message_id`)
      .all() as Array<{ message_id: string }>;
    expect(remaining.map((r) => r.message_id)).toEqual(['m-new-routed', 'm-old-failed']);
  });

  it('marks route source for catch-up attribution', () => {
    claimDiscordMessage('c1', 'm1', META, T0, T0_LEASE);
    markDiscordMessageSource('c1', 'm1', 'catchup');
    const row = getDb()
      .prepare(`SELECT source FROM discord_message_routes WHERE channel_id = 'c1' AND message_id = 'm1'`)
      .get() as { source: string };
    expect(row.source).toBe('catchup');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/discord-state.test.ts`
Expected: FAIL — `advanceDiscordChannelCursor` (etc.) not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/channels/discord-state.ts`:

```ts
export function getDiscordChannelCursor(channelId: string): string | null {
  const row = getDb()
    .prepare(`SELECT last_message_id FROM discord_channel_cursors WHERE channel_id = ?`)
    .get(channelId) as { last_message_id: string } | undefined;
  return row?.last_message_id ?? null;
}

/**
 * Move the durable last-seen cursor forward. Monotonic under numeric
 * (BigInt) snowflake comparison — a stale writer can never move it back.
 */
export function advanceDiscordChannelCursor(channelId: string, messageId: string, updatedAt: string): void {
  const advance = getDb().transaction((): void => {
    const existing = getDiscordChannelCursor(channelId);
    if (existing !== null && BigInt(existing) >= BigInt(messageId)) return;
    getDb()
      .prepare(
        `INSERT INTO discord_channel_cursors (channel_id, last_message_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           last_message_id = excluded.last_message_id,
           updated_at = excluded.updated_at`,
      )
      .run(channelId, messageId, updatedAt);
  }) as () => void;
  advance();
}

/** Bound table growth: drop 'routed' rows older than the cutoff (ISO string). */
export function pruneDiscordMessageRoutes(cutoff: string): number {
  const result = getDb()
    .prepare(`DELETE FROM discord_message_routes WHERE status = 'routed' AND routed_at < ?`)
    .run(cutoff);
  return result.changes;
}

/** Post-hoc source attribution — catch-up marks rows it routed (see plan design notes). */
export function markDiscordMessageSource(channelId: string, messageId: string, source: 'gateway' | 'catchup'): void {
  getDb()
    .prepare(`UPDATE discord_message_routes SET source = ? WHERE channel_id = ? AND message_id = ?`)
    .run(source, channelId, messageId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/discord-state.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full-suite + commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
git add src/channels/discord-state.ts src/channels/discord-state.test.ts
git commit -m "feat(discord): add channel cursors, route pruning, and source attribution"
```

---

### Task 4: `forwardDiscordGatewayEventWithRetry` reports delivery success

**Files:**
- Modify: `src/channels/discord.ts:292-353` (return type `Promise<void>` → `Promise<boolean>`)
- Modify: `src/channels/discord.test.ts` (describe block `'forwardDiscordGatewayEventWithRetry'`, starts ~line 202)

**Interfaces:**
- Consumes: existing function at `discord.ts:292` (signature above in Design Notes).
- Produces: `forwardDiscordGatewayEventWithRetry(webhookUrl: string, event: { type: string }, botToken: string, deps?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<boolean>` — resolves `true` iff a delivery attempt got `response.ok`; `false` on every give-up path. Still NEVER throws. The catch-up engine (Task 6) uses the boolean to decide cursor advancement.

- [ ] **Step 1: Add the failing tests**

In the existing `describe('forwardDiscordGatewayEventWithRetry', …)` block of `src/channels/discord.test.ts`, add:

```ts
  it('resolves true when the webhook accepts the event', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
    await expect(
      forwardDiscordGatewayEventWithRetry('http://127.0.0.1:9/webhook', { type: 'GATEWAY_MESSAGE_CREATE' }, 't', {
        fetchImpl,
        sleep: async () => {},
      }),
    ).resolves.toBe(true);
  });

  it('resolves false after exhausting retries', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(
      forwardDiscordGatewayEventWithRetry('http://127.0.0.1:9/webhook', { type: 'GATEWAY_MESSAGE_CREATE' }, 't', {
        fetchImpl,
        sleep: async () => {},
      }),
    ).resolves.toBe(false);
  });

  it('resolves false immediately on 4xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 401 })) as unknown as typeof fetch;
    await expect(
      forwardDiscordGatewayEventWithRetry('http://127.0.0.1:9/webhook', { type: 'GATEWAY_MESSAGE_CREATE' }, 't', {
        fetchImpl,
        sleep: async () => {},
      }),
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/discord.test.ts`
Expected: FAIL — the three new tests get `undefined` instead of `true`/`false`. (If any pre-existing test asserted `resolves.toBeUndefined()`, it will be updated in Step 3.)

- [ ] **Step 3: Change the return type**

In `src/channels/discord.ts`, change the signature's `): Promise<void> {` to `): Promise<boolean> {`, and update the four exit points inside the body (do not change retry/log behavior):
- `if (response.ok) return;` → `if (response.ok) return true;`
- the non-transient/final thrown-error path `return;` (after `log.error('Error forwarding Gateway event', …)`) → `return false;`
- the final 4xx/5xx path `return;` (after `log.error('Failed to forward Gateway event', …)`) → `return false;`
- add `return false;` as the function's last statement (after the `for` loop, previously unreachable — TypeScript now requires it).

Update the docblock's last sentence to: `Never throws; resolves true only when the webhook accepted the event.`

If existing tests in `discord.test.ts` assert the resolved value is `undefined`, change those assertions to the new boolean (`true` for ok paths, `false` for give-up paths) — do NOT change their log-spy assertions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/discord.test.ts`
Expected: PASS (all pre-existing + 3 new).

- [ ] **Step 5: Full-suite + commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
git add src/channels/discord.ts src/channels/discord.test.ts
git commit -m "feat(discord): report gateway forward delivery success as boolean"
```

---

### Task 5: Catch-up config and snowflake helpers (`discord-catchup.ts` foundations)

**Files:**
- Create: `src/channels/discord-catchup.ts`
- Create: `src/channels/discord-catchup.test.ts`

**Interfaces:**
- Consumes: nothing repo-internal yet (pure functions).
- Produces (exact — Tasks 6–11 import these):

```ts
export const DEFAULT_DISCORD_CATCHUP_INTERVAL_MS = 300000;
export const DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS = 15000;
export const DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES = 200;
export const DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS = 259200000;
export const DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS = 120000;
export const DEFAULT_DISCORD_CATCHUP_MAX_THREADS = 25;

export type DiscordCatchupConfig = {
  disabled: boolean;
  intervalMs: number;
  readyDebounceMs: number;
  maxMessages: number;
  maxAgeMs: number;
  routeLeaseMs: number;
  maxThreads: number;
};
export function discordCatchupConfigFromEnv(env: NodeJS.ProcessEnv): DiscordCatchupConfig;

export function snowflakeToUnixMs(snowflake: string): number;
export function unixMsToSnowflake(unixMs: number): string;
export function compareSnowflakes(a: string, b: string): number; // -1 | 0 | 1, numeric BigInt order
```

- [ ] **Step 1: Write the failing tests**

Create `src/channels/discord-catchup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  compareSnowflakes,
  DEFAULT_DISCORD_CATCHUP_INTERVAL_MS,
  DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS,
  DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES,
  DEFAULT_DISCORD_CATCHUP_MAX_THREADS,
  DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS,
  DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS,
  discordCatchupConfigFromEnv,
  snowflakeToUnixMs,
  unixMsToSnowflake,
} from './discord-catchup.js';

describe('discordCatchupConfigFromEnv', () => {
  it('returns spec defaults on an empty env', () => {
    expect(discordCatchupConfigFromEnv({})).toEqual({
      disabled: false,
      intervalMs: DEFAULT_DISCORD_CATCHUP_INTERVAL_MS,
      readyDebounceMs: DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS,
      maxMessages: DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES,
      maxAgeMs: DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS,
      routeLeaseMs: DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS,
      maxThreads: DEFAULT_DISCORD_CATCHUP_MAX_THREADS,
    });
    expect(DEFAULT_DISCORD_CATCHUP_INTERVAL_MS).toBe(300000);
    expect(DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS).toBe(15000);
    expect(DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES).toBe(200);
    expect(DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS).toBe(259200000);
    expect(DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS).toBe(120000);
    expect(DEFAULT_DISCORD_CATCHUP_MAX_THREADS).toBe(25);
  });

  it('reads the kill switch and interval=0 (periodic disable)', () => {
    const config = discordCatchupConfigFromEnv({ DISCORD_CATCHUP_DISABLED: '1', DISCORD_CATCHUP_INTERVAL_MS: '0' });
    expect(config.disabled).toBe(true);
    expect(config.intervalMs).toBe(0);
  });

  it('throws loudly on malformed values, naming the variable', () => {
    expect(() => discordCatchupConfigFromEnv({ DISCORD_CATCHUP_MAX_MESSAGES: 'lots' })).toThrow(
      /DISCORD_CATCHUP_MAX_MESSAGES/,
    );
    expect(() => discordCatchupConfigFromEnv({ DISCORD_CATCHUP_MAX_MESSAGES: '0' })).toThrow(
      /DISCORD_CATCHUP_MAX_MESSAGES/,
    );
  });
});

describe('snowflake helpers', () => {
  it('round-trips a unix timestamp through a synthetic snowflake', () => {
    const ms = 1753900000000; // well past the Discord epoch
    expect(snowflakeToUnixMs(unixMsToSnowflake(ms))).toBe(ms);
  });

  it('compares snowflakes numerically, not lexicographically', () => {
    expect(compareSnowflakes('999', '1000')).toBe(-1);
    expect(compareSnowflakes('1000', '999')).toBe(1);
    expect(compareSnowflakes('42', '42')).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts`
Expected: FAIL — cannot resolve `./discord-catchup.js`.

- [ ] **Step 3: Write the implementation**

Create `src/channels/discord-catchup.ts`:

```ts
/**
 * Discord catch-up engine: recovers messages that arrived while the gateway
 * was disconnected (fresh IDENTIFY gets no replay) or the service was down.
 * Mirrors the AgentMail catch-up pattern (agentmail.ts) adapted to Discord's
 * snowflake-cursor REST pagination. See docs/plans/2026-07-30-discord-catchup.md.
 */

export const DEFAULT_DISCORD_CATCHUP_INTERVAL_MS = 300000; // 5 min periodic safety net
export const DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS = 15000; // coalesce READY bursts
export const DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES = 200; // per channel per run (2 REST pages)
export const DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS = 259200000; // 72 h backfill horizon
export const DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS = 120000; // choke-point claim lease
export const DEFAULT_DISCORD_CATCHUP_MAX_THREADS = 25; // active-thread backfill bound per run

const DISCORD_EPOCH_MS = 1420070400000;

export type DiscordCatchupConfig = {
  disabled: boolean;
  intervalMs: number;
  readyDebounceMs: number;
  maxMessages: number;
  maxAgeMs: number;
  routeLeaseMs: number;
  maxThreads: number;
};

function integerEnv(env: NodeJS.ProcessEnv, key: string, defaultValue: number, min: number): number {
  const raw = env[key]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${key} must be an integer >= ${min}`);
  }
  return parsed;
}

export function discordCatchupConfigFromEnv(env: NodeJS.ProcessEnv): DiscordCatchupConfig {
  return {
    disabled: env.DISCORD_CATCHUP_DISABLED?.trim() === '1',
    intervalMs: integerEnv(env, 'DISCORD_CATCHUP_INTERVAL_MS', DEFAULT_DISCORD_CATCHUP_INTERVAL_MS, 0),
    readyDebounceMs: integerEnv(env, 'DISCORD_CATCHUP_READY_DEBOUNCE_MS', DEFAULT_DISCORD_CATCHUP_READY_DEBOUNCE_MS, 1),
    maxMessages: integerEnv(env, 'DISCORD_CATCHUP_MAX_MESSAGES', DEFAULT_DISCORD_CATCHUP_MAX_MESSAGES, 1),
    maxAgeMs: integerEnv(env, 'DISCORD_CATCHUP_MAX_AGE_MS', DEFAULT_DISCORD_CATCHUP_MAX_AGE_MS, 1),
    routeLeaseMs: integerEnv(env, 'DISCORD_CATCHUP_ROUTE_LEASE_MS', DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS, 1),
    maxThreads: integerEnv(env, 'DISCORD_CATCHUP_MAX_THREADS', DEFAULT_DISCORD_CATCHUP_MAX_THREADS, 0),
  };
}

export function snowflakeToUnixMs(snowflake: string): number {
  return Number((BigInt(snowflake) >> 22n) + BigInt(DISCORD_EPOCH_MS));
}

export function unixMsToSnowflake(unixMs: number): string {
  const sinceEpoch = Math.max(0, unixMs - DISCORD_EPOCH_MS);
  return (BigInt(sinceEpoch) << 22n).toString();
}

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full-suite + commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
git add src/channels/discord-catchup.ts src/channels/discord-catchup.test.ts
git commit -m "feat(discord): add catch-up config parsing and snowflake helpers"
```

---

### Task 6: Catch-up engine core — `createDiscordCatchup().runOnce()`

**Files:**
- Modify: `src/channels/discord-catchup.ts`
- Modify: `src/channels/discord-catchup.test.ts`

**Interfaces:**
- Consumes: Task 2/3 state functions; Task 4 `forwardDiscordGatewayEventWithRetry` (boolean) from `./discord.js`; Task 5 helpers; `log` from `../log.js`.
- Produces (exact — Tasks 8, 11, 12 rely on these):

```ts
export type DiscordCatchupReason = 'ready' | 'startup' | 'periodic';

export type DiscordCatchupRunSummary = {
  reason: DiscordCatchupReason;
  channels: number;
  threads: number;
  fetched: number;
  routed: number;
  skippedTerminal: number;
  failed: number;
  durationMs: number;
};

export type DiscordCatchupDeps = {
  botToken: string;
  webhookUrl: string;
  monitoredChannelIds: () => Set<string>; // recomputed per run — new channels join without restart
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number; // epoch ms
};

export type DiscordCatchup = {
  runOnce(reason: DiscordCatchupReason): Promise<DiscordCatchupRunSummary | null>; // null when disabled
  onGatewayEvent(type: string): void; // Task 8
  start(): void; // Task 8
  stop(): void; // Task 8
};

export function createDiscordCatchup(deps: DiscordCatchupDeps): DiscordCatchup;
```

In THIS task `onGatewayEvent`/`start`/`stop` are wired as inert stubs (`() => {}` bodies with a `// Task 8` comment) so the type is complete; Task 8 implements them.

- [ ] **Step 1: Add the failing tests**

Append to `src/channels/discord-catchup.test.ts`. Shared harness first (place above the new `describe`):

```ts
import { afterEach, beforeEach, vi } from 'vitest'; // merge into the existing vitest import

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createDiscordCatchup } from './discord-catchup.js'; // merge into existing import
import {
  advanceDiscordChannelCursor,
  claimDiscordMessage,
  getDiscordChannelCursor,
  markDiscordMessageRouted,
} from './discord-state.js';

type FakeMessage = Record<string, unknown> & { id: string; type: number };

function restMessage(id: string, overrides: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    type: 0,
    channel_id: 'chan-1',
    content: `msg ${id}`,
    author: { id: 'user-1', bot: false },
    mentions: [],
    attachments: [],
    timestamp: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/**
 * Fake transport for both Discord REST (discord.com) and the local webhook.
 * `rest` maps URL substrings to queued responses; webhook POSTs are recorded.
 */
function fakeTransport(rest: Record<string, Response[]>, webhookStatus: () => number = () => 200) {
  const webhookPosts: Array<{ type: string; data: Record<string, unknown> }> = [];
  const restCalls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/webhook')) {
      webhookPosts.push(JSON.parse(String(init?.body)) as { type: string; data: Record<string, unknown> });
      return new Response('{"ok":true}', { status: webhookStatus() });
    }
    restCalls.push(url);
    for (const [needle, queue] of Object.entries(rest)) {
      if (url.includes(needle) && queue.length > 0) return queue.shift() as Response;
    }
    return json([], 200);
  }) as typeof fetch;
  return { fetchImpl, webhookPosts, restCalls };
}

const CHANNEL_INFO = { id: 'chan-1', guild_id: 'guild-1', last_message_id: '500' };

function makeEngine(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = {}, nowMs = () => 1753900000000) {
  return createDiscordCatchup({
    botToken: 'test-token',
    webhookUrl: 'http://127.0.0.1:9999/webhook',
    monitoredChannelIds: () => new Set(['chan-1']),
    env,
    fetchImpl,
    sleep: async () => {},
    now: nowMs,
  });
}
```

Then the tests:

```ts
describe('createDiscordCatchup runOnce', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => closeDb());

  it('initializes a missing cursor at the channel head and routes nothing (first deploy)', async () => {
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('startup');
    expect(webhookPosts).toHaveLength(0);
    expect(summary?.routed).toBe(0);
    expect(getDiscordChannelCursor('chan-1')).toBe('500');
  });

  it('fetches after the cursor ascending, injects guild_id, and POSTs GATEWAY_MESSAGE_CREATE', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([restMessage('502'), restMessage('501')]), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('periodic');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['501', '502']); // ascending despite API order
    expect(webhookPosts[0]?.type).toBe('GATEWAY_MESSAGE_CREATE');
    expect(webhookPosts[0]?.data.guild_id).toBe('guild-1');
    expect(summary?.routed).toBe(2);
    expect(getDiscordChannelCursor('chan-1')).toBe('502');
  });

  it('skips terminal messages but advances the cursor past them', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    claimDiscordMessage(
      'chan-1',
      '501',
      { guildId: 'guild-1', authorId: 'user-1', source: 'gateway' },
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:02:00.000Z',
    );
    markDiscordMessageRouted('chan-1', '501', '2026-07-30T00:00:01.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([restMessage('501'), restMessage('502')]), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('periodic');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['502']);
    expect(summary?.skippedTerminal).toBe(1);
    expect(getDiscordChannelCursor('chan-1')).toBe('502');
  });

  it('skips non-routable message types (keeps 0 and 19) while advancing the cursor', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [
        json([restMessage('501', { type: 18 }), restMessage('502', { type: 19 }), restMessage('503', { type: 0 })]),
        json([]),
      ],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    await engine.runOnce('periodic');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['502', '503']);
    expect(getDiscordChannelCursor('chan-1')).toBe('503');
  });

  it('respects DISCORD_CATCHUP_MAX_MESSAGES per channel per run', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([restMessage('501'), restMessage('502'), restMessage('503')]), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl, { DISCORD_CATCHUP_MAX_MESSAGES: '2' });
    await engine.runOnce('periodic');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['501', '502']);
    expect(getDiscordChannelCursor('chan-1')).toBe('502'); // remainder next run
  });

  it('backfills active threads whose parent is monitored, with their own cursors', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    advanceDiscordChannelCursor('thread-1', '600', '2026-07-30T00:00:00.000Z');
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      '/guilds/guild-1/threads/active': [
        json({ threads: [{ id: 'thread-1', parent_id: 'chan-1', last_message_id: '601' }] }),
      ],
      '/channels/chan-1/messages': [json([])],
      '/channels/thread-1/messages': [json([restMessage('601', { channel_id: 'thread-1' })]), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('periodic');
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['601']);
    expect(summary?.threads).toBe(1);
    expect(getDiscordChannelCursor('thread-1')).toBe('601');
  });

  it('clamps a stale cursor to the max-age horizon', async () => {
    // Cursor far older than maxAge: with maxAge=1000ms and now=1753900000000,
    // the clamp floor is snowflake(now-1000). The engine must query with
    // after >= that floor, not the ancient cursor.
    advanceDiscordChannelCursor('chan-1', '1', '2026-07-30T00:00:00.000Z');
    const { fetchImpl, restCalls } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl, { DISCORD_CATCHUP_MAX_AGE_MS: '1000' });
    await engine.runOnce('periodic');
    const messagesCall = restCalls.find((u) => u.includes('messages?after='));
    const after = new URL(messagesCall as string).searchParams.get('after') as string;
    expect(BigInt(after)).toBeGreaterThan(1n);
  });

  it('returns null and fetches nothing when DISCORD_CATCHUP_DISABLED=1', async () => {
    const { fetchImpl, restCalls } = fakeTransport({});
    const engine = makeEngine(fetchImpl, { DISCORD_CATCHUP_DISABLED: '1' });
    expect(await engine.runOnce('startup')).toBeNull();
    expect(restCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts`
Expected: FAIL — `createDiscordCatchup` not exported.

- [ ] **Step 3: Write the engine core**

Append to `src/channels/discord-catchup.ts` (new imports at top of file, keeping `.js` extensions):

```ts
import { log } from '../log.js';
import { forwardDiscordGatewayEventWithRetry } from './discord.js';
import {
  advanceDiscordChannelCursor,
  DISCORD_ROUTE_MAX_ATTEMPTS,
  getDiscordChannelCursor,
  getDiscordMessageRouteAttempts,
  isDiscordMessageTerminal,
  markDiscordMessageSource,
  pruneDiscordMessageRoutes,
} from './discord-state.js';
```

and the engine (module constants + factory):

```ts
const DISCORD_API_BASE = 'https://discord.com/api/v10';
/** Whole-run wall-clock cap; a pathological backlog can't starve the process. */
export const DISCORD_CATCHUP_RUN_WALL_CLOCK_MS = 60000;
/** Sequential REST pacing — hard floor ~2 req/s. */
export const DISCORD_CATCHUP_REST_PACING_MS = 500;
/** Routed route rows older than this are pruned on periodic runs. */
export const DISCORD_ROUTE_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Message types routed by catch-up: 0 = DEFAULT, 19 = REPLY. */
const ROUTABLE_MESSAGE_TYPES = new Set([0, 19]);

export type DiscordCatchupReason = 'ready' | 'startup' | 'periodic';

export type DiscordCatchupRunSummary = {
  reason: DiscordCatchupReason;
  channels: number;
  threads: number;
  fetched: number;
  routed: number;
  skippedTerminal: number;
  failed: number;
  durationMs: number;
};

export type DiscordCatchupDeps = {
  botToken: string;
  webhookUrl: string;
  monitoredChannelIds: () => Set<string>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type DiscordCatchup = {
  runOnce(reason: DiscordCatchupReason): Promise<DiscordCatchupRunSummary | null>;
  onGatewayEvent(type: string): void;
  start(): void;
  stop(): void;
};

type DiscordRestMessage = Record<string, unknown> & { id: string; type: number };
type TargetInfo = { id: string; guildId: string; kind: 'channel' | 'thread' };

export function createDiscordCatchup(deps: DiscordCatchupDeps): DiscordCatchup {
  const env = deps.env ?? process.env;
  const config = discordCatchupConfigFromEnv(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const guildCache = new Map<string, string | null>();
  let running: Promise<DiscordCatchupRunSummary | null> | null = null;

  const nowIso = (): string => new Date(now()).toISOString();

  async function discordGetJson<T>(path: string): Promise<T | null> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bot ${deps.botToken}` },
      });
      await sleep(DISCORD_CATCHUP_REST_PACING_MS);
      if (response.status === 429) {
        const retryAfterS = Number(response.headers.get('Retry-After') ?? '1');
        await sleep(Math.max(0, Math.round(retryAfterS * 1000)));
        continue;
      }
      if (!response.ok) {
        log.warn('Discord catch-up REST request failed', { path, status: response.status });
        return null;
      }
      return (await response.json()) as T;
    }
    log.warn('Discord catch-up REST request rate-limited after retries', { path });
    return null;
  }

  async function resolveChannelTarget(channelId: string): Promise<TargetInfo | null> {
    let channelInfo: { guild_id?: string; last_message_id?: string | null } | null = null;
    let guildId = guildCache.get(channelId);
    if (guildId === undefined) {
      channelInfo = await discordGetJson(`/channels/${encodeURIComponent(channelId)}`);
      if (!channelInfo) return null;
      guildId =
        typeof channelInfo.guild_id === 'string' && channelInfo.guild_id.length > 0 ? channelInfo.guild_id : null;
      guildCache.set(channelId, guildId);
    }
    if (guildId === null) {
      // DMs are out of scope v1 (Yente's production intake is guild-channel based).
      log.debug('Discord catch-up skipping non-guild channel', { channelId });
      return null;
    }
    if (!getDiscordChannelCursor(channelId)) {
      // First rollout / newly monitored: initialize at the channel head and
      // route NOTHING — no history replay on first deploy (spec §6.4a).
      if (!channelInfo) channelInfo = await discordGetJson(`/channels/${encodeURIComponent(channelId)}`);
      const head = channelInfo?.last_message_id ?? unixMsToSnowflake(now());
      advanceDiscordChannelCursor(channelId, head, nowIso());
      log.info('Discord catch-up cursor initialized at channel head', { channelId, cursor: head });
      return null;
    }
    return { id: channelId, guildId, kind: 'channel' };
  }

  async function resolveThreadTargets(guildId: string, monitored: Set<string>): Promise<TargetInfo[]> {
    const body = await discordGetJson<{
      threads?: Array<{ id: string; parent_id?: string; last_message_id?: string | null }>;
    }>(`/guilds/${encodeURIComponent(guildId)}/threads/active`);
    if (!body?.threads) return [];
    const relevant = body.threads.filter((thread) => thread.parent_id && monitored.has(thread.parent_id));
    relevant.sort((a, b) => compareSnowflakes(b.last_message_id ?? b.id, a.last_message_id ?? a.id));
    const targets: TargetInfo[] = [];
    for (const thread of relevant.slice(0, config.maxThreads)) {
      if (!getDiscordChannelCursor(thread.id)) {
        // Same no-replay rule as channels: first sight initializes at head.
        advanceDiscordChannelCursor(thread.id, thread.last_message_id ?? thread.id, nowIso());
        continue;
      }
      targets.push({ id: thread.id, guildId, kind: 'thread' });
    }
    return targets;
  }

  async function catchUpTarget(
    target: TargetInfo,
    summary: DiscordCatchupRunSummary,
    deadline: number,
  ): Promise<void> {
    let cursor = getDiscordChannelCursor(target.id);
    if (!cursor) return;
    const minSnowflake = unixMsToSnowflake(now() - config.maxAgeMs);
    if (compareSnowflakes(cursor, minSnowflake) < 0) cursor = minSnowflake; // stale-cursor clamp
    let processed = 0;
    while (processed < config.maxMessages && now() <= deadline) {
      const page = await discordGetJson<DiscordRestMessage[]>(
        `/channels/${encodeURIComponent(target.id)}/messages?after=${encodeURIComponent(cursor)}&limit=100`,
      );
      if (!page || page.length === 0) return;
      page.sort((a, b) => compareSnowflakes(a.id, b.id)); // never trust API ordering
      for (const message of page) {
        if (processed >= config.maxMessages || now() > deadline) return;
        processed += 1;
        summary.fetched += 1;
        const advance = (): void => {
          advanceDiscordChannelCursor(target.id, message.id, nowIso());
          cursor = message.id;
        };
        if (!ROUTABLE_MESSAGE_TYPES.has(message.type)) {
          advance();
          continue;
        }
        if (isDiscordMessageTerminal(target.id, message.id)) {
          summary.skippedTerminal += 1;
          advance();
          continue;
        }
        const event = {
          type: 'GATEWAY_MESSAGE_CREATE',
          timestamp: now(),
          data: { ...message, guild_id: target.guildId },
        };
        const delivered = await forwardDiscordGatewayEventWithRetry(deps.webhookUrl, event, deps.botToken, {
          fetchImpl,
          sleep,
        });
        if (delivered) {
          summary.routed += 1;
          markDiscordMessageSource(target.id, message.id, 'catchup');
          advance();
          log.info('Discord catch-up routed missed message', {
            channelId: target.id,
            messageId: message.id,
            reason: summary.reason,
          });
          continue;
        }
        summary.failed += 1;
        if (getDiscordMessageRouteAttempts(target.id, message.id) >= DISCORD_ROUTE_MAX_ATTEMPTS) {
          // Bounded abandon: never wedge a channel behind one poison message.
          log.error('Discord catch-up abandoned message', { channelId: target.id, messageId: message.id });
          advance();
          continue;
        }
        return; // stop advancing this target; retry from the cursor next run
      }
    }
  }

  async function doRun(reason: DiscordCatchupReason): Promise<DiscordCatchupRunSummary> {
    const startedAt = now();
    const deadline = startedAt + DISCORD_CATCHUP_RUN_WALL_CLOCK_MS;
    const summary: DiscordCatchupRunSummary = {
      reason,
      channels: 0,
      threads: 0,
      fetched: 0,
      routed: 0,
      skippedTerminal: 0,
      failed: 0,
      durationMs: 0,
    };
    try {
      const channels = deps.monitoredChannelIds();
      summary.channels = channels.size;
      const targets: TargetInfo[] = [];
      const guilds = new Set<string>();
      for (const channelId of [...channels].sort()) {
        const target = await resolveChannelTarget(channelId);
        if (target) {
          targets.push(target);
          guilds.add(target.guildId);
        }
      }
      for (const guildId of [...guilds].sort()) {
        const threadTargets = await resolveThreadTargets(guildId, channels);
        summary.threads += threadTargets.length;
        targets.push(...threadTargets);
      }
      for (const target of targets) {
        if (now() > deadline) {
          log.warn('Discord catch-up run hit wall-clock cap', { reason });
          break;
        }
        try {
          await catchUpTarget(target, summary, deadline);
        } catch (error) {
          log.warn('Discord catch-up target failed', { channelId: target.id, error: String(error) });
        }
      }
      if (reason === 'periodic') {
        pruneDiscordMessageRoutes(new Date(now() - DISCORD_ROUTE_PRUNE_AFTER_MS).toISOString());
      }
    } catch (error) {
      log.warn('Discord catch-up run failed', { reason, error: String(error) });
    }
    summary.durationMs = now() - startedAt;
    log.info('Discord catch-up run complete', { ...summary });
    return summary;
  }

  function runOnce(reason: DiscordCatchupReason): Promise<DiscordCatchupRunSummary | null> {
    if (config.disabled) return Promise.resolve(null);
    if (running) return running; // single-flight: overlapping triggers coalesce
    const run = doRun(reason).finally(() => {
      running = null;
    });
    running = run;
    return run;
  }

  return {
    runOnce,
    onGatewayEvent: () => {}, // Task 8
    start: () => {}, // Task 8
    stop: () => {}, // Task 8
  };
}
```

Note on the import cycle: `discord-catchup.ts` imports `forwardDiscordGatewayEventWithRetry` from `./discord.js`, and Task 11 makes `discord.ts` import from `./discord-catchup.js`. Both are function-level uses (no top-level execution of each other's bindings), so the ESM cycle is benign — but if `pnpm exec tsc --noEmit` or runtime import order complains, move `forwardDiscordGatewayEventWithRetry`, `GATEWAY_FORWARD_RETRY_DELAYS_MS`, and `isTransientGatewayForwardError` into a new leaf module `src/channels/discord-gateway-forward.ts` and re-export them from `discord.ts` (`export { forwardDiscordGatewayEventWithRetry, GATEWAY_FORWARD_RETRY_DELAYS_MS } from './discord-gateway-forward.js';`) so existing imports keep working.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts`
Expected: PASS (all Task 5 + 8 new tests).

- [ ] **Step 5: Full-suite + commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
git add src/channels/discord-catchup.ts src/channels/discord-catchup.test.ts
git commit -m "feat(discord): add catch-up engine core with cursor-bounded REST backfill"
```

---

### Task 7: Engine failure semantics — POST failure, abandon, 429, prune

**Files:**
- Modify: `src/channels/discord-catchup.test.ts` (the engine code from Task 6 already implements these paths; this task PROVES them and fixes any gaps found)

**Interfaces:**
- Consumes: Task 6 engine, Task 2/3 state.
- Produces: verified failure-path behavior later tasks depend on (no new exports).

- [ ] **Step 1: Add the failing/verifying tests**

Append to the `describe('createDiscordCatchup runOnce', …)` block:

```ts
  it('stops advancing the cursor at a POST failure and retries from there next run', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    let webhookOk = false;
    const { fetchImpl, webhookPosts } = fakeTransport(
      {
        '/channels/chan-1?': [json(CHANNEL_INFO)],
        'messages?after=': [
          json([restMessage('501'), restMessage('502')]),
          json([restMessage('501'), restMessage('502')]),
          json([]),
        ],
        '/channels/chan-1': [json(CHANNEL_INFO)],
      },
      () => (webhookOk ? 200 : 500),
    );
    const engine = makeEngine(fetchImpl);
    const first = await engine.runOnce('periodic');
    expect(first?.failed).toBe(1);
    expect(getDiscordChannelCursor('chan-1')).toBe('500'); // did not advance past the failure
    expect(webhookPosts.filter((p) => p.data.id === '502')).toHaveLength(0); // stopped at 501

    webhookOk = true;
    const second = await engine.runOnce('periodic');
    expect(second?.routed).toBe(2);
    expect(getDiscordChannelCursor('chan-1')).toBe('502');
  });

  it('treats an attempts-exhausted message as terminal and advances past it', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    // Simulate a poison message: the route row already burned all attempts
    // (each failed live/catch-up traversal claims then fails).
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      claimDiscordMessage(
        'chan-1',
        '501',
        { guildId: 'guild-1', authorId: 'user-1', source: 'gateway' },
        `2026-07-30T00:0${attempt}:00.000Z`,
        `2026-07-30T00:0${attempt}:30.000Z`,
      );
      markDiscordMessageFailed('chan-1', '501', `2026-07-30T00:0${attempt}:01.000Z`, 'poison');
    }
    const { fetchImpl, webhookPosts } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [json([restMessage('501'), restMessage('502')]), json([])],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = makeEngine(fetchImpl);
    const summary = await engine.runOnce('periodic');
    // 501 is terminal (failed, attempts exhausted) -> skipped, cursor advances, 502 still routes
    expect(summary?.skippedTerminal).toBe(1);
    expect(webhookPosts.map((p) => p.data.id)).toEqual(['502']);
    expect(getDiscordChannelCursor('chan-1')).toBe('502');
  });

  it('honors 429 Retry-After on REST fetches', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    const sleeps: number[] = [];
    const { fetchImpl } = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO)],
      'messages?after=': [
        new Response('{"retry_after":2}', { status: 429, headers: { 'Retry-After': '2' } }),
        json([restMessage('501')]),
        json([]),
      ],
      '/channels/chan-1': [json(CHANNEL_INFO)],
    });
    const engine = createDiscordCatchup({
      botToken: 'test-token',
      webhookUrl: 'http://127.0.0.1:9999/webhook',
      monitoredChannelIds: () => new Set(['chan-1']),
      env: {},
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1753900000000,
    });
    const summary = await engine.runOnce('periodic');
    expect(sleeps).toContain(2000); // Retry-After: 2s honored
    expect(summary?.routed).toBe(1);
  });

  it('prunes old routed rows on periodic runs only', async () => {
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
    claimDiscordMessage(
      'chan-1',
      'ancient',
      { guildId: 'guild-1', authorId: 'user-1', source: 'gateway' },
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:02:00.000Z',
    );
    markDiscordMessageRouted('chan-1', 'ancient', '2026-01-01T00:00:01.000Z');
    const transport = () =>
      fakeTransport({
        '/channels/chan-1?': [json(CHANNEL_INFO)],
        'messages?after=': [json([])],
        '/channels/chan-1': [json(CHANNEL_INFO)],
      });
    const countRows = () =>
      (getDb().prepare(`SELECT COUNT(*) AS n FROM discord_message_routes`).get() as { n: number }).n;

    await makeEngine(transport().fetchImpl).runOnce('ready');
    expect(countRows()).toBe(1); // ready runs do not prune
    await makeEngine(transport().fetchImpl).runOnce('periodic');
    expect(countRows()).toBe(0); // periodic runs prune >30-day routed rows
  });
```

Extend the test file's `discord-state.js` import with `markDiscordMessageFailed`.

- [ ] **Step 2: Run tests**

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts`
Expected: PASS if Task 6's implementation is exactly as written; any FAIL here is a real bug in the engine — fix the engine (not the test) until green. The most likely gap: the guild-cache means the second `runOnce` in the first test does not re-fetch `/channels/chan-1?` — the transport above queues enough `messages?after=` responses to cover both runs.

- [ ] **Step 3: Commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
git add src/channels/discord-catchup.ts src/channels/discord-catchup.test.ts
git commit -m "test(discord): prove catch-up failure, abandon, 429, and prune semantics"
```

---

### Task 8: Engine triggers — READY debounce, periodic timer, single-flight, kill switch

**Files:**
- Modify: `src/channels/discord-catchup.ts` (implement `onGatewayEvent`, `start`, `stop`)
- Modify: `src/channels/discord-catchup.test.ts`

**Interfaces:**
- Consumes: Task 6 engine internals.
- Produces (behavioral contract for Task 11 wiring):
  - `onGatewayEvent(type)`: only `'GATEWAY_READY'` arms a debounced (`readyDebounceMs`) `runOnce('ready')`; a READY burst coalesces into one run; `'GATEWAY_RESUMED'` and all other types are ignored; no-op when disabled.
  - `start()`: fires `runOnce('startup')` immediately, then arms the periodic `setInterval` (`unref()`d) unless `intervalMs <= 0`; idempotent; logs and no-ops when disabled.
  - `stop()`: clears both timers; idempotent.

- [ ] **Step 1: Add the failing tests**

Append a new describe to `src/channels/discord-catchup.test.ts`:

```ts
describe('createDiscordCatchup triggers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const db = initTestDb();
    runMigrations(db);
    advanceDiscordChannelCursor('chan-1', '500', '2026-07-30T00:00:00.000Z');
  });

  afterEach(() => {
    vi.useRealTimers();
    closeDb();
  });

  function timerEngine(env: NodeJS.ProcessEnv = {}) {
    // Empty pages: each run costs 1 channel-info fetch (first run only) + 1 messages fetch.
    const transport = fakeTransport({
      '/channels/chan-1?': [json(CHANNEL_INFO), json(CHANNEL_INFO), json(CHANNEL_INFO)],
      '/channels/chan-1': [json(CHANNEL_INFO), json(CHANNEL_INFO), json(CHANNEL_INFO)],
    });
    const engine = createDiscordCatchup({
      botToken: 'test-token',
      webhookUrl: 'http://127.0.0.1:9999/webhook',
      monitoredChannelIds: () => new Set(['chan-1']),
      env,
      fetchImpl: transport.fetchImpl,
      sleep: async () => {},
      now: () => Date.now(), // fake-timer controlled
    });
    return { engine, transport };
  }

  const messagesCalls = (transport: ReturnType<typeof fakeTransport>) =>
    transport.restCalls.filter((u) => u.includes('/messages?after=')).length;

  it('debounces a READY burst into a single run and ignores GATEWAY_RESUMED', async () => {
    const { engine, transport } = timerEngine();
    engine.onGatewayEvent('GATEWAY_READY');
    engine.onGatewayEvent('GATEWAY_READY');
    engine.onGatewayEvent('GATEWAY_RESUMED');
    engine.onGatewayEvent('GATEWAY_READY');
    await vi.advanceTimersByTimeAsync(14999);
    expect(messagesCalls(transport)).toBe(0); // still inside the debounce window
    await vi.advanceTimersByTimeAsync(20000);
    expect(messagesCalls(transport)).toBe(1); // exactly one coalesced run
    engine.stop();
  });

  it('start() runs startup immediately and then periodically', async () => {
    const { engine, transport } = timerEngine({ DISCORD_CATCHUP_INTERVAL_MS: '60000' });
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(messagesCalls(transport)).toBe(1); // startup run
    await vi.advanceTimersByTimeAsync(60000);
    expect(messagesCalls(transport)).toBe(2); // first periodic run
    engine.stop();
    await vi.advanceTimersByTimeAsync(180000);
    expect(messagesCalls(transport)).toBe(2); // stop() disarms the timer
  });

  it('interval 0 disables the periodic timer but not the startup run', async () => {
    const { engine, transport } = timerEngine({ DISCORD_CATCHUP_INTERVAL_MS: '0' });
    engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(messagesCalls(transport)).toBe(1);
    await vi.advanceTimersByTimeAsync(3600000);
    expect(messagesCalls(transport)).toBe(1);
    engine.stop();
  });

  it('kill switch disables start() and onGatewayEvent()', async () => {
    const { engine, transport } = timerEngine({ DISCORD_CATCHUP_DISABLED: '1' });
    engine.start();
    engine.onGatewayEvent('GATEWAY_READY');
    await vi.advanceTimersByTimeAsync(600000);
    expect(transport.restCalls).toHaveLength(0);
    engine.stop();
  });

  it('single-flight: concurrent runOnce calls share one run', async () => {
    vi.useRealTimers();
    const { engine, transport } = timerEngine();
    const [a, b] = await Promise.all([engine.runOnce('periodic'), engine.runOnce('ready')]);
    expect(a).toBe(b); // coalesced into the same run/promise result
    expect(messagesCalls(transport)).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts`
Expected: FAIL — the stub `onGatewayEvent`/`start`/`stop` do nothing (debounce/periodic tests see 0 runs).

- [ ] **Step 3: Implement the triggers**

In `createDiscordCatchup`, add timer state after `let running…`:

```ts
  let readyDebounceTimer: NodeJS.Timeout | null = null;
  let periodicTimer: NodeJS.Timeout | null = null;
```

and replace the three stubs in the returned object with real functions defined above the `return`:

```ts
  function onGatewayEvent(type: string): void {
    if (config.disabled) return;
    // RESUMED is deliberately NOT a trigger: Discord replays missed events on
    // a session resume; only a fresh IDENTIFY (READY) leaves a gap.
    if (type !== 'GATEWAY_READY') return;
    if (readyDebounceTimer) clearTimeout(readyDebounceTimer);
    readyDebounceTimer = setTimeout(() => {
      readyDebounceTimer = null;
      void runOnce('ready');
    }, config.readyDebounceMs);
    readyDebounceTimer.unref?.();
  }

  function start(): void {
    if (config.disabled) {
      log.info('Discord catch-up disabled via DISCORD_CATCHUP_DISABLED');
      return;
    }
    void runOnce('startup');
    if (periodicTimer || config.intervalMs <= 0) return;
    periodicTimer = setInterval(() => {
      void runOnce('periodic');
    }, config.intervalMs);
    periodicTimer.unref?.();
  }

  function stop(): void {
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = null;
    if (readyDebounceTimer) clearTimeout(readyDebounceTimer);
    readyDebounceTimer = null;
  }

  return { runOnce, onGatewayEvent, start, stop };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/discord-catchup.test.ts`
Expected: PASS (all engine tests).

- [ ] **Step 5: Full-suite + commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
git add src/channels/discord-catchup.ts src/channels/discord-catchup.test.ts
git commit -m "feat(discord): add catch-up triggers with READY debounce and periodic timer"
```

---

### Task 9: Bridge hook — `onGatewayWebhookReady`

**Files:**
- Modify: `src/channels/chat-sdk-bridge.ts` (`ChatSdkBridgeConfig` at `:111-140`; `setup()` gateway block at `:537-577`)
- Modify: `src/channels/chat-sdk-bridge.test.ts`

**Interfaces:**
- Consumes: `startLocalWebhookServer` resolution at `chat-sdk-bridge.ts:541`.
- Produces: `ChatSdkBridgeConfig.onGatewayWebhookReady?: (webhookUrl: string) => void` — invoked exactly once per `setup()`, with the bound local webhook URL, after the webhook server starts and before the gateway listener starts. Hook errors are logged, never thrown (a bad hook must not break channel setup). Task 11 wires Discord's engine construction into it.

- [ ] **Step 1: Add the failing test**

Append to `src/channels/chat-sdk-bridge.test.ts` (reuse its existing imports for `createChatSdkBridge`; add `closeDb, initTestDb` from `../db/connection.js` and `runMigrations` from `../db/migrations/index.js` if not present; note this file historically avoided DB — the new test brings its own DB lifecycle):

```ts
describe('onGatewayWebhookReady hook', () => {
  it('is invoked once with the local webhook URL during setup', async () => {
    const db = initTestDb();
    runMigrations(db);
    const seen: string[] = [];
    const fakeAdapter = {
      name: 'discord',
      userName: 'yente-test',
      initialize: async () => {},
      channelIdFromThreadId: (threadId: string) => threadId,
      startGatewayListener: async () => new Response('ok'),
    } as unknown as Parameters<typeof createChatSdkBridge>[0]['adapter'];

    const bridge = createChatSdkBridge({
      adapter: fakeAdapter,
      supportsThreads: true,
      botToken: 'test-token',
      onGatewayWebhookReady: (webhookUrl) => seen.push(webhookUrl),
    });
    try {
      await bridge.setup({
        onInbound: async () => {},
        onInboundEvent: async () => {},
        onMetadata: async () => {},
        onAction: async () => {},
      } as never);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webhook$/);
    } finally {
      await bridge.teardown();
      closeDb();
    }
  });
});
```

Implementation note for this step: the fake adapter must satisfy whatever the Chat SDK's `Chat` touches during `chat.initialize()` — verified minimum is `name`, `userName`, `initialize(chat)`, `channelIdFromThreadId`, plus `startGatewayListener` so `setup()` takes the gateway branch (`chat-sdk-bridge.ts:537`) instead of binding the shared webhook server on port 3000. `initTestDb()+runMigrations` are required because `SqliteStateAdapter.connect()` uses `chat_sdk_kv` tables from migration 002. If `chat.initialize()` demands additional adapter members at runtime, add them to the fake as inert `async () => {}` / `() => {}` stubs — do NOT weaken the assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/channels/chat-sdk-bridge.test.ts`
Expected: FAIL — TS error (`onGatewayWebhookReady` not in `ChatSdkBridgeConfig`) or `seen` stays empty.

- [ ] **Step 3: Implement the hook**

In `ChatSdkBridgeConfig` (after `maxTextLength?: number;`), add:

```ts
  /**
   * Invoked once per setup() with the local gateway webhook URL, immediately
   * after the webhook server binds and before the gateway listener starts.
   * The Discord channel uses this to arm its catch-up engine, which POSTs
   * synthesized gateway events back to this URL (see discord-catchup.ts).
   * The 24h gateway listener restart reuses the same URL, so this fires
   * exactly once per setup().
   */
  onGatewayWebhookReady?: (webhookUrl: string) => void;
```

In `setup()`, directly after `const webhookUrl = await startLocalWebhookServer(gatewayAdapter, setupConfig, config.botToken);` (line ~541), add:

```ts
        if (config.onGatewayWebhookReady) {
          try {
            config.onGatewayWebhookReady(webhookUrl);
          } catch (err) {
            log.error('onGatewayWebhookReady hook failed', { adapter: adapter.name, err });
          }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/channels/chat-sdk-bridge.test.ts`
Expected: PASS (all pre-existing + 1 new).

- [ ] **Step 5: Full-suite + commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
git add src/channels/chat-sdk-bridge.ts src/channels/chat-sdk-bridge.test.ts
git commit -m "feat(bridge): add onGatewayWebhookReady hook for gateway channels"
```

---

### Task 10: Choke-point claim in `wrapYenteDiscordChannelIds` (fail-open)

**Files:**
- Modify: `src/channels/discord.ts:355-441` (wrapper) and `:363-366` (forwarder tap)
- Modify: `src/channels/discord.test.ts`

**Interfaces:**
- Consumes: Task 2/3 state functions; existing wrapper structure (Design Notes).
- Produces (exact — Tasks 11 and 12 use these):

```ts
export type YenteDiscordWrapOptions = {
  /** Recomputed per call; cursor advance is restricted to this set (and thread parents in it). */
  monitoredChannelIds?: () => Set<string>;
  /** Claim lease duration (DISCORD_CATCHUP_ROUTE_LEASE_MS). Default: DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS. */
  routeLeaseMs?: number;
  /** Tap invoked with every forwarded gateway event type (catch-up READY trigger). */
  onGatewayEvent?: (type: string) => void;
  /** Injectable clock (ISO string) for tests. Default: () => new Date().toISOString(). */
  now?: () => string;
};

export function wrapYenteDiscordChannelIds(
  adapter: DiscordAdapterInstance,
  botToken: string,
  autoCreateThreadChannelIds?: Set<string>,
  options?: YenteDiscordWrapOptions,
): DiscordAdapterInstance;
```

Behavioral contract:
1. The `handleForwardedMessage` interception is installed **unconditionally** (today it is gated on `autoCreateThreadChannelIds.size > 0` — remove the gate; auto-thread creation inside it stays gated by set membership).
2. Claim happens FIRST (before auto-thread creation). Not-claimed → `log.debug('discord_message_duplicate_dropped', { channelId, messageId, status })` and return WITHOUT forwarding (this exact message token is what host smoke greps for — keep it verbatim).
3. **Fail-open:** if the claim (or any state write) throws, `log.error(…)` and continue routing — a DB bug must never silence live messages.
4. After the original resolves: `markDiscordMessageRouted` + `advanceDiscordChannelCursor(channel_id, id, now())` when `channel_id` or the injected/native `thread.parent_id` is in the monitored set. After the original throws: `markDiscordMessageFailed` and rethrow.
5. The gateway forwarder replacement additionally calls `options.onGatewayEvent?.(event.type)` synchronously before forwarding.
6. Payloads without `channel_id`/`id` pass through untouched (defensive).

- [ ] **Step 1: Add the failing tests**

Append to `src/channels/discord.test.ts` (this file already has a `beforeEach` DB harness in its first describe; the new describe brings its own). Add imports: `wrapYenteDiscordChannelIds` from `./discord.js`; `getDiscordChannelCursor, getDiscordMessageRouteAttempts, isDiscordMessageTerminal` from `./discord-state.js`; `closeDb, getDb, initTestDb` from `../db/connection.js`; `runMigrations` from `../db/migrations/index.js`; `log` from `../log.js`.

```ts
describe('wrapYenteDiscordChannelIds ingress claim', () => {
  function fakeAdapter() {
    return {
      handleForwardedMessage: vi.fn(async () => 'handled'),
      createDiscordThread: vi.fn(async () => ({ id: 'thread-9' })),
      postMessage: vi.fn(async () => 'mid'),
      editMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
      removeReaction: vi.fn(async () => undefined),
      startTyping: vi.fn(async () => undefined),
      channelIdFromThreadId: (threadId: string) => threadId,
    };
  }

  function wrap(fake: ReturnType<typeof fakeAdapter>, autoThread: string[] = [], monitored: string[] = ['chan-1']) {
    return wrapYenteDiscordChannelIds(
      fake as unknown as Parameters<typeof wrapYenteDiscordChannelIds>[0],
      'test-token',
      new Set(autoThread),
      { monitoredChannelIds: () => new Set(monitored), routeLeaseMs: 120000 },
    ) as unknown as {
      handleForwardedMessage: (data: unknown, options: unknown) => Promise<unknown>;
      forwardGatewayEvent: (webhookUrl: string, event: { type: string }) => Promise<void>;
    };
  }

  const message = (id: string, channelId = 'chan-1'): Record<string, unknown> => ({
    id,
    channel_id: channelId,
    guild_id: 'guild-1',
    author: { id: 'user-1', bot: false },
    content: 'hello',
    mentions: [],
    attachments: [],
  });

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it('claims before forwarding and drops a duplicate of the same channel+message', async () => {
    const fake = fakeAdapter();
    const wrapped = wrap(fake);
    await wrapped.handleForwardedMessage(message('m1'), {});
    await wrapped.handleForwardedMessage(message('m1'), {});
    expect(fake.handleForwardedMessage).toHaveBeenCalledTimes(1);
    expect(isDiscordMessageTerminal('chan-1', 'm1')).toBe(true); // routed
  });

  it('advances the channel cursor for monitored channels after a successful route', async () => {
    const fake = fakeAdapter();
    const wrapped = wrap(fake);
    await wrapped.handleForwardedMessage(message('777'), {});
    expect(getDiscordChannelCursor('chan-1')).toBe('777');
  });

  it('does not advance a cursor for unmonitored channels (still claims)', async () => {
    const fake = fakeAdapter();
    const wrapped = wrap(fake, [], ['other-chan']);
    await wrapped.handleForwardedMessage(message('778'), {});
    expect(getDiscordChannelCursor('chan-1')).toBeNull();
    expect(isDiscordMessageTerminal('chan-1', '778')).toBe(true);
  });

  it('still creates auto-threads (after the claim) for auto-thread channels', async () => {
    const fake = fakeAdapter();
    const wrapped = wrap(fake, ['chan-1']);
    await wrapped.handleForwardedMessage(message('m2'), {});
    expect(fake.createDiscordThread).toHaveBeenCalledWith('chan-1', 'm2');
    const forwarded = fake.handleForwardedMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(forwarded.thread).toEqual({ id: 'thread-9', parent_id: 'chan-1' });
  });

  it('marks the route failed and rethrows when forwarding throws, leaving it reclaimable', async () => {
    const fake = fakeAdapter();
    fake.handleForwardedMessage.mockRejectedValueOnce(new Error('dispatch exploded'));
    const wrapped = wrap(fake);
    await expect(wrapped.handleForwardedMessage(message('m3'), {})).rejects.toThrow('dispatch exploded');
    expect(isDiscordMessageTerminal('chan-1', 'm3')).toBe(false); // failed but reclaimable
    expect(getDiscordMessageRouteAttempts('chan-1', 'm3')).toBe(1);
    // a retry (e.g. catch-up) re-claims and routes
    await wrapped.handleForwardedMessage(message('m3'), {});
    expect(isDiscordMessageTerminal('chan-1', 'm3')).toBe(true);
  });

  it('fails open: routes the message even when the claim state is unavailable', async () => {
    const errorSpy = vi.spyOn(log, 'error');
    const fake = fakeAdapter();
    const wrapped = wrap(fake);
    closeDb(); // simulate DB outage: getDb() now throws
    await wrapped.handleForwardedMessage(message('m4'), {});
    expect(fake.handleForwardedMessage).toHaveBeenCalledTimes(1); // routed anyway
    expect(errorSpy).toHaveBeenCalled();
    initTestDb(); // restore for afterEach symmetry
  });

  it('passes non-message payloads through untouched', async () => {
    const fake = fakeAdapter();
    const wrapped = wrap(fake);
    await wrapped.handleForwardedMessage({ some: 'interaction' }, {});
    expect(fake.handleForwardedMessage).toHaveBeenCalledWith({ some: 'interaction' }, {});
  });

  it('taps gateway event types before forwarding', () => {
    const fake = fakeAdapter();
    const seen: string[] = [];
    wrapYenteDiscordChannelIds(
      fake as unknown as Parameters<typeof wrapYenteDiscordChannelIds>[0],
      'test-token',
      new Set(),
      { onGatewayEvent: (type) => seen.push(type) },
    );
    const forward = (fake as unknown as { forwardGatewayEvent: (url: string, e: { type: string }) => Promise<void> })
      .forwardGatewayEvent;
    void forward('http://127.0.0.1:1/webhook', { type: 'GATEWAY_READY' });
    void forward('http://127.0.0.1:1/webhook', { type: 'GATEWAY_RESUMED' });
    expect(seen).toEqual(['GATEWAY_READY', 'GATEWAY_RESUMED']); // tap sees everything; filtering is the engine's job
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/channels/discord.test.ts`
Expected: FAIL — `wrapYenteDiscordChannelIds` is not exported (and once exported, the claim behavior doesn't exist yet).

- [ ] **Step 3: Implement the wrapper changes**

In `src/channels/discord.ts`:

(a) Add imports:

```ts
import {
  advanceDiscordChannelCursor,
  claimDiscordMessage,
  markDiscordMessageFailed,
  markDiscordMessageRouted,
} from './discord-state.js';
import { DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS } from './discord-catchup.js';
```

(b) Add the options type (above the wrapper):

```ts
export type YenteDiscordWrapOptions = {
  monitoredChannelIds?: () => Set<string>;
  routeLeaseMs?: number;
  onGatewayEvent?: (type: string) => void;
  now?: () => string;
};
```

(c) Change the wrapper signature (L355–359) to add `export` and the 4th parameter:

```ts
export function wrapYenteDiscordChannelIds(
  adapter: DiscordAdapterInstance,
  botToken: string,
  autoCreateThreadChannelIds: Set<string> = new Set(),
  options: YenteDiscordWrapOptions = {},
): DiscordAdapterInstance {
  const monitoredChannelIds = options.monitoredChannelIds ?? ((): Set<string> => new Set());
  const routeLeaseMs = options.routeLeaseMs ?? DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS;
  const nowIso = options.now ?? ((): string => new Date().toISOString());
```

(d) Extend the forwarder monkey-patch (L363–366) to tap events first:

```ts
  (
    adapter as unknown as { forwardGatewayEvent: (webhookUrl: string, event: { type: string }) => Promise<void> }
  ).forwardGatewayEvent = (webhookUrl: string, event: { type: string }) => {
    options.onGatewayEvent?.(event.type);
    return forwardDiscordGatewayEventWithRetry(webhookUrl, event, botToken).then(() => undefined);
  };
```

(e) Replace the gated interception block (`if (autoCreateThreadChannelIds.size > 0) { … }`, L405–438) with an UNCONDITIONAL interception. Keep the existing auto-thread code verbatim inside it:

```ts
  const rawAdapter = adapter as any;
  const originalHandleForwardedMessage = rawAdapter.handleForwardedMessage.bind(rawAdapter);
  rawAdapter.handleForwardedMessage = async (dataArg: unknown, optionsArg: unknown, ...rest: unknown[]) => {
    const data = dataArg as Record<string, any> | undefined;
    const opts = optionsArg;
    const channelId = data?.channel_id as string | undefined;
    const messageId = data?.id as string | undefined;

    if (!channelId || !messageId) {
      // Not a message-shaped payload — pass through untouched.
      return originalHandleForwardedMessage(dataArg, opts, ...rest);
    }

    // 1. Idempotency gate: claim before forwarding. Live and catch-up
    //    messages traverse this same choke point, so one claim covers both.
    //    FAIL-OPEN on DB errors: a state bug must never silence live messages.
    try {
      const claimedAt = nowIso();
      const leaseExpiresAt = new Date(Date.parse(claimedAt) + routeLeaseMs).toISOString();
      const claim = claimDiscordMessage(
        channelId,
        messageId,
        {
          guildId: (data?.guild_id as string | undefined) ?? null,
          authorId: (data?.author?.id as string | undefined) ?? null,
          source: 'gateway',
        },
        claimedAt,
        leaseExpiresAt,
      );
      if (!claim.claimed) {
        log.debug('discord_message_duplicate_dropped', { channelId, messageId, status: claim.status });
        return undefined;
      }
    } catch (error) {
      log.error('Discord message claim failed, routing anyway', { channelId, messageId, error: String(error) });
    }

    // 2. Auto-thread creation (existing behavior), after the claim.
    const alreadyInThread = data?.thread != null || data?.channel_type === 11 || data?.channel_type === 12;
    if (!alreadyInThread && autoCreateThreadChannelIds.has(channelId)) {
      try {
        const newThread = await rawAdapter.createDiscordThread(channelId, messageId);
        if (newThread?.id) {
          dataArg = {
            ...data,
            thread: { id: newThread.id, parent_id: channelId },
          };
          log.info('Created Discord thread for auto-thread channel', {
            channelId,
            messageId,
            threadId: newThread.id,
          });
        }
      } catch (error) {
        log.warn('Failed to create Discord thread for auto-thread channel', {
          channelId,
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 3. Forward, then record the outcome (fail-open on state errors).
    try {
      const result = await originalHandleForwardedMessage(dataArg, opts, ...rest);
      try {
        const routedAt = nowIso();
        markDiscordMessageRouted(channelId, messageId, routedAt);
        const monitored = monitoredChannelIds();
        const parentId = (dataArg as Record<string, any>)?.thread?.parent_id as string | undefined;
        if (monitored.has(channelId) || (parentId !== undefined && monitored.has(parentId))) {
          advanceDiscordChannelCursor(channelId, messageId, routedAt);
        }
      } catch (error) {
        log.error('Discord route bookkeeping failed', { channelId, messageId, error: String(error) });
      }
      return result;
    } catch (error) {
      try {
        markDiscordMessageFailed(
          channelId,
          messageId,
          nowIso(),
          error instanceof Error ? error.message : String(error),
        );
      } catch (stateError) {
        log.error('Discord route failure bookkeeping failed', { channelId, messageId, error: String(stateError) });
      }
      throw error;
    }
  };
```

Note: the existing `const options = optionsArg;` local from the old block is renamed to `opts` above to avoid shadowing the new `options` parameter. The forwarder tap keeps the vendored 2-arg `Promise<void>` contract via `.then(() => undefined)` now that the retry helper returns a boolean.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/discord.test.ts`
Expected: PASS (all pre-existing + 8 new).

- [ ] **Step 5: Full-suite + commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
git add src/channels/discord.ts src/channels/discord.test.ts
git commit -m "feat(discord): claim-before-forward idempotency gate at the ingress choke point"
```

---

### Task 11: Factory wiring — engine construction, env plumbing, monitored set

**Files:**
- Modify: `src/channels/discord.ts` (factory L32–72; add `monitoredDiscordChannelIds`)
- Modify: `src/channels/discord.test.ts`

**Interfaces:**
- Consumes: Task 8 engine (`createDiscordCatchup`, `discordCatchupConfigFromEnv`), Task 9 bridge hook, Task 10 wrapper options; private `getRegisteredDiscordChannelIds` (same module).
- Produces:

```ts
/** Registered Discord messaging-group channels ∪ auto-thread channels; recomputed per call. */
export function monitoredDiscordChannelIds(autoCreateThreadChannelIds: Set<string>): Set<string>;
```

- [ ] **Step 1: Add the failing test**

Append to `src/channels/discord.test.ts` (the file's existing first describe seeds `messaging_groups` fixtures — follow the same `createMessagingGroup` usage found there):

```ts
describe('monitoredDiscordChannelIds', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => closeDb());

  it('unions registered discord channels (normalized) with auto-thread channels, excluding quarantined', () => {
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'discord:guild-1:chan-a',
      name: 'a',
      is_group: 1,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: '2026-07-30T00:00:00.000Z',
    });
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'chan-b',
      name: 'b',
      is_group: 1,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: '2026-07-30T00:00:00.000Z',
    });
    createMessagingGroup({
      id: 'mg-3',
      channel_type: 'discord',
      platform_id: 'quarantined:chan-c',
      name: 'c',
      is_group: 1,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: '2026-07-30T00:00:00.000Z',
    });
    expect(monitoredDiscordChannelIds(new Set(['chan-d']))).toEqual(new Set(['chan-a', 'chan-b', 'chan-d']));
  });
});
```

Add `monitoredDiscordChannelIds` to the `./discord.js` import and `createMessagingGroup` to the `../db/messaging-groups.js` import (match the exact `MessagingGroup` field shape used by the file's existing fixtures — if the existing `createMessagingGroup` calls in this test file pass different fields, copy THEIR shape and only vary `platform_id`/`id`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/channels/discord.test.ts`
Expected: FAIL — `monitoredDiscordChannelIds` not exported.

- [ ] **Step 3: Implement**

(a) In `src/channels/discord.ts`, below `getRegisteredDiscordChannelIds`, add:

```ts
/**
 * Channels the catch-up engine monitors: registered Discord messaging groups
 * (normalized to parent channel snowflakes, quarantined excluded) plus the
 * auto-thread channels. Recomputed per call so newly registered channels
 * join without a restart.
 */
export function monitoredDiscordChannelIds(autoCreateThreadChannelIds: Set<string>): Set<string> {
  return new Set([...getRegisteredDiscordChannelIds(), ...autoCreateThreadChannelIds]);
}
```

(b) Extend the factory's `readEnvFile([...])` list (L34–39) with the seven catch-up keys:

```ts
    const env = readEnvFile([
      'DISCORD_BOT_TOKEN',
      'DISCORD_PUBLIC_KEY',
      'DISCORD_APPLICATION_ID',
      'DISCORD_AUTO_CREATE_THREAD_CHANNEL_IDS',
      'DISCORD_CATCHUP_DISABLED',
      'DISCORD_CATCHUP_INTERVAL_MS',
      'DISCORD_CATCHUP_READY_DEBOUNCE_MS',
      'DISCORD_CATCHUP_MAX_MESSAGES',
      'DISCORD_CATCHUP_MAX_AGE_MS',
      'DISCORD_CATCHUP_ROUTE_LEASE_MS',
      'DISCORD_CATCHUP_MAX_THREADS',
    ]);
```

(c) Rework the factory tail (current L62–70) to wire the engine. Add imports from `./discord-catchup.js`: `createDiscordCatchup`, `discordCatchupConfigFromEnv`, `type DiscordCatchup` (merging with the `DEFAULT_DISCORD_CATCHUP_ROUTE_LEASE_MS` import from Task 10):

```ts
    // Catch-up wiring. For env-file keys, process.env wins (house precedence);
    // note: spread order makes process.env values override file values, but
    // only for keys present in process.env — matching the `process.env.X || env.X`
    // pattern used above for the other Discord keys.
    const catchupEnv: NodeJS.ProcessEnv = { ...env, ...process.env };
    const catchupConfig = discordCatchupConfigFromEnv(catchupEnv);
    const channelIds = (): Set<string> => monitoredDiscordChannelIds(autoCreateThreadChannelIds);
    let catchup: DiscordCatchup | null = null;
    return createChatSdkBridge({
      adapter: wrapYenteDiscordChannelIds(discordAdapter, botToken, autoCreateThreadChannelIds, {
        monitoredChannelIds: channelIds,
        routeLeaseMs: catchupConfig.routeLeaseMs,
        onGatewayEvent: (type) => catchup?.onGatewayEvent(type),
      }),
      concurrency: 'concurrent',
      botToken,
      extractReplyContext,
      supportsThreads: true,
      maxTextLength: DISCORD_MESSAGE_TEXT_LIMIT,
      transformOutboundText: normalizeDiscordOutboundMarkdown,
      onGatewayWebhookReady: (webhookUrl) => {
        if (catchup) return; // one engine per factory run
        catchup = createDiscordCatchup({
          botToken,
          webhookUrl,
          monitoredChannelIds: channelIds,
          env: catchupEnv,
        });
        catchup.start(); // startup run + periodic timer (kill switch handled inside)
      },
    });
```

Caveat: `{ ...env, ...process.env }` lets an EMPTY-string `process.env` key override a set env-file key, which differs subtly from `process.env.X || env.X`. If the reviewer prefers exact parity, build it explicitly:

```ts
    const catchupEnv: NodeJS.ProcessEnv = { ...env };
    for (const key of Object.keys(process.env)) {
      if (process.env[key]) catchupEnv[key] = process.env[key];
    }
```

Either is acceptable; pick one and keep it.

Lifecycle note (spec §5 latitude, decided here): no teardown hook is added — the engine's timers are `unref()`d and `discord.ts` owns the handle; bridge `teardown()` only occurs at process shutdown in this runtime.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/channels/discord.test.ts`
Expected: PASS.

- [ ] **Step 5: Full-suite + typecheck (the factory edits are exercised by typecheck now and by Task 12's integration loop next) + commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm run lint
git add src/channels/discord.ts src/channels/discord.test.ts
git commit -m "feat(discord): wire catch-up engine into the discord channel factory"
```

If the `discord.ts ↔ discord-catchup.ts` import cycle breaks typecheck or module init here, apply the leaf-module extraction described at the end of Task 6 Step 3 in this commit.

---

### Task 12: Integration test — the incident story, end to end in-process

**Files:**
- Create: `src/channels/discord-catchup.integration.test.ts`

**Interfaces:**
- Consumes: everything above — `createDiscordCatchup` (Task 6/8), `wrapYenteDiscordChannelIds` + `YenteDiscordWrapOptions` (Task 10), state readers (Tasks 2/3), migration (Task 1).
- Produces: the repo-side proof of the user story (spec §7 incident scenario): *a human message posted in the auto-thread channel during a gateway gap gets a thread and gets routed exactly once — and a late live replay of the same event is dropped*. This is the in-repo analog of the host e2e smoke's no-duplicate assertion.

- [ ] **Step 1: Write the failing test**

Create `src/channels/discord-catchup.integration.test.ts`:

```ts
/**
 * End-to-end (in-process) proof of the catch-up story:
 * gateway gap -> catch-up fetches the missed message via REST -> POSTs a
 * synthesized GATEWAY_MESSAGE_CREATE to a real local webhook server (standing
 * in for the chat-sdk-bridge server, which dispatches event.data to
 * handleForwardedMessage exactly like the vendored adapter does) -> the
 * wrapped choke point claims, auto-creates the thread, and forwards ->
 * duplicates are dropped everywhere.
 */
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createDiscordCatchup } from './discord-catchup.js';
import { wrapYenteDiscordChannelIds } from './discord.js';
import { advanceDiscordChannelCursor, getDiscordChannelCursor } from './discord-state.js';

const CHANNEL = '1516341314621276171'; // the incident channel
const GUILD = 'guild-1';

function restMessage(id: string): Record<string, unknown> {
  return {
    id,
    type: 0,
    channel_id: CHANNEL,
    content: `missed ${id}`,
    author: { id: 'dan', bot: false },
    mentions: [],
    attachments: [],
    timestamp: '2026-07-30T00:00:00.000Z',
  };
}

describe('discord catch-up integration: gap message routed exactly once', () => {
  let server: http.Server;

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(async () => {
    closeDb();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('recovers a missed auto-thread-channel message with a thread, then drops the live duplicate', async () => {
    // --- the production ingress choke point, on a fake vendored adapter ---
    const inner = {
      handleForwardedMessage: vi.fn(async () => 'handled'),
      createDiscordThread: vi.fn(async () => ({ id: 'thread-new' })),
      postMessage: vi.fn(async () => 'mid'),
      editMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
      removeReaction: vi.fn(async () => undefined),
      startTyping: vi.fn(async () => undefined),
      channelIdFromThreadId: (threadId: string) => threadId,
    };
    const wrapped = wrapYenteDiscordChannelIds(
      inner as unknown as Parameters<typeof wrapYenteDiscordChannelIds>[0],
      'test-token',
      new Set([CHANNEL]),
      { monitoredChannelIds: () => new Set([CHANNEL]), routeLeaseMs: 120000 },
    ) as unknown as { handleForwardedMessage: (data: unknown, options: unknown) => Promise<unknown> };

    // --- a REAL local webhook server, dispatching like the bridge + vendored adapter ---
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const event = JSON.parse(Buffer.concat(chunks).toString()) as { type: string; data: Record<string, unknown> };
        void wrapped.handleForwardedMessage(event.data, {}).then(
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const webhookUrl = `http://127.0.0.1:${port}/webhook`;

    // --- fake Discord REST; real fetch for the loopback webhook ---
    const pages: Record<string, unknown[]> = { '600': [restMessage('601'), restMessage('602')], '602': [] };
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1')) return fetch(input as never, init);
      if (url.includes(`/channels/${CHANNEL}/messages`)) {
        const after = new URL(url).searchParams.get('after') ?? '';
        return new Response(JSON.stringify(pages[after] ?? []), { status: 200 });
      }
      if (url.includes(`/channels/${CHANNEL}`)) {
        return new Response(JSON.stringify({ id: CHANNEL, guild_id: GUILD, last_message_id: '602' }), { status: 200 });
      }
      if (url.includes('/threads/active')) return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    // The gap: cursor sits at 600; messages 601 and 602 arrived while disconnected.
    advanceDiscordChannelCursor(CHANNEL, '600', '2026-07-30T00:00:00.000Z');

    const engine = createDiscordCatchup({
      botToken: 'test-token',
      webhookUrl,
      monitoredChannelIds: () => new Set([CHANNEL]),
      env: {},
      fetchImpl,
      sleep: async () => {},
    });

    const summary = await engine.runOnce('ready');

    // Exactly-once routing with auto-thread creation, in order.
    expect(summary?.routed).toBe(2);
    expect(inner.handleForwardedMessage).toHaveBeenCalledTimes(2);
    expect(inner.createDiscordThread).toHaveBeenCalledTimes(2);
    const first = inner.handleForwardedMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(first.id).toBe('601');
    expect(first.guild_id).toBe(GUILD); // injected for thread-id derivation
    expect(first.thread).toEqual({ id: 'thread-new', parent_id: CHANNEL });
    expect(getDiscordChannelCursor(CHANNEL)).toBe('602');

    // Route rows are terminal and attributed to catch-up.
    const rows = getDb()
      .prepare(`SELECT message_id, status, source FROM discord_message_routes ORDER BY message_id`)
      .all() as Array<{ message_id: string; status: string; source: string }>;
    expect(rows).toEqual([
      { message_id: '601', status: 'routed', source: 'catchup' },
      { message_id: '602', status: 'routed', source: 'catchup' },
    ]);

    // NO-DUPLICATE: a late live gateway replay of 601 is dropped at the choke point.
    await wrapped.handleForwardedMessage(restMessage('601'), {});
    expect(inner.handleForwardedMessage).toHaveBeenCalledTimes(2); // unchanged
    expect(inner.createDiscordThread).toHaveBeenCalledTimes(2); // no second thread

    // Restart idempotency: a second run finds nothing new and routes nothing.
    const second = await engine.runOnce('periodic');
    expect(second?.routed).toBe(0);
    expect(inner.handleForwardedMessage).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify current state**

Run: `pnpm exec vitest run src/channels/discord-catchup.integration.test.ts`
Expected: PASS if Tasks 1–11 are correct. Any FAIL is a real integration bug (most likely candidates: URL matching order in the REST fake — the `/channels/{id}/messages` check must come BEFORE the `/channels/{id}` check, as written; or the engine advancing the cursor with a different `after` than `600`). Fix the production code or the fake's fidelity — never weaken the assertions.

- [ ] **Step 3: Full-suite + commit**

```bash
pnpm exec tsc --noEmit && pnpm exec vitest run
git add src/channels/discord-catchup.integration.test.ts
git commit -m "test(discord): end-to-end catch-up integration with no-duplicate assertion"
```

---

### Task 13: Final verification sweep

**Files:**
- Modify: only whatever the sweep flags.

- [ ] **Step 1: Run the CI mirror**

```bash
pnpm run format:check && pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm run lint
```

Expected: all green. If `format:check` flags files, run `pnpm run format:fix`; if lint flags `preserve-caught-error` (we rethrow originals — compliant) or `no-unused-vars`, fix the code.

- [ ] **Step 2: Confirm scope hygiene**

```bash
git status --short   # expect: clean
git log --oneline 7a74df5..HEAD
```

Expected: only the commits from Tasks 1–13 (plus the plan-doc commit); no changes outside `src/db/migrations/`, `src/channels/`, and `docs/plans/`. Confirm NO deploy scripts, host files, or wrapper-repo docs were touched (deploy-time work is out of scope).

- [ ] **Step 3: Commit any sweep fixes**

```bash
git add -A && git commit -m "chore(discord): format and lint sweep for catch-up feature"
```

(Skip the commit if the sweep changed nothing.)

---

## Deploy-time follow-ups (OUT OF SCOPE here — recorded so nothing is lost)

Performed later, at deploy time, per spec §8/§9 (explicitly excluded from this repo-side task by the user):
1. Host smoke: `run-agent-smoke.sh` baseline + `/srv/nanoclaw/run-e2e-smoke.sh` with the exactly-one-thread/reply REST assertion.
2. Maintenance-window live catch-up drill (stop service → post marker in `1516341314621276171` → start → verify `Discord catch-up routed missed message`, thread, reply, `routed` row; then idempotency re-check).
3. Wrapper-repo `Deployment.md` "Discord catch-up contract" bullet (env keys, tables, triggers, verification) + `changes.md` entry.
4. Flap-window passive validation on the next flapping day.
5. Migration 017 runs automatically on service start; rollback is a release-pointer flip (tables are additive) or `DISCORD_CATCHUP_DISABLED=1` + restart.
