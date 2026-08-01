# GWS-Correlation Durable Re-Acceptance Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Fix the GWS-correlation re-acceptance rejection class so a fresh container can re-bind message rows whose prior host acceptance interval has durably ENDED (crashed-container leftovers), and unmask the real error so the poll-loop's designed graceful handling is reachable — eliminating the "Codex app-server exited after transport shutdown" container fatals (63 crashes / 22 sessions on 2026-08-01; all 22 R2 terminal escalations; dvora's retired D&D series; hinda's still-recurring route).

**Architecture:** Four coordinated fixes. (1) Host: `bindAcceptedGwsCorrelation` treats rows whose acceptance interval has ENDED (`host_acceptance_ended_at IS NOT NULL`) as historical, not conflicting — permitting same-input re-bind and mixed-batch adoption while keeping first-acceptance columns immutable and keeping the fail-closed throw for LIVE conflicting intervals; companion: `processAuthenticatedGwsCorrelationRequest` derives `originalAcceptedAt` from the durable row for inputs the DB already knows. (2) Container: codex's `gen()` finally (and opencode's structurally identical finally) stop replacing the in-flight body error with the always-thrown `ProviderQuiescenceError` — the original error propagates type-preserved with the quiescence failure attached, so poll-loop routing works. (3) Host: `ok:false` bind rejections get a `log.warn` line. (4) Container: belt-and-braces — a quiescence error with `acceptanceObserved === false` persists the bounded pre-accept retry schedule before the fatal rethrow. Plus cleanup: stale `0.139.0` version comments → `0.144.1`.

**Tech Stack:** TypeScript (strict, NodeNext, ESM with `.js` relative imports). Host: Node 22 + pnpm + better-sqlite3 + vitest. Container agent-runner: Bun + bun:sqlite + bun:test (separate package tree, never mixes with vitest).

## Global Constraints

- **Do NOT deploy. Do NOT write to the live host.** Read-only ssh inspection is fine. All work stays in this worktree.
- **Fail-closed posture is sacred:** GWS correlation prevents duplicate side-effects (double Drive writes etc.). LIVE conflicting acceptance intervals and uncertain side-effect state must still throw. Only *provably historical* acceptance state (`host_acceptance_ended_at IS NOT NULL`) becomes re-acceptable.
- **Message durability and this week's R1/R2/R8/R9 remediation semantics must hold.** R2's bounded pre-accept retries should now SUCCEED on retry for this rejection class instead of terminally failing.
- **Do not change the container↔host wire protocol or the HMAC payload.** `canonicalGwsCorrelationAuthPayload` is byte-pinned in tests on BOTH sides (`src/gws-correlation-ipc.test.ts` ~390 and `container/agent-runner/src/gws-correlation.test.ts`). All fixes are host-internal or container-internal.
- All existing suites stay green. Baseline: ~1,119 host tests (`pnpm exec vitest run`), ~419 container tests (`cd container/agent-runner && bun test`).
- Host tests import from `vitest`; container tests import from `bun:test`. **Never cross** (vitest cannot load `bun:sqlite`).
- Relative imports MUST carry the `.js` extension (NodeNext). Prettier: `singleQuote`, `printWidth: 120`, enforced on `src/` only (CI gate `pnpm run format:check`); container files match by hand. ESLint rule `preserve-caught-error` is an **error**: rethrown/wrapped errors carry `{ cause: err }`.
- Container SQL named params need the `$` prefix in BOTH the SQL and the JS keys (`bun:sqlite`). Positional `?` params work normally.
- `pnpm install --frozen-lockfile` (host) and `bun install --frozen-lockfile` (container) — never bare installs.
- Keep commits focused and atomic. No new end-user markdown docs (this plan under `docs/plans/` is a working/agent doc).
- **All line numbers in this plan are approximate** (verified against deployed ref `bf853d6`) — re-verify before editing.

## Post-Deploy Disposition of Live Poisoned Rows (DOCUMENT ONLY — do not execute in this workflow)

The live poisoned rows (hinda's `sess-1781493473489`, and any others) **self-heal via the fix; no one-time data disposition is required.** Reasoning: every poisoned row carries `host_accepted_at` set and `host_acceptance_ended_at` set (stamped by lease revocation after the crashed container's confirmed stop, and re-asserted by the host startup barrier `expireAllStaleGwsCorrelations`, which closes ALL open intervals at host start). With this fix deployed, the next trigger on the route produces a mixed batch (stale ended-acceptance rows + new trigger message under the new input) which the host now adopts instead of rejecting — the route unblocks on the first post-deploy turn. Pre-deploy verification (read-only ssh): for each affected session inbound DB run `SELECT id, status, host_accepted_input_id, host_accepted_at, host_acceptance_ended_at FROM messages_in WHERE status = 'pending' AND host_accepted_at IS NOT NULL;` — every returned row must have `host_acceptance_ended_at IS NOT NULL`. If any pending row shows a NULL `host_acceptance_ended_at` with no running container for that session, restart the host first (the startup barrier closes it); no manual UPDATE is needed in either case.

## File Structure

| File | Responsibility in this change |
|---|---|
| `src/gws-correlation-ipc.ts` (modify) | Host acceptance boundary. Tasks 1–3: ended-interval re-acceptance in `bindAcceptedGwsCorrelation`, durable `originalAcceptedAt` derivation in `processAuthenticatedGwsCorrelationRequest`, warn-log on `ok:false`. |
| `src/gws-correlation-ipc.test.ts` (modify) | Host tests for all three host fixes, incl. the dvora/hinda regression at the authenticated-request level. |
| `container/agent-runner/src/providers/codex.ts` (modify) | Task 4: `gen()` finally stops masking the body error. |
| `container/agent-runner/src/providers/codex-error-masking.test.ts` (create) | Task 4: provider-level unmask test. |
| `container/agent-runner/src/integration.test.ts` (modify) | Task 4: poll-loop e2e — real CodexProvider bind failure reaches the graceful return-to-pending path. |
| `container/agent-runner/src/providers/codex-app-server.ts` (modify) | Task 4 cleanup: `0.139.0` comment drift → `0.144.1` (comments only). |
| `container/agent-runner/src/providers/opencode.ts` (modify) | Task 5: same finally-mask fix in the query generator's terminal finally. |
| `container/agent-runner/src/providers/opencode.test.ts` (modify) | Task 5: provider-level unmask test. |
| `container/agent-runner/src/poll-loop.ts` (modify) | Task 6: persist pre-accept retry schedule before fatal quiescence rethrow. |
| `container/agent-runner/src/poll-loop.test.ts` (modify) | Task 6: schedule-persisted test. |

Key facts the implementer must know (verified against `bf853d6`; re-verify):

- `messages_in` acceptance columns (`src/db/schema.ts:318–324`): `host_accepted_input_id`, `host_accepted_route_key`, `host_accepted_at` (the immutable FIRST acceptance triple), `host_acceptance_ended_at` (interval close; NULL = live), `host_acceptance_claim_token`, `host_acceptance_lease_id`, `host_acceptance_sequence` (the CURRENT interval's bookkeeping).
- `host_acceptance_ended_at` is written by exactly four sites, all in `src/gws-correlation-ipc.ts`: lease-scoped `expireAcceptedRows` (~235), the global startup barrier branch (~240–253), the prior-input close inside `bindAcceptedGwsCorrelation` (~601–605), and `releaseAcceptedGwsCorrelation` (~695–698). So every container life that ends (confirmed stop OR host restart) durably closes its intervals — "ended" is trustworthy proof the prior life is over.
- The deadlock being fixed: (a) container has no durable `originalAcceptedAt` and sends now() (`container/agent-runner/src/gws-correlation.ts` ~373/387); (b) host new-lease path requires `originalAcceptedAt === providerAcceptance.acceptedAt` (~863); (c) `bindAcceptedGwsCorrelation` throws when `row.host_accepted_at !== acceptedAt` (~626–636) even though the prior interval ENDED. Deterministic per message; the mixed-batch shape additionally trips the `host_accepted_input_id !== inputId` arm.
- The mask: `codex.ts` `gen()` finally (~606–624) awaits `terminateQueryServer()`, which ALWAYS rejects post-spawn (`terminateCodexAppServer` throws on every path, `codex-app-server.ts` ~350–415, common case 'transport shutdown' ~370–374); the `throw failQuiescence(err)` in the finally's catch replaces the real body error, so `poll-loop.ts` ~743 rethrows the sentinel and the graceful paths (~745–759, ~761–792) are unreachable. The same shape exists in `opencode.ts` at the query generator's terminal finally (~1441–1448): `teardownRuntime` → `destroy()` always throws `ProviderQuiescenceError` (~454).

---

### Task 1: Host — permit durable re-acceptance in `bindAcceptedGwsCorrelation`

**Files:**
- Modify: `src/gws-correlation-ipc.ts` (interface `AcceptedRow` ~141; function `bindAcceptedGwsCorrelation` ~585–681)
- Test: `src/gws-correlation-ipc.test.ts`

**Interfaces:**
- Consumes: existing exported `bindAcceptedGwsCorrelation(opts: BindAcceptedGwsCorrelationOptions): void`; `INBOUND_SCHEMA` from `src/db/schema.js`.
- Produces (relied on by Task 2): `bindAcceptedGwsCorrelation` now (a) accepts batches containing rows whose `host_acceptance_ended_at IS NOT NULL` regardless of `acceptedAt`/`inputId` mismatch, re-stamping ONLY `host_acceptance_claim_token`, `host_acceptance_lease_id`, `host_acceptance_sequence` and clearing `host_acceptance_ended_at` on those rows (first-acceptance triple untouched); (b) still throws `'accepted batch conflicts with immutable original acceptance'` for mismatched rows whose interval is LIVE (`host_acceptance_ended_at IS NULL`); (c) on pointer advance to a different input, closes EVERY open interval (`host_accepted_at IS NOT NULL AND host_acceptance_ended_at IS NULL`), not just rows first-accepted under the outgoing input. Signature unchanged.

- [ ] **Step 0: Install dependencies and capture the baseline**

```bash
cd /home/dan/code/nanoclaw-reboot-resilience/.worktrees/gws-reacceptance
pnpm install --frozen-lockfile
(cd container/agent-runner && bun install --frozen-lockfile)
pnpm exec vitest run src/gws-correlation-ipc.test.ts
```
Expected: all 15 existing tests PASS. (If the full suites haven't been run in this worktree yet, that's fine — Task 7 runs everything.)

- [ ] **Step 1: Write the failing tests**

Open `src/gws-correlation-ipc.test.ts`. Read the `describe('host-owned accepted GWS correlation')` block (~line 129) first: it provides the `beforeEach` that creates `root` (tmpdir), `dbPath` (inbound DB with `INBOUND_SCHEMA` applied), and `correlationPath`. Add a new sibling `describe` at the same level, reusing the identical `beforeEach`/`afterEach` scaffold shape (fresh tmpdir + `INBOUND_SCHEMA` + rm in `afterEach`). Ensure `bindAcceptedGwsCorrelation` and `Database` (better-sqlite3) are imported (they already are for the existing describe).

```ts
describe('durable re-acceptance after an ended interval', () => {
  let root: string;
  let dbPath: string;
  let correlationPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-reacceptance-'));
    dbPath = path.join(root, 'inbound.db');
    correlationPath = path.join(root, 'host-correlation', 'current.json');
    const db = new Database(dbPath);
    db.exec(INBOUND_SCHEMA);
    db.close();
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function insertRow(opts: {
    id: string;
    seq: number;
    hostInputId: string;
    routeKey: string;
    acceptedInputId?: string;
    acceptedAt?: string;
    endedAt?: string;
    leaseId?: string;
    claimToken?: string;
    sequence?: number;
  }): void {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, content, trigger, host_input_id, host_route_key, host_received_at,
          host_accepted_input_id, host_accepted_route_key, host_accepted_at, host_acceptance_ended_at,
          host_acceptance_claim_token, host_acceptance_lease_id, host_acceptance_sequence)
       VALUES (?, ?, 'chat', '2026-08-01T00:00:00.000Z', '{}', 1, ?, ?, '2026-08-01T00:00:00.000Z',
               ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.id,
      opts.seq,
      opts.hostInputId,
      opts.routeKey,
      opts.acceptedInputId ?? null,
      opts.acceptedInputId ? opts.routeKey : null,
      opts.acceptedAt ?? null,
      opts.endedAt ?? null,
      opts.claimToken ?? null,
      opts.leaseId ?? null,
      opts.sequence ?? null,
    );
    db.close();
  }

  function readRow(id: string): Record<string, unknown> {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as Record<string, unknown>;
    db.close();
    return row;
  }

  it('re-binds the same input with a fresh acceptedAt when the prior interval ended (crashed-container re-bind)', () => {
    insertRow({
      id: 'm-1',
      seq: 1,
      hostInputId: 'in-1',
      routeKey: 'route-1',
      acceptedInputId: 'in-1',
      acceptedAt: '2026-08-01T00:00:01.000Z',
      endedAt: '2026-08-01T00:00:05.000Z',
      claimToken: 'claim-old',
      leaseId: 'lease-old',
      sequence: 3,
    });

    bindAcceptedGwsCorrelation({
      dbPath,
      correlationPath,
      sessionId: 'sess-1',
      inputId: 'in-1',
      routeKey: 'route-1',
      messageIds: ['m-1'],
      acceptedAt: '2026-08-01T09:00:00.000Z', // fresh now() from a fresh container
      claimToken: 'claim-new',
      leaseId: 'lease-new',
      sequence: 1,
    });

    const row = readRow('m-1');
    expect(row.host_accepted_input_id).toBe('in-1');
    expect(row.host_accepted_at).toBe('2026-08-01T00:00:01.000Z'); // first acceptance immutable
    expect(row.host_acceptance_ended_at).toBeNull(); // interval reopened
    expect(row.host_acceptance_claim_token).toBe('claim-new');
    expect(row.host_acceptance_lease_id).toBe('lease-new');
    expect(row.host_acceptance_sequence).toBe(1);
    const pointer = JSON.parse(fs.readFileSync(correlationPath, 'utf8')) as { inputId: string };
    expect(pointer.inputId).toBe('in-1');
  });

  it('adopts previously-accepted-and-ended rows into a new input batch (mixed batch, hinda signature)', () => {
    insertRow({
      id: 'm-stale',
      seq: 1,
      hostInputId: 'in-old',
      routeKey: 'route-1',
      acceptedInputId: 'in-old',
      acceptedAt: '2026-08-01T00:00:01.000Z',
      endedAt: '2026-08-01T00:00:05.000Z',
      claimToken: 'claim-old',
      leaseId: 'lease-old',
      sequence: 2,
    });
    insertRow({ id: 'm-new', seq: 2, hostInputId: 'in-new', routeKey: 'route-1' });

    bindAcceptedGwsCorrelation({
      dbPath,
      correlationPath,
      sessionId: 'sess-1',
      inputId: 'in-new',
      routeKey: 'route-1',
      messageIds: ['m-stale', 'm-new'],
      acceptedAt: '2026-08-01T09:00:00.000Z',
      claimToken: 'claim-b',
      leaseId: 'lease-b',
      sequence: 1,
    });

    const stale = readRow('m-stale');
    expect(stale.host_accepted_input_id).toBe('in-old'); // immutable original
    expect(stale.host_accepted_at).toBe('2026-08-01T00:00:01.000Z');
    expect(stale.host_acceptance_ended_at).toBeNull(); // adopted into the new turn
    expect(stale.host_acceptance_claim_token).toBe('claim-b');
    expect(stale.host_acceptance_lease_id).toBe('lease-b');
    const fresh = readRow('m-new');
    expect(fresh.host_accepted_input_id).toBe('in-new');
    expect(fresh.host_accepted_at).toBe('2026-08-01T09:00:00.000Z');
    expect(fresh.host_acceptance_ended_at).toBeNull();
    const pointer = JSON.parse(fs.readFileSync(correlationPath, 'utf8')) as { inputId: string };
    expect(pointer.inputId).toBe('in-new');
  });

  it('still rejects a conflicting bind while the prior acceptance interval is LIVE', () => {
    insertRow({
      id: 'm-live',
      seq: 1,
      hostInputId: 'in-old',
      routeKey: 'route-1',
      acceptedInputId: 'in-old',
      acceptedAt: '2026-08-01T00:00:01.000Z',
      // endedAt omitted -> interval LIVE, and no pointer exists to advance from
      claimToken: 'claim-old',
      leaseId: 'lease-old',
      sequence: 2,
    });
    insertRow({ id: 'm-new', seq: 2, hostInputId: 'in-new', routeKey: 'route-1' });

    expect(() =>
      bindAcceptedGwsCorrelation({
        dbPath,
        correlationPath,
        sessionId: 'sess-1',
        inputId: 'in-new',
        routeKey: 'route-1',
        messageIds: ['m-live', 'm-new'],
        acceptedAt: '2026-08-01T09:00:00.000Z',
        claimToken: 'claim-b',
        leaseId: 'lease-b',
        sequence: 1,
      }),
    ).toThrow('accepted batch conflicts with immutable original acceptance');
    const live = readRow('m-live');
    expect(live.host_acceptance_claim_token).toBe('claim-old'); // untouched (transaction rolled back)
    expect(live.host_acceptance_ended_at).toBeNull();
  });

  it('advancing the pointer closes every open interval, enabling within-life mixed-batch adoption', () => {
    insertRow({ id: 'm-a', seq: 1, hostInputId: 'in-a', routeKey: 'route-1' });
    bindAcceptedGwsCorrelation({
      dbPath,
      correlationPath,
      sessionId: 'sess-1',
      inputId: 'in-a',
      routeKey: 'route-1',
      messageIds: ['m-a'],
      acceptedAt: '2026-08-01T09:00:00.000Z',
      claimToken: 'claim-a',
      leaseId: 'lease-x',
      sequence: 1,
    });
    // m-a's interval is now LIVE and the pointer names in-a. A new trigger
    // arrives and the (still-pending) m-a is included in the new batch.
    insertRow({ id: 'm-b', seq: 2, hostInputId: 'in-b', routeKey: 'route-1' });
    bindAcceptedGwsCorrelation({
      dbPath,
      correlationPath,
      sessionId: 'sess-1',
      inputId: 'in-b',
      routeKey: 'route-1',
      messageIds: ['m-a', 'm-b'],
      acceptedAt: '2026-08-01T09:05:00.000Z',
      claimToken: 'claim-b2',
      leaseId: 'lease-x',
      sequence: 2,
    });
    const a = readRow('m-a');
    expect(a.host_accepted_input_id).toBe('in-a'); // immutable
    expect(a.host_acceptance_ended_at).toBeNull(); // closed on advance, then reopened by adoption
    expect(a.host_acceptance_claim_token).toBe('claim-b2');
  });

  it('never stamps or reopens rows outside the exact batch', () => {
    insertRow({
      id: 'm-outside',
      seq: 1,
      hostInputId: 'in-out',
      routeKey: 'route-1',
      acceptedInputId: 'in-out',
      acceptedAt: '2026-08-01T00:00:01.000Z',
      endedAt: '2026-08-01T00:00:05.000Z',
      claimToken: 'claim-old',
      leaseId: 'lease-old',
      sequence: 2,
    });
    insertRow({ id: 'm-in', seq: 2, hostInputId: 'in-x', routeKey: 'route-1' });
    bindAcceptedGwsCorrelation({
      dbPath,
      correlationPath,
      sessionId: 'sess-1',
      inputId: 'in-x',
      routeKey: 'route-1',
      messageIds: ['m-in'],
      acceptedAt: '2026-08-01T09:00:00.000Z',
      claimToken: 'claim-x',
      leaseId: 'lease-x',
      sequence: 1,
    });
    const outside = readRow('m-outside');
    expect(outside.host_acceptance_ended_at).toBe('2026-08-01T00:00:05.000Z'); // stays closed
    expect(outside.host_acceptance_claim_token).toBe('claim-old');
  });
});
```

Note on the live-conflict test: the fail-closed semantics are *pointer-relative*. When the on-disk pointer names the outgoing input, closing its interval on advance is the designed turn hand-off (tested by the within-life test). A live interval with NO pointer backing it is exactly the uncertain/concurrent state that must keep failing closed.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'durable re-acceptance'
```
Expected: the first, second, and fourth tests FAIL with `accepted batch conflicts with immutable original acceptance` (thrown where success is expected); the live-conflict and outside-batch tests may pass already.

- [ ] **Step 3: Implement the changes in `src/gws-correlation-ipc.ts`**

3a. Extend `AcceptedRow` (~line 141) with the interval column:

```ts
interface AcceptedRow {
  id: string;
  seq: number | null;
  status: string;
  trigger: number;
  host_input_id: string | null;
  host_route_key: string | null;
  host_accepted_input_id: string | null;
  host_accepted_route_key: string | null;
  host_accepted_at: string | null;
  host_acceptance_ended_at: string | null;
}
```

3b. Extend the lookup SELECT inside `bindAcceptedGwsCorrelation` (~608–612) to match:

```ts
      const lookup = db.prepare(
        `SELECT id, seq, status, trigger, host_input_id, host_route_key,
                host_accepted_input_id, host_accepted_route_key, host_accepted_at,
                host_acceptance_ended_at
           FROM messages_in WHERE id = ?`,
      );
```

3c. Broaden the prior-input close (~598–605). Replace:

```ts
      const currentInput = priorCurrent?.inputId;
      if (typeof currentInput === 'string' && currentInput !== inputId) {
        db.prepare(
          `UPDATE messages_in
             SET host_acceptance_ended_at = ?
           WHERE host_accepted_input_id = ? AND host_acceptance_ended_at IS NULL`,
        ).run(acceptedAt, currentInput);
      }
```

with:

```ts
      const currentInput = priorCurrent?.inputId;
      if (typeof currentInput === 'string' && currentInput !== inputId) {
        // The pointer names the outgoing turn; the pointer is singular, so every
        // open interval belongs to that turn (rows first-accepted under it OR
        // rows adopted into it, which keep their immutable original
        // host_accepted_input_id). Close them all — an input-keyed close would
        // leave adopted rows' reopened intervals dangling.
        db.prepare(
          `UPDATE messages_in
             SET host_acceptance_ended_at = ?
           WHERE host_accepted_at IS NOT NULL AND host_acceptance_ended_at IS NULL`,
        ).run(acceptedAt);
      }
```

(The `host_accepted_at IS NOT NULL` guard preserves the invariant that never-accepted rows never carry `host_acceptance_ended_at` — see the existing test `does not mark never-accepted rows as ended when a launch lease is revoked`. This runs inside the same transaction as the checks below, so a validation throw rolls it back.)

3d. Relax the conflict check (~626–636) to live intervals only. Replace:

```ts
      if (
        exactRows.some(
          (row) =>
            row.host_accepted_input_id !== null &&
            (row.host_accepted_input_id !== inputId ||
              row.host_accepted_route_key !== routeKey ||
              row.host_accepted_at !== acceptedAt),
        )
      ) {
        throw new Error('accepted batch conflicts with immutable original acceptance');
      }
```

with:

```ts
      if (
        exactRows.some(
          (row) =>
            row.host_accepted_input_id !== null &&
            row.host_acceptance_ended_at === null &&
            (row.host_accepted_input_id !== inputId ||
              row.host_accepted_route_key !== routeKey ||
              row.host_accepted_at !== acceptedAt),
        )
      ) {
        // A mismatched LIVE interval is a genuinely concurrent acceptance and
        // must fail closed. A row whose interval has ENDED is historical: the
        // prior container life is provably over, so re-bind/adoption is safe.
        throw new Error('accepted batch conflicts with immutable original acceptance');
      }
```

3e. Add the reopen path next to the stamping UPDATE (~646–666). Replace the existing `const update = ...; for (const row of exactRows) { if (row.host_accepted_at === null) { update.run(...) } }` block with:

```ts
      const update = db.prepare(
        `UPDATE messages_in
            SET host_accepted_input_id = ?, host_accepted_route_key = ?,
                host_accepted_at = ?, host_acceptance_ended_at = NULL,
                host_acceptance_claim_token = ?, host_acceptance_lease_id = ?,
                host_acceptance_sequence = ?
          WHERE id = ? AND host_accepted_at IS NULL`,
      );
      const reopen = db.prepare(
        `UPDATE messages_in
            SET host_acceptance_ended_at = NULL,
                host_acceptance_claim_token = ?, host_acceptance_lease_id = ?,
                host_acceptance_sequence = ?
          WHERE id = ? AND host_accepted_at IS NOT NULL AND host_acceptance_ended_at IS NOT NULL`,
      );
      for (const row of exactRows) {
        if (row.host_accepted_at === null) {
          update.run(
            inputId,
            routeKey,
            acceptedAt,
            opts.claimToken ?? null,
            opts.leaseId ?? null,
            opts.sequence ?? null,
            row.id,
          );
        } else {
          // First-acceptance columns are immutable. Track the CURRENT interval
          // by re-stamping claim/lease/sequence and clearing ended_at. Rows the
          // in-transaction pointer-advance close just ended read as ended here
          // because the lookup ran after that close; rows with a live matching
          // interval (same-lease followup) are already current — the WHERE
          // clause makes the reopen a no-op for them.
          reopen.run(opts.claimToken ?? null, opts.leaseId ?? null, opts.sequence ?? null, row.id);
        }
      }
```

**Wait** — the lookup (3b) runs AFTER the close (3c) in the same transaction, so the `AcceptedRow` values used by the conflict check reflect post-close state, which is what makes within-life adoption work. The `reopen` WHERE clause re-checks the DB state, so JS-side staleness cannot mis-fire. Do not "optimize" the WHERE clause away.

- [ ] **Step 4: Run the new tests and the full host GWS test file**

```bash
pnpm exec vitest run src/gws-correlation-ipc.test.ts
```
Expected: ALL tests PASS (the 15 pre-existing + 5 new). If `atomically advances from the exact first accepted input...` (~145) or the lifecycle-barrier tests fail, the close-broadening (3c) or reopen guard (3e) is wrong — fix before proceeding.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit
git add src/gws-correlation-ipc.ts src/gws-correlation-ipc.test.ts
git commit -m "fix(gws): permit durable re-acceptance of rows whose acceptance interval has ended"
```

---

### Task 2: Host — derive `originalAcceptedAt` from the durable row + authenticated-level regression

**Files:**
- Modify: `src/gws-correlation-ipc.ts` (interface `AcceptedLeaseInput` ~98; function `processAuthenticatedGwsCorrelationRequest` ~814–890)
- Test: `src/gws-correlation-ipc.test.ts` (inside the existing `describe('authenticated GWS correlation acceptance lease')` ~232, which provides the `request()`/`process()` signed-request factories, seeded rows `m-active`/`m-future`, outbound DB with `processing_ack` claim `claim-active`, and lease `lease-host-issued-1`)

**Interfaces:**
- Consumes: Task 1's `bindAcceptedGwsCorrelation` behavior; `openInboundDb(dbPath)` from `./db/session-db.js` (already imported at ~line 8).
- Produces: `processAuthenticatedGwsCorrelationRequest` behavior change — for a bind whose `inputId` is unknown to the in-memory lease map but already durably accepted in the inbound DB, the host derives the effective `originalAcceptedAt` from the row's `host_accepted_at` (skipping the `originalAcceptedAt === providerAcceptance.acceptedAt` requirement) and passes THAT to `bindAcceptedGwsCorrelation` as `acceptedAt`. New private module function `readDurableOriginalAcceptance(dbPath: string, inputId: string): string | undefined`. `AcceptedLeaseInput` gains required field `durableAcceptedAt: string` (the value used for DB stamping; equals `originalAcceptedAt` unless derived). Wire protocol and request validation are UNCHANGED.

- [ ] **Step 1: Write the failing tests**

Add inside `describe('authenticated GWS correlation acceptance lease')`, after the existing `it`s. The describe's `beforeEach` seeds: inbound rows `m-active` (seq 1, `host_input_id 'in-active'`, route `routeKey`, received `issuedAt`) and `m-future` (seq 2, `'in-future'`), outbound `processing_ack` for `m-active` under `claim-active`, and a registered lease `control` (`leaseId 'lease-host-issued-1'`). The factories: `request(overrides)` builds a signed bind (defaults: `inputId 'in-active'`, `claimToken 'claim-active'`, `sequence 1`, `originalAcceptedAt === providerAcceptance.acceptedAt === acceptedAt`), and `process(req)` runs `processAuthenticatedGwsCorrelationRequest` with `now: '2026-05-29T00:00:01.100Z'`. Re-read the factory bodies (~285–317) before writing to confirm local variable names (`dbPath`, `outDbPath`, `groupId`, `sessionId`, `routeKey`, `acceptedAt`).

```ts
    it('re-binds an input whose durable acceptance ended in a prior life, deriving the original acceptance time', () => {
      const priorAcceptedAt = '2026-05-28T23:00:00.000Z';
      const db = new Database(dbPath);
      db.prepare(
        `UPDATE messages_in
            SET host_accepted_input_id = 'in-active', host_accepted_route_key = ?,
                host_accepted_at = ?, host_acceptance_ended_at = '2026-05-28T23:30:00.000Z',
                host_acceptance_claim_token = 'claim-prior', host_acceptance_lease_id = 'lease-prior',
                host_acceptance_sequence = 9
          WHERE id = 'm-active'`,
      ).run(routeKey, priorAcceptedAt);
      db.close();

      // A fresh container has no durable source: it sends originalAcceptedAt = providerAcceptance.acceptedAt = now.
      process(request());

      const check = new Database(dbPath, { readonly: true });
      const row = check.prepare('SELECT * FROM messages_in WHERE id = ?').get('m-active') as Record<string, unknown>;
      check.close();
      expect(row.host_accepted_at).toBe(priorAcceptedAt); // immutable first acceptance
      expect(row.host_acceptance_ended_at).toBeNull(); // reopened
      expect(row.host_acceptance_lease_id).toBe('lease-host-issued-1');
      expect(row.host_acceptance_claim_token).toBe('claim-active');
      // The published pointer carries the DERIVED original acceptance, not now().
      const pointer = JSON.parse(fs.readFileSync(correlationPath, 'utf8')) as { acceptedAt: string; inputId: string };
      expect(pointer.acceptedAt).toBe(priorAcceptedAt);
      expect(pointer.inputId).toBe('in-active');

      // A followup bind in the same lease must stay consistent (durable value memoized).
      process(request({ requestId: '22222222-2222-4222-8222-222222222222', sequence: 2 }));
      const check2 = new Database(dbPath, { readonly: true });
      const row2 = check2.prepare('SELECT host_accepted_at FROM messages_in WHERE id = ?').get('m-active') as {
        host_accepted_at: string;
      };
      check2.close();
      expect(row2.host_accepted_at).toBe(priorAcceptedAt);
    });

    it('adopts a mixed batch of stale ended-acceptance rows plus a new trigger under the new input (dvora/hinda regression)', () => {
      const db = new Database(dbPath);
      // m-active becomes the stale leftover: accepted under a DIFFERENT prior input, interval ended.
      db.prepare(
        `UPDATE messages_in
            SET host_accepted_input_id = 'in-prior', host_accepted_route_key = ?,
                host_accepted_at = '2026-05-28T23:00:00.000Z', host_acceptance_ended_at = '2026-05-28T23:30:00.000Z',
                host_acceptance_lease_id = 'lease-prior'
          WHERE id = 'm-active'`,
      ).run(routeKey);
      // A new user message arrives as the new trigger.
      db.prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, content, trigger, host_input_id, host_route_key, host_received_at)
         VALUES ('m-trigger', 3, 'chat', ?, '{}', 1, 'in-trigger', ?, ?)`,
      ).run('2026-05-29T00:00:00.900Z', routeKey, '2026-05-29T00:00:00.900Z');
      db.close();
      const outDb = new Database(outDbPath);
      outDb
        .prepare(
          "INSERT INTO processing_ack (message_id, status, status_changed, claim_token) VALUES (?, 'processing', ?, ?)",
        )
        .run('m-trigger', '2026-05-29T00:00:00.950Z', 'claim-mixed');
      outDb.prepare("UPDATE processing_ack SET claim_token = 'claim-mixed' WHERE message_id = 'm-active'").run();
      outDb.close();

      process(
        request({
          inputId: 'in-trigger',
          claimToken: 'claim-mixed',
          messageIds: ['m-active', 'm-trigger'],
        }),
      );

      const check = new Database(dbPath, { readonly: true });
      const stale = check.prepare('SELECT * FROM messages_in WHERE id = ?').get('m-active') as Record<string, unknown>;
      const fresh = check.prepare('SELECT * FROM messages_in WHERE id = ?').get('m-trigger') as Record<string, unknown>;
      check.close();
      expect(stale.host_accepted_input_id).toBe('in-prior'); // immutable original
      expect(stale.host_acceptance_ended_at).toBeNull(); // adopted
      expect(stale.host_acceptance_lease_id).toBe('lease-host-issued-1');
      expect(stale.host_acceptance_claim_token).toBe('claim-mixed');
      expect(fresh.host_accepted_input_id).toBe('in-trigger');
      expect(fresh.host_accepted_at).toBe(acceptedAt); // new input: original == provider acceptance time
      const pointer = JSON.parse(fs.readFileSync(correlationPath, 'utf8')) as { inputId: string };
      expect(pointer.inputId).toBe('in-trigger');
    });

    it('still requires a truly new input to preserve its provider acceptance time', () => {
      expect(() => process(request({ originalAcceptedAt: '2026-05-29T00:00:00.500Z' }))).toThrow(
        'new GWS correlation bind must preserve its original provider acceptance time',
      );
    });
```

Notes: (a) `exactProcessingClaim` requires every messageId of the batch to hold a `processing` claim under the request's `claimToken` — that is why the mixed-batch test re-tokens `m-active` and inserts one for `m-trigger`. (b) The mixed-batch adoption itself lands via Task 1; what THIS task must newly make pass is the first test (derivation visible in the pointer + followup consistency) and keep the third test's throw intact for unknown inputs.

- [ ] **Step 2: Run the tests to verify the state**

```bash
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'deriving the original acceptance time'
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'dvora/hinda regression'
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'truly new input'
```
Expected: test 1 FAILS on `expect(pointer.acceptedAt).toBe(priorAcceptedAt)` (pointer carries now() without derivation); tests 2 and 3 may already pass (record which).

- [ ] **Step 3: Implement in `src/gws-correlation-ipc.ts`**

3a. Extend `AcceptedLeaseInput` (~98):

```ts
interface AcceptedLeaseInput {
  originalAcceptedAt: string;
  /** The durable acceptance time used for DB stamping; may predate this lease when derived from a prior life's row. */
  durableAcceptedAt: string;
  routeKey: string;
  messageIds: string[];
  lastClaimToken: string;
  lastProviderAcceptance: ProviderAcceptanceProof;
}
```

3b. Add a private helper near the other DB helpers:

```ts
/** Durable original acceptance for an input the DB already knows, if any. */
function readDurableOriginalAcceptance(dbPath: string, inputId: string): string | undefined {
  const db = openInboundDb(dbPath);
  try {
    const row = db
      .prepare(
        `SELECT MIN(host_accepted_at) AS accepted_at FROM messages_in
          WHERE host_accepted_input_id = ? AND host_accepted_at IS NOT NULL`,
      )
      .get(inputId) as { accepted_at: string | null } | undefined;
    return row?.accepted_at ?? undefined;
  } finally {
    db.close();
  }
}
```

3c. In `processAuthenticatedGwsCorrelationRequest`, replace the bind branch head (~857–865) and thread the effective value through. Replace:

```ts
  const existing = state.acceptedInputs.get(request.inputId);
  if (request.action === 'bind') {
    if (existing) {
      if (existing.originalAcceptedAt !== request.originalAcceptedAt || existing.routeKey !== request.routeKey) {
        throw new Error('GWS correlation bind conflicts with immutable original acceptance');
      }
    } else if (request.originalAcceptedAt !== request.providerAcceptance.acceptedAt) {
      throw new Error('new GWS correlation bind must preserve its original provider acceptance time');
    }
```

with:

```ts
  const existing = state.acceptedInputs.get(request.inputId);
  if (request.action === 'bind') {
    let effectiveOriginalAcceptedAt = request.originalAcceptedAt;
    if (existing) {
      if (existing.originalAcceptedAt !== request.originalAcceptedAt || existing.routeKey !== request.routeKey) {
        throw new Error('GWS correlation bind conflicts with immutable original acceptance');
      }
      effectiveOriginalAcceptedAt = existing.durableAcceptedAt;
    } else {
      const durable = readDurableOriginalAcceptance(opts.dbPath, request.inputId);
      if (durable !== undefined) {
        // The DB already knows this input: its first acceptance is immutable
        // and durable. A fresh container has no durable source and can only
        // send now(); adopt the durable original instead of requiring the
        // request to carry it.
        effectiveOriginalAcceptedAt = durable;
      } else if (request.originalAcceptedAt !== request.providerAcceptance.acceptedAt) {
        throw new Error('new GWS correlation bind must preserve its original provider acceptance time');
      }
    }
```

Then in the `bindAcceptedGwsCorrelation({...})` call (~867–879), change `acceptedAt: request.originalAcceptedAt` to `acceptedAt: effectiveOriginalAcceptedAt`, and in the `state.acceptedInputs.set(request.inputId, {...})` (~880–886) add `durableAcceptedAt: effectiveOriginalAcceptedAt,` alongside the existing `originalAcceptedAt: request.originalAcceptedAt` (the map keeps storing what the container will resend, so the in-lease replay check at ~860 stays correct, while DB stamping stays on the durable time).

The `tsc` run will flag any other constructor of `AcceptedLeaseInput` missing `durableAcceptedAt` (the container-side map in `container/agent-runner/src/gws-correlation.ts` is a DIFFERENT type — do not touch it).

- [ ] **Step 4: Run the host GWS test file**

```bash
pnpm exec vitest run src/gws-correlation-ipc.test.ts
pnpm exec tsc --noEmit
```
Expected: ALL tests PASS. Pay attention to `accepts one legitimate queued batch exactly once and never rewrites original accepted_at on replay` (~388) — it must stay green.

- [ ] **Step 5: Commit**

```bash
git add src/gws-correlation-ipc.ts src/gws-correlation-ipc.test.ts
git commit -m "fix(gws): derive originalAcceptedAt from the durable row for inputs the DB already knows"
```

---

### Task 3: Host — log bind rejections on the host side

**Files:**
- Modify: `src/gws-correlation-ipc.ts` (the `catch` inside `startLeaseSocket`'s data handler, ~373–380)
- Test: `src/gws-correlation-ipc.test.ts`

**Interfaces:**
- Consumes: `log` from `./log.js` (already imported at line ~10; each level has signature `(msg: string, data?: Record<string, unknown>) => void`). Module-level socket test helpers in the test file: `socketFrame(value)`, `connectSocket(socketPath)`, `authenticateSocket(control)`, `readSocketFrame(socket)` (~lines 39–127).
- Produces: every `ok:false` response is preceded by `log.warn('GWS correlation request rejected', {...})` with keys `agentGroupId`, `sessionId`, `action`, `inputId`, `requestId`, `error`.

- [ ] **Step 1: Write the failing test**

Add inside `describe('bounded GWS correlation socket transport')` (~435). Read that describe's `beforeEach` first to reuse its session/lease scaffold if one exists; if the existing tests do per-test setup (as `accepts a legitimate authenticated bind over the persistent socket without an inbox file` at ~502 does), do the same minimal setup here. The test needs only: a registered lease whose socket is up, an authenticated socket, and one rejected frame — the rejection may be any validation failure, so no signed bind is required. Add `import { log } from './log.js';` and `vi` to the vitest import if not present.

```ts
    it('logs a host-side warning when a correlation request is rejected', async () => {
      const warnSpy = vi.spyOn(log, 'warn');
      const control = registerGwsCorrelationLaunchLease({
        agentGroupId: 'group-warnlog',
        sessionId: 'sess-warnlog',
        providerName: 'opencode',
        issuedAt: '2026-08-01T00:00:00.000Z',
        secret: Buffer.alloc(32, 9),
        leaseId: 'lease-warnlog-1',
      });
      try {
        const socket = await authenticateSocket(control);
        socket.write(
          socketFrame({
            schemaVersion: 2,
            action: 'bind',
            requestId: 'req-warnlog-1',
            inputId: 'in-warnlog',
            sessionId: 'sess-warnlog',
          }),
        );
        const response = (await readSocketFrame(socket)) as { ok: boolean; error?: string };
        socket.destroy();
        expect(response.ok).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(
          'GWS correlation request rejected',
          expect.objectContaining({
            agentGroupId: 'group-warnlog',
            sessionId: 'sess-warnlog',
            inputId: 'in-warnlog',
            requestId: 'req-warnlog-1',
            error: expect.any(String),
          }),
        );
      } finally {
        control.revokeAfterConfirmedStop();
        warnSpy.mockRestore();
      }
    });
```

If `registerGwsCorrelationLaunchLease` or request processing requires the agent group / session to exist in the central DB before rejection, mirror the central-DB scaffold used by the ~502 test (`initTestDb()` + `runMigrations` + `createAgentGroup` + `createSession` + session dir with `INBOUND_SCHEMA`/`OUTBOUND_SCHEMA` DBs) — the rejection error text will differ, but the warn assertion above does not depend on which validation failed.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'logs a host-side warning'
```
Expected: FAIL — `warnSpy` not called (response is still `ok:false`).

- [ ] **Step 3: Implement**

In the data handler's catch (~373–380), replace:

```ts
          } catch (err) {
            send({
              schemaVersion: 1,
              ok: false,
              requestId: value?.requestId,
              error: (err instanceof Error ? err.message : String(err)).slice(0, 512),
            });
          }
```

with:

```ts
          } catch (err) {
            const frame = value as { requestId?: unknown; inputId?: unknown; action?: unknown } | undefined;
            log.warn('GWS correlation request rejected', {
              agentGroupId: control.agentGroupId,
              sessionId: control.sessionId,
              action: typeof frame?.action === 'string' ? frame.action : undefined,
              inputId: typeof frame?.inputId === 'string' ? frame.inputId : undefined,
              requestId: typeof frame?.requestId === 'string' ? frame.requestId : undefined,
              error: err instanceof Error ? err.message : String(err),
            });
            send({
              schemaVersion: 1,
              ok: false,
              requestId: value?.requestId,
              error: (err instanceof Error ? err.message : String(err)).slice(0, 512),
            });
          }
```

- [ ] **Step 4: Run tests**

```bash
pnpm exec vitest run src/gws-correlation-ipc.test.ts
pnpm exec tsc --noEmit
```
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gws-correlation-ipc.ts src/gws-correlation-ipc.test.ts
git commit -m "fix(gws): log host-side warning when a correlation bind/release request is rejected"
```

---

### Task 4: Container — unmask the real error in codex's `gen()` finally (+ version-comment cleanup)

**Files:**
- Modify: `container/agent-runner/src/providers/codex.ts` (`gen()` ~465–625)
- Modify: `container/agent-runner/src/providers/codex-app-server.ts` (comments at ~462, ~584, ~589 only)
- Create: `container/agent-runner/src/providers/codex-error-masking.test.ts`
- Modify: `container/agent-runner/src/integration.test.ts`

**Interfaces:**
- Consumes: `CodexProvider(options, queryDependencies)` — 2nd ctor arg `CodexQueryDependencies` with seams `syncManagedSkillLinks`, `writeMcpConfig`, `createConfigOverrides`, `spawnServer`, `attachAutoApproval`, `initializeServer`, `startThread`, `terminateServer` (codex.ts ~326–357). `ProviderQuiescenceError` from `./types.js` (supports `cause` via `ErrorOptions`).
- Produces: when the `gen()` try body exits with an exception AND teardown also throws, `query.events` rejects with the ORIGINAL body error object (type preserved), with the `ProviderQuiescenceError` attached — as `cause` if the original has none, else as a `quiescenceFailure` property. The quiescence promise (awaited by `query.abort()`) still rejects with the `ProviderQuiescenceError` (via `failQuiescence`, unchanged). When the body exits cleanly, behavior is unchanged (teardown failure still throws the quiescence error). Task 5 mirrors this contract for opencode; Task 6 relies on the poll-loop now receiving the original error type.

- [ ] **Step 1: Write the failing provider-level test**

Create `container/agent-runner/src/providers/codex-error-masking.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { type AppServer } from './codex-app-server.js';
import { CodexProvider } from './codex.js';
import { ProviderQuiescenceError } from './types.js';

function queryServer(): AppServer {
  return {
    process: {},
    readline: { close() {} },
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
}

function makeProvider(): CodexProvider {
  return new CodexProvider(
    {},
    {
      syncManagedSkillLinks: () => [],
      writeMcpConfig: () => {},
      createConfigOverrides: () => [],
      spawnServer: () => queryServer(),
      attachAutoApproval: () => {},
      initializeServer: async () => {},
      startThread: async () => 'thread-abc',
      terminateServer: async () => {
        // Mirrors the production reality: terminateCodexAppServer ALWAYS
        // throws post-spawn ('transport shutdown' branch is the common case).
        throw new ProviderQuiescenceError(
          'Codex app-server exited after transport shutdown, but whole process tree quiescence is unproven until host container stop: code=0 signal=null',
        );
      },
    },
  );
}

describe('codex gen() finally must not mask the in-flight body error', () => {
  it('rethrows the acceptance-gate rejection type-preserved with the quiescence failure attached', async () => {
    class FakeAcceptanceError extends Error {
      constructor() {
        super('trusted host input bind failed for in-both-faults');
        this.name = 'TrustedInputAcceptanceError';
      }
    }
    const bodyError = new FakeAcceptanceError();
    const provider = makeProvider();
    const query = provider.query({
      inputId: 'in-both-faults',
      acceptInput: async () => {
        throw bodyError;
      },
      prompt: 'do work',
      cwd: '/workspace/agent',
    });
    let rejection: unknown;
    try {
      for await (const _event of query.events) {
        // drain until the generator rejects
      }
    } catch (err) {
      rejection = err;
    }
    expect(rejection).toBe(bodyError); // the ORIGINAL error object — instanceof routing works
    const attached =
      (rejection as { cause?: unknown }).cause ?? (rejection as { quiescenceFailure?: unknown }).quiescenceFailure;
    expect(attached).toBeInstanceOf(ProviderQuiescenceError);
    // The abort waiter still sees the typed quiescence failure.
    const abortRejection = await query.abort().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(abortRejection).toBeInstanceOf(ProviderQuiescenceError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd container/agent-runner && bun test src/providers/codex-error-masking.test.ts
```
Expected: FAIL — `rejection` is the `ProviderQuiescenceError`, not `bodyError` (the mask).

- [ ] **Step 3: Implement the unmask in `codex.ts`**

In `gen()` (~465): declare capture variables immediately after `generatorStarted = true;` / the early-abort return, before the main `try`:

```ts
      let bodyError: unknown;
      let bodyErrorCaptured = false;
```

Insert a capture `catch` between the main try body's closing brace and the existing `} finally {` (~606) — the try currently has NO catch clause:

```ts
      } catch (err) {
        bodyError = err;
        bodyErrorCaptured = true;
        throw err;
      } finally {
```

Then replace the finally's inner catch (~621–623):

```ts
        } catch (err) {
          throw failQuiescence(err);
        }
```

with:

```ts
        } catch (err) {
          const quiescenceFailure = failQuiescence(err);
          if (bodyErrorCaptured) {
            // The body error is the real failure (e.g. a trusted-acceptance
            // rejection with designed graceful handling in the poll-loop). The
            // always-throwing post-spawn teardown must not replace it: rethrow
            // the original, type-preserved, with the quiescence failure
            // attached so nothing is lost. failQuiescence above still rejects
            // the quiescence promise for abort waiters.
            if (bodyError instanceof Error && bodyError.cause === undefined) {
              (bodyError as Error & { cause?: unknown }).cause = quiescenceFailure;
            } else if (bodyError instanceof Error) {
              (bodyError as Error & { quiescenceFailure?: unknown }).quiescenceFailure = quiescenceFailure;
            }
            throw bodyError;
          }
          throw quiescenceFailure;
        }
```

- [ ] **Step 4: Run the new test + the codex suites**

```bash
cd container/agent-runner && bun test src/providers/codex-error-masking.test.ts
bun test src/providers/codex-interrupt.test.ts src/providers/codex-error-surfacing.test.ts src/providers/codex-app-server.test.ts
```
Expected: ALL PASS. If any pre-existing test pinned the masked behavior (asserting a `ProviderQuiescenceError` rejection where the body also erred), re-read it: the fix is the intended behavior change, update the assertion to expect the original error with the quiescence failure attached — and say so in the commit body.

- [ ] **Step 5: Write the poll-loop e2e regression (graceful path reachable with the REAL CodexProvider)**

In `container/agent-runner/src/integration.test.ts`: first read the existing test `cancels before model output and backs off when trusted input binding fails` (~210) — reuse its exact loop-runner, config, `insertMessage`, `waitFor`/`sleep`, and pending/undelivered assertions. Add a sibling test that swaps in a real `CodexProvider` with fake deps (imports: `CodexProvider` from `./providers/codex.js`, `ProviderQuiescenceError` from `./providers/types.js`, plus a local `queryServer()` helper identical to Step 1's):

```ts
  it('returns the batch to pending when a codex bind failure coincides with an always-throwing teardown', async () => {
    // The dvora/hinda container-side signature: host rejects the bind AND the
    // codex app-server teardown throws its designed quiescence sentinel. The
    // real bind failure must reach the poll-loop's graceful return-to-pending
    // path instead of exiting fatally through the quiescence rethrow.
    let bindAttempts = 0;
    const provider = new CodexProvider(
      {},
      {
        syncManagedSkillLinks: () => [],
        writeMcpConfig: () => {},
        createConfigOverrides: () => [],
        spawnServer: () => queryServer(),
        attachAutoApproval: () => {},
        initializeServer: async () => {},
        startThread: async () => 'thread-abc',
        terminateServer: async () => {
          throw new ProviderQuiescenceError(
            'Codex app-server exited after transport shutdown, but whole process tree quiescence is unproven until host container stop: code=0 signal=null',
          );
        },
      },
    );
    insertMessage('m-codex-bind-fail', 'chat', { text: 'hello' });
    // Run the loop exactly as the '~210' test does, but with:
    //   provider,
    //   bindGwsCorrelation: async () => { bindAttempts += 1; throw new Error('host bind unavailable'); },
    // and the same abort-signal/timeout wiring. Copy that wiring verbatim from
    // the '~210' test — it is the canonical way this file runs and stops the loop.
    // Assertions (same shape as the '~210' test):
    await waitFor(() => bindAttempts === 1, 1000);
    await sleep(100);
    expect(bindAttempts).toBe(1); // durable backoff, no hot retry loop
    expect(getPendingMessages().map((m) => m.id)).toContain('m-codex-bind-fail'); // returned to pending, not fatal
  });
```

The loop-invocation lines marked by the comment must be copied from the ~210 test verbatim (same helper names, same signal/timeout handling). The NEW assertions are exactly the three `expect`s above. Critically, the loop promise must NOT reject with `ProviderQuiescenceError` — if the ~210 test asserts on the loop promise, mirror that assertion here expecting graceful continuation.

- [ ] **Step 6: Run it**

```bash
cd container/agent-runner && bun test src/integration.test.ts
```
Expected: ALL PASS (the new test would fail before Step 3's fix — if you want proof, `git stash` the codex.ts change, run, unstash).

- [ ] **Step 7: Fix the version-comment drift (comments only)**

In `container/agent-runner/src/providers/codex-app-server.ts`, three stale references say `0.139.0`; the deployed pin is `0.144.1` (`container/Dockerfile:24 ARG CODEX_VERSION=0.144.1`). Update the version string in each comment, leaving the surrounding prose intact:
- ~462: `the pinned 0.139.0 app-server sends the canonical v2 signal` → `the pinned 0.144.1 app-server sends the canonical v2 signal`
- ~584: `verified against the bundled codex-cli 0.139.0 native binary's embedded protocol types` → `... codex-cli 0.144.1 native binary's embedded protocol types`
- ~589: "Shapes verified with `codex app-server generate-ts` from codex-cli 0.139.0" → `... from codex-cli 0.144.1`

- [ ] **Step 8: Typecheck and commit**

```bash
cd /home/dan/code/nanoclaw-reboot-resilience/.worktrees/gws-reacceptance
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
git add container/agent-runner/src/providers/codex.ts container/agent-runner/src/providers/codex-error-masking.test.ts container/agent-runner/src/integration.test.ts
git commit -m "fix(codex): rethrow the in-flight body error type-preserved instead of masking it with the quiescence sentinel"
git add container/agent-runner/src/providers/codex-app-server.ts
git commit -m "chore(codex): update stale 0.139.0 version comments to the deployed 0.144.1 pin"
```

---

### Task 5: Container — same finally-mask fix in opencode

**Files:**
- Modify: `container/agent-runner/src/providers/opencode.ts` (the query generator's terminal finally, ~1441–1448)
- Test: `container/agent-runner/src/providers/opencode.test.ts`

**Interfaces:**
- Consumes: `makeProvider({ stream })` helper (opencode.test.ts ~643) returning `{ provider, controller }` with a `FakeController` (its `destroy` records reasons and resolves); `FakeStream` with `.push(event)`; `ProviderQuiescenceError` from `./types.js`; `asProviderQuiescenceError` (opencode.ts ~112–117).
- Produces: same contract as Task 4 — original body error rethrown type-preserved with the quiescence failure attached (as `cause` when absent, else `quiescenceFailure` property) when both the generator body and `teardownRuntime('query_stream_finalized')` fail; teardown-only failures unchanged.

Audit result feeding this task (spec asked to audit "~455"): the `finally` at opencode.ts ~457 inside `RealOpenCodeRuntimeController.destroy()` is benign (no throw). The real mask is one level up: the query generator's terminal finally at ~1441–1448 does a bare `await teardownRuntime('query_stream_finalized')`, and `destroy()` always throws `ProviderQuiescenceError` (~454) — structurally identical to codex. Fix it there.

- [ ] **Step 1: Write the failing test**

In `opencode.test.ts`, next to the existing `cancels the OpenCode turn when the trusted acceptance gate rejects` (~702–715), add (reusing `FakeStream` and `makeProvider` from the file):

```ts
  it('rethrows the acceptance-gate rejection type-preserved when teardown also throws a quiescence fault', async () => {
    const stream = new FakeStream();
    const { provider, controller } = makeProvider({ stream });
    (controller as { destroy: (reason: string) => Promise<void> }).destroy = async () => {
      throw new ProviderQuiescenceError(
        'OpenCode runtime exited, but whole process tree quiescence is unproven until host container stop',
      );
    };
    class FakeAcceptanceError extends Error {
      constructor() {
        super('trusted host input bind failed for in-oc-both-faults');
        this.name = 'TrustedInputAcceptanceError';
      }
    }
    const bodyError = new FakeAcceptanceError();
    const query = provider.query({
      inputId: 'in-oc-both-faults',
      acceptInput: async () => {
        throw bodyError;
      },
      prompt: 'do not submit',
      cwd: '/workspace/agent',
    });
    let rejection: unknown;
    try {
      for await (const _event of query.events) {
        // drain until rejection
      }
    } catch (err) {
      rejection = err;
    }
    expect(rejection).toBe(bodyError);
    const attached =
      (rejection as { cause?: unknown }).cause ?? (rejection as { quiescenceFailure?: unknown }).quiescenceFailure;
    expect(attached).toBeInstanceOf(ProviderQuiescenceError);
  });
```

If `ProviderQuiescenceError` is not yet imported in the test file, add it to the existing `./types.js` import. If the query path in this harness reaches teardown through `self.destroyRuntime` rather than the controller (check `teardownRuntime`, opencode.ts ~866–878: relay mode uses `relayController`, non-relay uses `self.destroyRuntime(reason)`), make the fake teardown throw at whichever seam `makeProvider` wires — read `makeProvider` (~643) and the `runtimeFactory` it installs, and override the destroy on the object that `destroyRuntime` reaches.

- [ ] **Step 2: Run to verify it fails**

```bash
cd container/agent-runner && bun test src/providers/opencode.test.ts -t 'teardown also throws'
```
Expected: FAIL — rejection is the `ProviderQuiescenceError` (mask), not `bodyError`.

- [ ] **Step 3: Implement in `opencode.ts`**

Locate the query generator's terminal `try { ... } finally { pump.dispose(); ...; await teardownRuntime('query_stream_finalized'); }` (~1441–1448). Declare capture variables just before that `try`:

```ts
      let bodyError: unknown;
      let bodyErrorCaptured = false;
```

If the try has no catch clause, add one before the finally; if it already has catch clauses that rethrow (there is a `teardownRuntime('session_error')` call at ~1400 — inspect whether it lives in a catch of THIS try), set the capture inside each such catch immediately before its rethrow instead:

```ts
      } catch (err) {
        bodyError = err;
        bodyErrorCaptured = true;
        throw err;
      } finally {
        pump.dispose();
        // A closed event stream is a terminal query boundary. Retire the
        // controller even for unexpected generator failures so no OpenCode
        // process or SSE reader can outlive the query whose correlation the
        // poll loop is about to release.
        try {
          await teardownRuntime('query_stream_finalized');
        } catch (teardownErr) {
          if (bodyErrorCaptured) {
            // Same contract as codex.ts: the body error is the real failure;
            // the always-throwing teardown must not replace it.
            const quiescenceFailure = asProviderQuiescenceError(
              teardownErr,
              'OpenCode runtime teardown failed (query_stream_finalized)',
            );
            if (bodyError instanceof Error && bodyError.cause === undefined) {
              (bodyError as Error & { cause?: unknown }).cause = quiescenceFailure;
            } else if (bodyError instanceof Error) {
              (bodyError as Error & { quiescenceFailure?: unknown }).quiescenceFailure = quiescenceFailure;
            }
            throw bodyError;
          }
          throw teardownErr;
        }
      }
```

- [ ] **Step 4: Run the opencode suites**

```bash
cd container/agent-runner && bun test src/providers/opencode.test.ts
bun test src/opencode-incident-replay.test.ts
```
Expected: ALL PASS. The incident-replay suite is the guard that this change does not alter recorded-incident dispositions — if any replay test changes verdict, STOP and re-examine (the fix must only change which error type propagates when BOTH body and teardown fail).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /home/dan/code/nanoclaw-reboot-resilience/.worktrees/gws-reacceptance
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
git add container/agent-runner/src/providers/opencode.ts container/agent-runner/src/providers/opencode.test.ts
git commit -m "fix(opencode): rethrow the in-flight body error type-preserved instead of masking it with the quiescence sentinel"
```

---

### Task 6: Container — belt-and-braces: persist the pre-accept retry schedule before a fatal quiescence rethrow

**Files:**
- Modify: `container/agent-runner/src/poll-loop.ts` (the catch block, ~736–743)
- Test: `container/agent-runner/src/poll-loop.test.ts`

**Interfaces:**
- Consumes: in-scope at the ~743 rethrow site: `err`, `errMsg`, `initialClaim` (`InputClaimBatch | undefined`, field `acceptanceObserved: boolean`), `config.providerName`, `activeRouteKey`, `topLevelInputId`, `withSqliteRetry`, `scheduleProviderRetry(providerName, routeKey, nowMs, triggerInputId)` from `./db/session-state.js` (already imported; bounded: 10 attempts, exp backoff capped 30 s, then durably `exhausted`), `log`. `readProviderRetrySchedule(providerName, routeKey)` for the test.
- Produces: when a `ProviderQuiescenceError` reaches the fatal rethrow with `initialClaim?.acceptanceObserved === false` (nothing was accepted), the durable retry schedule is written first, then the error is rethrown unchanged. `TrustedInputLifecycleError` and post-acceptance quiescence exits are untouched (their `acceptanceObserved` is `true`).

- [ ] **Step 1: Write the failing test**

In `poll-loop.test.ts`, find `describe('provider finalization barriers')` (~4073) and the existing test `exits fatally and retains correlation when provider quiescence cannot be proved` (~4199) — read it first and reuse its exact provider/loop wiring (inline `AgentProvider` literal, `insertMessage`/`stampHostInput` fixtures, loop runner, route naming). Add a sibling test; ensure `readProviderRetrySchedule` is imported from `./db/session-state.js` and `ProviderQuiescenceError` from `./providers/types.js`:

```ts
  it('persists a bounded pre-accept retry schedule before a fatal quiescence exit', async () => {
    // Same wiring as 'exits fatally and retains correlation when provider
    // quiescence cannot be proved' (~4199): insert one pending trigger message,
    // stamp its host input/route, and run the loop with a provider whose event
    // stream rejects with ProviderQuiescenceError BEFORE any input-accepted
    // event and WITHOUT the acceptance gate ever resolving. Copy that test's
    // message/route/provider-name setup verbatim, replacing only the provider:
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query(_input) {
        return {
          push() {},
          end() {},
          abort: async () => {},
          events: (async function* (): AsyncGenerator<ProviderEvent> {
            throw new ProviderQuiescenceError('teardown failed before any acceptance');
          })(),
        };
      },
    };
    // Run the loop exactly as the ~4199 test does and assert the SAME fatal exit:
    // await expect(loopPromise).rejects.toBeInstanceOf(ProviderQuiescenceError);
    // NEW assertion — the durable schedule exists for the next incarnation
    // (use the same provider name and route key the copied wiring uses; the
    // schedule-asserting tests at ~4489/4540 show the exact naming):
    const schedule = readProviderRetrySchedule(PROVIDER_NAME, ROUTE_KEY);
    expect(schedule?.attempts).toBe(1);
    expect(schedule?.status).toBe('scheduled');
  });
```

`PROVIDER_NAME` / `ROUTE_KEY` stand for the same provider name and route key the copied wiring uses (the ~4199 test and the schedule-asserting tests at ~4489/4540 — `durably backs off a provider failure before input-accepted and emits one bounded user error` — are the naming reference; substitute their literal values).

- [ ] **Step 2: Run to verify it fails**

```bash
cd container/agent-runner && bun test src/poll-loop.test.ts -t 'persists a bounded pre-accept retry schedule'
```
Expected: FAIL — `schedule` is `undefined` (nothing persisted before the fatal rethrow).

- [ ] **Step 3: Implement in `poll-loop.ts`**

Replace (~740–743):

```ts
      // These failures mean accepted work may still be live or host-committed.
      // Leaving the process is intentional: host stop proof and recovery own
      // the correlation from here. Never release/retry inside this runner.
      if (err instanceof TrustedInputLifecycleError || err instanceof ProviderQuiescenceError) throw err;
```

with:

```ts
      // These failures mean accepted work may still be live or host-committed.
      // Leaving the process is intentional: host stop proof and recovery own
      // the correlation from here. Never release/retry inside this runner.
      if (err instanceof TrustedInputLifecycleError || err instanceof ProviderQuiescenceError) {
        if (err instanceof ProviderQuiescenceError && initialClaim?.acceptanceObserved === false) {
          // Belt-and-braces: nothing was accepted, so this fatal exit must
          // leave a durable, bounded retry schedule behind for the next runner
          // incarnation instead of an unbounded crash loop on the route.
          await withSqliteRetry(
            () => scheduleProviderRetry(config.providerName, activeRouteKey, Date.now(), topLevelInputId),
            { label: 'scheduleProviderRetry' },
          );
          log(
            JSON.stringify({
              severity: 'warn',
              event: 'provider_quiescence_failure_preaccept_retry_persisted',
              route_key: activeRouteKey,
              error: errMsg,
            }),
          );
        }
        throw err;
      }
```

- [ ] **Step 4: Run the poll-loop suite**

```bash
cd container/agent-runner && bun test src/poll-loop.test.ts
```
Expected: ALL PASS — in particular the finalization-barrier tests at ~4074–4614 (their quiescence exits happen post-acceptance, `acceptanceObserved === true`, so no schedule is written for them; if one now fails on an unexpected schedule, the guard condition is wrong).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /home/dan/code/nanoclaw-reboot-resilience/.worktrees/gws-reacceptance
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
git add container/agent-runner/src/poll-loop.ts container/agent-runner/src/poll-loop.test.ts
git commit -m "fix(poll-loop): persist the pre-accept retry schedule before a fatal pre-acceptance quiescence exit"
```

---

### Task 7: Full verification gates

**Files:** none created; fixes only if gates fail.

**Interfaces:**
- Consumes: everything above.
- Produces: a fully green worktree at CI parity.

- [ ] **Step 1: Run the exact CI sequence from the worktree root**

```bash
cd /home/dan/code/nanoclaw-reboot-resilience/.worktrees/gws-reacceptance
pnpm run format:check
pnpm exec tsc --noEmit
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec vitest run
(cd container/agent-runner && bun test)
pnpm run lint
```
Expected: every command exits 0. Host test count ≥ 1,119 + the ~9 new tests; container count ≥ 419 + the ~4 new tests. `format:check` failures: run `pnpm run format:fix` and re-run. Lint failures around the new host code: most likely `preserve-caught-error` — ensure every wrap carries `{ cause: err }` (note: the Task 4/5 pattern rethrows the ORIGINAL error, which satisfies the rule; the attachment property is additive).

- [ ] **Step 2: Verify the acceptance-critical behaviors one more time by name**

```bash
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 're-binds the same input'
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'hinda signature'
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'LIVE'
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'dvora/hinda regression'
(cd container/agent-runner && bun test src/providers/codex-error-masking.test.ts && bun test src/integration.test.ts -t 'codex bind failure' && bun test src/poll-loop.test.ts -t 'persists a bounded pre-accept')
```
Expected: all PASS.

- [ ] **Step 3: Commit any straggler fixes**

```bash
git status --short   # should be clean; if format:fix touched files:
git add -A && git commit -m "chore: formatting fixes from format:fix"
```

---

## Self-Review (performed while writing this plan)

**1. Spec coverage:**
- Fix 1 same-input re-bind → Task 1 (conflict relaxation + reopen UPDATE) + Task 2 (derivation). Mixed-batch adoption → Task 1 + Task 2 regression test. Companion ~857–865 derivation → Task 2. Fail-closed for live conflicts kept → Task 1 (code comment + dedicated test). First-acceptance immutability → asserted in every re-bind/adoption test.
- Fix 2 unmask codex → Task 4; opencode ~455 audit → performed (hazard confirmed at ~1441–1448, not ~455) and fixed in Task 5. Poll-loop routing reachability → Task 4 Step 5 e2e with the real CodexProvider.
- Fix 3 host-side rejection logging → Task 3.
- Fix 4 belt-and-braces schedule persistence → Task 6.
- Cleanup version comments → Task 4 Step 7. Live poisoned-row disposition → determined (self-heal; verification query given) in the header section, documented only, as required.
- Required tests: same-input re-bind after crash (Task 1 + Task 2), mixed-batch adoption (Task 1 + Task 2), live-conflict still-throws (Task 1), unmasked error routing reaching the graceful paths (Task 4 Steps 1+5), dvora/hinda regression end-to-end at the level the infra supports (Task 2 authenticated-request level — full HMAC/lease/sequence/DB/pointer path, everything but TCP framing, which the existing socket-transport tests already cover — plus Task 4 Step 5 for the container half; no harness drives host IPC and container poll-loop in one process, so the pair is the deepest available reproduction).
- R2 semantics ("bounded retries now SUCCEED on retry"): host-side acceptance of the retried bind is Task 1/2's subject; container-side graceful continuation is Task 4 Step 5; the pre-accept schedule paths are untouched except Task 6's addition. No task weakens R1/R8/R9 paths (no changes to expiry, sweep, sanitization, or journal-healing code).

**1b. No silent deferrals:** No stubs or fakes stand in for required production behavior — provider tests use the repo's established seam-injection harnesses while exercising the real `CodexProvider`/`OpenCodeProvider`/`bindAcceptedGwsCorrelation`/`processAuthenticatedGwsCorrelationRequest` code paths; the production outcome (route unblocks on next turn) is reproduced at the authenticated-request level with real HMAC and real SQLite. No UNRESOLVED COVERAGE GAPS.

**2. Placeholder scan:** Two intentional read-then-copy directives remain (Task 4 Step 5 and Task 6 Step 1 reference the exact existing test to copy loop wiring from, with the new logic and assertions given in full; Tasks 3/5 include fallback instructions keyed to named seams). These reference *existing repo code by name and line*, not undefined future work. No TBD/TODO/"handle edge cases" items.

**3. Type consistency:** `AcceptedRow.host_acceptance_ended_at: string | null` (Task 1) matches the SELECT; `AcceptedLeaseInput.durableAcceptedAt: string` (Task 2) is set at the single `state.acceptedInputs.set` site and read at the single `existing.durableAcceptedAt` site; `readDurableOriginalAcceptance(dbPath: string, inputId: string): string | undefined` matches its call; the attachment contract (`cause` if absent else `quiescenceFailure`) is identical in Task 4 code, Task 4 test, Task 5 code, Task 5 test. `scheduleProviderRetry(providerName, routeKey, nowMs, triggerInputId)` in Task 6 matches `session-state.ts:147`.
