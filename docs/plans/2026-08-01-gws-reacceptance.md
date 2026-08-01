# GWS-Correlation Durable Re-Acceptance Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Fix the GWS-correlation re-acceptance rejection class so a fresh container can re-bind message rows whose prior host acceptance interval has durably ENDED (crashed-container leftovers), and unmask the real error at BOTH masking layers (the provider finally AND poll-loop's `processQuery` finally) so the poll-loop's designed graceful handling is reachable — eliminating the "Codex app-server exited after transport shutdown" container-fatal class (64 crashes / 22 sessions on 2026-08-01; all 22 R2 terminal escalations). Live-host status, precisely (V5): the 22 crashed sessions — including hinda's route — are ALREADY unblocked pre-fix, because R2 terminal escalation marked their poisoned rows `failed` at the cost of silently dropping real user messages (hinda lost 3 Jul-31 chat messages). The fix's production value is therefore (a) no recurrence of the fatal class, (b) self-heal of the ~180 stale poisoned pending rows across 178 fleet DBs before a trigger detonates them, and (c) no further R2 escalations or message loss from this class — see "Post-Deploy Disposition" below.

**Architecture:** Five coordinated fixes. (1) Host: `bindAcceptedGwsCorrelation` treats rows whose acceptance interval has ENDED (`host_acceptance_ended_at IS NOT NULL`) as historical, not conflicting — permitting same-input re-bind and mixed-batch adoption while keeping first-acceptance columns immutable and keeping the fail-closed throw for LIVE conflicting intervals; the pointer-advance close stamps an explicit request-time `closedAt` (never a possibly-derived-old `acceptedAt`), and `releaseAcceptedGwsCorrelation` is broadened symmetrically to close every open interval (adopted rows keep the immutable OLD input id and would otherwise stay live — falsified A4); companion: `processAuthenticatedGwsCorrelationRequest` derives `originalAcceptedAt` from the durable row for inputs the DB already knows. (2) Container: codex's `gen()` finally (and opencode's structurally identical finally) stop replacing the in-flight body error with the always-thrown `ProviderQuiescenceError` — the original error propagates type-preserved with the quiescence failure attached. (3) Container: the SECOND mask (falsified A6/A10) — poll-loop `processQuery`'s finally awaits the abort promise and throws its quiescence rejection, replacing the body error again — is fixed for the pre-accept case only (nothing host-committed), which is what actually makes the graceful `poll-loop.ts` ~745 routing reachable; post-acceptance quiescence failures stay fatal by design (A7). (4) Host: `ok:false` bind rejections get a `log.warn` line. (5) Container: belt-and-braces — a quiescence error with `acceptanceObserved === false` AND nothing host-committed persists the bounded pre-accept retry schedule before the fatal rethrow (falsified A11: `acceptanceObserved` alone is not a host-commit discriminator). Plus cleanup: stale `0.139.0` version comments → `0.144.1`.

**Tech Stack:** TypeScript (strict, NodeNext, ESM with `.js` relative imports). Host: Node 22 + pnpm + better-sqlite3 + vitest. Container agent-runner: Bun + bun:sqlite + bun:test (separate package tree, never mixes with vitest).

## Global Constraints

- **Do NOT deploy. Do NOT write to the live host.** Read-only ssh inspection is fine. All work stays in this worktree.
- **Fail-closed posture is sacred:** GWS correlation prevents duplicate side-effects (double Drive writes etc.). LIVE conflicting acceptance intervals and uncertain side-effect state must still throw. Only *provably historical* acceptance state (`host_acceptance_ended_at IS NOT NULL`) becomes re-acceptable — and even then only through LEASE ADMISSION: the bind must arrive over a live host-issued lease (in-memory lease map entry deleted only by verified revoke; `active-lease.json` created with `'wx'`; startup barrier runs only after confirmed orphan stop). `host_acceptance_ended_at` is the row-level marker, not by itself cross-life proof (A1).
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

Live-host findings (V5, read-only ssh, 2026-08-01 ~19:35Z) supersede the earlier framing:

- **The 22 crashed sessions (including hinda's `sess-1781493473489`) are ALREADY unblocked pre-fix.** After the third fatal on each route, R2 terminal escalation marked the poisoned rows `failed`; fresh messages on those routes then bound and completed normally (verified live for hinda: a fresh message completed 18:36–18:47Z the same day). Cost: some poisoned rows were real user messages — hinda lost 3 Jul-31 chat messages. **Recovering rows already marked `failed` is an out-of-scope ops decision that nobody has made; this plan documents it as explicitly unowned and does not act on it.** The fix does not "unblock" those routes (they are not blocked); it prevents recurrence and prevents this message-loss mode.
- **The real self-heal target population is ~180 stale poisoned pending rows across 178 inbound DBs fleet-wide** (5,113 DBs scanned): mostly July 22–25 cli/cli-smoke harness sessions (ag-main and per-yente groups), ~28 operator-gws sessions, and dvora's task session `sess-1781325123591`. All carry `host_accepted_at` set AND `host_acceptance_ended_at` set (zero third-shape rows fleet-wide; the single open-interval row observed belonged to a live, running turn). These rows idle harmlessly until a host-backed trigger joins their batch — pre-fix that detonates the crash loop; post-fix the host adopts them. **Self-heal via the fix; no one-time data disposition is required.**
- **Restated success criteria:** (a) no recurrence of the fatal class (either message variant — `transport shutdown` and `required direct SIGTERM`); (b) the stale-row population drains over subsequent wakes — the container batch SELECT is capped at 10 rows (`maxMessagesPerPrompt`), so "first post-deploy turn" is exact only for a new trigger's OWN bind; stale rows beyond the cap drain over several wakes; (c) no further R2 terminal escalations or silent user-message loss from this class. Note ops triage of the same debris is already in flight (shapiroserver2 `a81e475`, "clear 56 harness claims") — re-run the verification below near deploy time.

Pre-deploy verification (read-only ssh), per affected session — the inbound query alone is NOT sufficient; run all three checks:

1. Inbound query: `SELECT id, status, host_accepted_input_id, host_accepted_at, host_acceptance_ended_at FROM messages_in WHERE status = 'pending' AND host_accepted_at IS NOT NULL;`
2. **Container-liveness cross-check:** a returned row with NULL `host_acceptance_ended_at` is not automatically bad — if a container for that session is RUNNING (`docker ps`), an open interval is benign in-flight state; wait for turn end and re-run. Only NULL-ended with NO running container indicates an orphaned open interval — restart the host first (the startup barrier `expireAllStaleGwsCorrelations` closes it); no manual UPDATE is needed in either case.
3. **Outbound `processing_ack` inspection:** batch inclusion also requires the row's outbound ack to be absent or `'processing'`, which the `messages_in` query cannot see. Run `SELECT message_id, status FROM processing_ack WHERE message_id IN (<poisoned ids>);` against the session's outbound DB — rows hidden behind `'recovery'` acks rejoin pending only after the R1 TTL release, and `'failed'`/`'completed'` acks are terminal. Treat those rows as R1/R2-owned and EXCLUDED from self-heal until released, not as first-turn adoption candidates.

## File Structure

| File | Responsibility in this change |
|---|---|
| `src/gws-correlation-ipc.ts` (modify) | Host acceptance boundary. Tasks 1–3: ended-interval re-acceptance + explicit `closedAt` pointer-advance close + broadened `releaseAcceptedGwsCorrelation` in `bindAcceptedGwsCorrelation`/release, durable `originalAcceptedAt` derivation in `processAuthenticatedGwsCorrelationRequest`, warn-log on `ok:false`. |
| `src/gws-correlation-ipc.test.ts` (modify) | Host tests for all three host fixes, incl. the dvora/hinda regression at the authenticated-request level, the closedAt stamping test, and release-after-adoption. |
| `src/host-sweep.test.ts` (modify) | Task 1: recovery-pipeline regression — an interrupted adopted mixed-batch turn recovers through the real sweep entry points despite the expected multi-partition split. |
| `container/agent-runner/src/providers/codex.ts` (modify) | Task 4: `gen()` finally stops masking the body error. |
| `container/agent-runner/src/providers/codex-error-masking.test.ts` (create) | Task 4: provider-level unmask test. |
| `container/agent-runner/src/integration.test.ts` (modify) | Task 6 (moved from Task 4): poll-loop e2e — real CodexProvider bind failure reaches the graceful return-to-pending path; only passes once the poll-loop finally fix lands (A14). |
| `container/agent-runner/src/providers/codex-app-server.ts` (modify) | Task 4 cleanup: `0.139.0` comment drift → `0.144.1` (comments only). |
| `container/agent-runner/src/providers/opencode.ts` (modify) | Task 5: same finally-mask fix in the query generator's terminal finally. |
| `container/agent-runner/src/providers/opencode.test.ts` (modify) | Task 5: provider-level unmask test. |
| `container/agent-runner/src/poll-loop.ts` (modify) | Task 6: `processQuery`'s finally stops replacing a pre-accept body error with the abort-await quiescence rejection. Task 7: persist the pre-accept retry schedule (host-commit-guarded) before the fatal quiescence rethrow. |
| `container/agent-runner/src/poll-loop.test.ts` (modify) | Task 6: pre-accept graceful + post-accept still-fatal tests; the ~4436 pinned test re-verified/annotated, with the pre-accept fatal expectation change called out as intended in the commit body. Task 7: schedule-persisted + no-schedule-when-host-committed tests. |

Key facts the implementer must know (verified against `bf853d6`; re-verify):

- `messages_in` acceptance columns (`src/db/schema.ts:318–324`): `host_accepted_input_id`, `host_accepted_route_key`, `host_accepted_at` (the immutable FIRST acceptance triple), `host_acceptance_ended_at` (interval close; NULL = live), `host_acceptance_claim_token`, `host_acceptance_lease_id`, `host_acceptance_sequence` (the CURRENT interval's bookkeeping).
- `host_acceptance_ended_at` is written by exactly four sites, all in `src/gws-correlation-ipc.ts`: lease-scoped `expireAcceptedRows` (~235), the global startup barrier branch (~240–253), the prior-input close inside `bindAcceptedGwsCorrelation` (~601–605), and `releaseAcceptedGwsCorrelation` (~695–698). So every container life that ends (confirmed stop OR host restart) durably closes its intervals. A1 PRECISION (V1): the bind-side pointer-advance close and `releaseAcceptedGwsCorrelation` stamp `ended_at` WITHIN a live life by design, so `ended_at` alone is NOT proof the prior life is over. Cross-life re-bind safety is carried by LEASE ADMISSION: the in-memory lease map (entry deleted only by verified revoke), the `'wx'`-created `active-lease.json` marker, and the startup barrier that runs only after confirmed orphan stop (`src/index.ts` ~87–89, after `cleanupOrphansVerified`). `ended_at` is the row-level *marker* that a lease-admitted actor may re-accept the row.
- The deadlock being fixed: (a) container has no durable `originalAcceptedAt` and sends now() (`container/agent-runner/src/gws-correlation.ts` ~373/387); (b) host new-lease path requires `originalAcceptedAt === providerAcceptance.acceptedAt` (~863); (c) `bindAcceptedGwsCorrelation` throws when `row.host_accepted_at !== acceptedAt` (~626–636) even though the prior interval ENDED. Deterministic per message; the mixed-batch shape additionally trips the `host_accepted_input_id !== inputId` arm.
- The mask: `codex.ts` `gen()` finally (~606–624) awaits `terminateQueryServer()`, which ALWAYS rejects post-spawn (`terminateCodexAppServer` throws on every path, `codex-app-server.ts` ~350–415, common case 'transport shutdown' ~370–374); the `throw failQuiescence(err)` in the finally's catch replaces the real body error, so `poll-loop.ts` ~743 rethrows the sentinel and the graceful paths (~745–759, ~761–792) are unreachable. The same shape exists in `opencode.ts` at the query generator's terminal finally (~1441–1448): `teardownRuntime` → `destroy()` always throws `ProviderQuiescenceError` (~454).
- The SECOND mask (falsified A6/A10 — V4/V8): even with the providers unmasked, `container/agent-runner/src/poll-loop.ts` `processQuery`'s catch (~1565–1574) *unconditionally* calls `abortQuery()` on any stream failure, and its finally (~1721–1773) awaits `abortPromise`, captures the rejection as `quiescenceFailure`, recovery-owns the uncertain rows (`provider_quiescence_unproven`, ~1746) and THROWS it (~1773) — a throw from a finally REPLACES the in-flight body error by JS semantics (and ~1774–1776 wraps even non-quiescence abort rejections into a `ProviderQuiescenceError`). Since codex's `abort()` always rejects post-spawn, the provider-level unmask alone NEVER makes the graceful `poll-loop.ts` ~745 path reachable — Task 6 exists for exactly this.
- Acceptance bookkeeping asymmetry (falsified A11 — V4): bind success (`poll-loop.ts:968–970`) sets `claim.state = 'accepted'` AND `ctx.boundGwsInputs.add(...)` WITHOUT setting `acceptanceObserved` — only the lifecycle-fault branch (~:980) and the provider `input-accepted` echo (~:1108) set it. So `acceptanceObserved === false` does NOT mean nothing was host-committed. `boundGwsInputs` (entries deleted only by successful release, ~:1782; the release loop is skipped on the quiescence path) is the reliable committed-and-unreleased discriminator — Tasks 6 and 7 both key on it.

---

### Task 1: Host — permit durable re-acceptance in `bindAcceptedGwsCorrelation`

**Files:**
- Modify: `src/gws-correlation-ipc.ts` (interface `AcceptedRow` ~141; `BindAcceptedGwsCorrelationOptions` ~153; function `bindAcceptedGwsCorrelation` ~585–681; function `releaseAcceptedGwsCorrelation` ~683–705)
- Test: `src/gws-correlation-ipc.test.ts`
- Test: `src/host-sweep.test.ts` (Step 5 recovery-pipeline regression)

**Interfaces:**
- Consumes: existing exported `bindAcceptedGwsCorrelation(opts: BindAcceptedGwsCorrelationOptions): void`; `INBOUND_SCHEMA` from `src/db/schema.js`.
- Produces (relied on by Task 2): `bindAcceptedGwsCorrelation` now (a) accepts batches containing rows whose `host_acceptance_ended_at IS NOT NULL` regardless of `acceptedAt`/`inputId` mismatch, re-stamping ONLY `host_acceptance_claim_token`, `host_acceptance_lease_id`, `host_acceptance_sequence` and clearing `host_acceptance_ended_at` on those rows (first-acceptance triple untouched); (b) still throws `'accepted batch conflicts with immutable original acceptance'` for mismatched rows whose interval is LIVE (`host_acceptance_ended_at IS NULL`); (c) on pointer advance to a different input, closes EVERY open interval (`host_accepted_at IS NOT NULL AND host_acceptance_ended_at IS NULL`), not just rows first-accepted under the outgoing input — stamping a NEW explicit `closedAt` (the current request time), never the `acceptedAt` param: after Task 2, `acceptedAt` can be a derived OLD timestamp, and a past-dated `ended_at` trips `host-sweep.ts:1085`'s `upperMs < acceptedMs` invalidation and the `:1122–1126` malformed-acceptance throw, hard-failing the entire `recoverAfterKill` pipeline (V3 probe C). Invariant: the `ended_at` stamped by any close must be ≥ every closed row's `host_accepted_at`; (d) `releaseAcceptedGwsCorrelation` closes EVERY open interval symmetrically — the current input-keyed UPDATE skips adopted rows, whose immutable `host_accepted_input_id` is the OLD input (V3 probe D: `changes=1`, adopted row still LIVE), re-triggering the LIVE-mismatch rejection within-life on the same lease's next bind. `BindAcceptedGwsCorrelationOptions` gains `closedAt?: string` (defaults to now; the authenticated boundary passes it explicitly — Task 2). `bindAcceptedGwsCorrelation`'s call shape is otherwise unchanged.

- [ ] **Step 0: Install dependencies and capture the baseline**

```bash
cd /home/dan/code/nanoclaw-reboot-resilience/.worktrees/gws-reacceptance
pnpm install --frozen-lockfile
(cd container/agent-runner && bun install --frozen-lockfile)
pnpm exec vitest run src/gws-correlation-ipc.test.ts
```
Expected: all 15 existing tests PASS. (If the full suites haven't been run in this worktree yet, that's fine — Task 8 runs everything.)

- [ ] **Step 1: Write the failing tests**

Open `src/gws-correlation-ipc.test.ts`. Read the `describe('host-owned accepted GWS correlation')` block (~line 129) first: it provides the `beforeEach` that creates `root` (tmpdir), `dbPath` (inbound DB with `INBOUND_SCHEMA` applied), and `correlationPath`. Add a new sibling `describe` at the same level, reusing the identical `beforeEach`/`afterEach` scaffold shape (fresh tmpdir + `INBOUND_SCHEMA` + rm in `afterEach`). Ensure `bindAcceptedGwsCorrelation`, `releaseAcceptedGwsCorrelation`, and `Database` (better-sqlite3) are imported (`bindAcceptedGwsCorrelation`/`Database` already are for the existing describe; add `releaseAcceptedGwsCorrelation` to the same import).

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
      closedAt: '2026-08-01T09:00:00.000Z', // the request's current time
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
      closedAt: '2026-08-01T09:00:00.000Z',
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
        closedAt: '2026-08-01T09:00:00.000Z',
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
      closedAt: '2026-08-01T09:00:00.000Z',
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
      closedAt: '2026-08-01T09:05:00.000Z',
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
      closedAt: '2026-08-01T09:00:00.000Z',
      claimToken: 'claim-x',
      leaseId: 'lease-x',
      sequence: 1,
    });
    const outside = readRow('m-outside');
    expect(outside.host_acceptance_ended_at).toBe('2026-08-01T00:00:05.000Z'); // stays closed
    expect(outside.host_acceptance_claim_token).toBe('claim-old');
  });

  it('stamps the explicit closedAt on pointer-advance closes, never the (possibly derived-old) acceptedAt', () => {
    insertRow({ id: 'm-old', seq: 1, hostInputId: 'in-old', routeKey: 'route-1' });
    bindAcceptedGwsCorrelation({
      dbPath,
      correlationPath,
      sessionId: 'sess-1',
      inputId: 'in-old',
      routeKey: 'route-1',
      messageIds: ['m-old'],
      acceptedAt: '2026-08-01T09:00:00.000Z',
      closedAt: '2026-08-01T09:00:00.000Z',
      claimToken: 'claim-old2',
      leaseId: 'lease-x',
      sequence: 1,
    });
    // The next bind carries a derived-OLD acceptedAt (the Task 2 shape) while
    // m-old's interval is live and NOT part of the new batch. The advance must
    // close m-old at the request time (closedAt), not the derived time — a
    // past-dated ended_at would hard-fail recoverAfterKill (host-sweep.ts:1085
    // clamp + :1122–1126 throw, V3 probe C).
    insertRow({ id: 'm-next', seq: 2, hostInputId: 'in-next', routeKey: 'route-1' });
    bindAcceptedGwsCorrelation({
      dbPath,
      correlationPath,
      sessionId: 'sess-1',
      inputId: 'in-next',
      routeKey: 'route-1',
      messageIds: ['m-next'],
      acceptedAt: '2026-07-25T10:00:00.000Z', // derived-old: predates m-old's acceptance
      closedAt: '2026-08-01T09:05:00.000Z', // the request's current time
      claimToken: 'claim-next',
      leaseId: 'lease-x',
      sequence: 2,
    });
    const old = readRow('m-old');
    expect(old.host_acceptance_ended_at).toBe('2026-08-01T09:05:00.000Z'); // closedAt, not acceptedAt
    // The invariant every close must uphold: ended_at >= the closed row's host_accepted_at.
    expect(Date.parse(old.host_acceptance_ended_at as string)).toBeGreaterThanOrEqual(
      Date.parse(old.host_accepted_at as string),
    );
  });

  it('release after adoption closes the adopted row (broadened, not input-keyed)', () => {
    insertRow({
      id: 'm-adopted',
      seq: 1,
      hostInputId: 'in-prior',
      routeKey: 'route-1',
      acceptedInputId: 'in-prior',
      acceptedAt: '2026-08-01T00:00:01.000Z',
      endedAt: '2026-08-01T00:00:05.000Z',
      claimToken: 'claim-old',
      leaseId: 'lease-old',
      sequence: 1,
    });
    insertRow({ id: 'm-turn', seq: 2, hostInputId: 'in-turn', routeKey: 'route-1' });
    bindAcceptedGwsCorrelation({
      dbPath,
      correlationPath,
      sessionId: 'sess-1',
      inputId: 'in-turn',
      routeKey: 'route-1',
      messageIds: ['m-adopted', 'm-turn'],
      acceptedAt: '2026-08-01T09:00:00.000Z',
      closedAt: '2026-08-01T09:00:00.000Z',
      claimToken: 'claim-turn',
      leaseId: 'lease-x',
      sequence: 1,
    });
    releaseAcceptedGwsCorrelation({
      dbPath,
      correlationPath,
      inputId: 'in-turn',
      endedAt: '2026-08-01T10:00:00.000Z',
    });
    const adopted = readRow('m-adopted');
    expect(adopted.host_accepted_input_id).toBe('in-prior'); // immutable original untouched
    expect(adopted.host_acceptance_ended_at).toBe('2026-08-01T10:00:00.000Z'); // closed by the broadened release
    const turn = readRow('m-turn');
    expect(turn.host_acceptance_ended_at).toBe('2026-08-01T10:00:00.000Z');
  });
});
```

Note on the live-conflict test: the fail-closed semantics are *pointer-relative*. When the on-disk pointer names the outgoing input, closing its interval on advance is the designed turn hand-off (tested by the within-life test). A live interval with NO pointer backing it is exactly the uncertain/concurrent state that must keep failing closed.

Note on the safety model (A1): the carrier for CROSS-LIFE re-acceptance is lease admission (confirmed-stop provenance), not `ended_at` alone — `bindAcceptedGwsCorrelation` is reachable in production only through `processAuthenticatedGwsCorrelationRequest`'s live-lease checks (in-memory lease map + `'wx'` `active-lease.json` marker + MAC + per-lease sequence) or the operator session factory, which creates its own lease marker first. The bind/release close sites stamp `ended_at` within a live life by design; `ended_at` is the row-level marker that a lease-admitted actor may re-accept. Task 2's authenticated-level tests pin that admission path; if any future bind entry point is added, pin in tests that it cannot bypass lease admission.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'durable re-acceptance'
```
Expected: the first, second, and fourth tests FAIL with `accepted batch conflicts with immutable original acceptance` (thrown where success is expected); the closedAt-stamping test FAILS on the `ended_at` assertion (the current close stamps `acceptedAt`; the unknown `closedAt` property is ignored at runtime — vitest does not typecheck); the release-after-adoption test FAILS at its bind (conflict throw). The live-conflict and outside-batch tests may pass already.

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

3c. Broaden the prior-input close (~599–606) and stamp an explicit `closedAt`. First add the option to `BindAcceptedGwsCorrelationOptions` (~153, next to `acceptedAt?: string`):

```ts
  /** Close time for pointer-advance interval closes; the CURRENT request time. Defaults to now. */
  closedAt?: string;
```

and canonicalize it next to `acceptedAt` (~588):

```ts
  const closedAt = canonicalTimestamp(opts.closedAt ?? new Date().toISOString(), 'closedAt');
```

(The other production caller, `src/yente/operator-gws-session.ts:156`, may keep omitting it — the now() default is exactly the request time there.) Then replace:

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
        // Stamp closedAt (the CURRENT request time), never acceptedAt: after the
        // durable-derivation companion, acceptedAt can be a derived OLD value,
        // and a past-dated ended_at trips host-sweep's upperMs < acceptedMs
        // clamp (host-sweep.ts:1085) and its malformed-acceptance throw
        // (:1122–1126), hard-failing recoverAfterKill. Invariant: the ended_at
        // stamped by any close is >= every closed row's host_accepted_at.
        db.prepare(
          `UPDATE messages_in
             SET host_acceptance_ended_at = ?
           WHERE host_accepted_at IS NOT NULL AND host_acceptance_ended_at IS NULL`,
        ).run(closedAt);
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
        // must fail closed. A row whose interval has ENDED is re-acceptable —
        // but the safety carrier is LEASE ADMISSION: this function is reachable
        // only through a live host-issued lease (in-memory lease map deleted
        // only by verified revoke, 'wx' active-lease.json, startup barrier only
        // after confirmed orphan stop). ended_at is the row-level marker of a
        // closed interval, not by itself proof the prior life is over (A1).
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

3f. Broaden `releaseAcceptedGwsCorrelation` symmetrically (function at ~683–705). The current UPDATE is input-keyed and skips adopted rows: their immutable `host_accepted_input_id` is the OLD input, so releasing the turn's NEW input cannot match them (V3 probe D: `changes=1`, adopted row still LIVE) — and the same lease's next bind that includes a still-pending adopted row then hits 3d's LIVE-mismatch throw, recreating the fixed rejection class within-life. Replace (~695–698):

```ts
    db.prepare(
      `UPDATE messages_in SET host_acceptance_ended_at = ?
        WHERE host_accepted_input_id = ? AND host_acceptance_ended_at IS NULL`,
    ).run(endedAt, inputId);
```

with:

```ts
    // Close EVERY open interval, not just rows first-accepted under the
    // released input: adopted rows keep their immutable OLD
    // host_accepted_input_id, and an input-keyed close leaves their reopened
    // intervals live past the turn boundary. Same single-live-actor
    // justification as the bind-side broadened close (A2): one lease per
    // session, one container per session, so every open interval at release
    // time belongs to the turn being released. endedAt here is the request's
    // release time, which is >= every open row's host_accepted_at (the
    // authenticated handler validates releasedAt against the accepted
    // interval), preserving the ended_at >= accepted_at invariant.
    db.prepare(
      `UPDATE messages_in SET host_acceptance_ended_at = ?
        WHERE host_accepted_at IS NOT NULL AND host_acceptance_ended_at IS NULL`,
    ).run(endedAt);
```

Keep the `inputId` parameter and its pointer-unlink/receipt uses unchanged. The other production caller (`src/yente/operator-gws-session.ts:255`) passes its exact stop time and benefits identically; no call-site change is needed.

- [ ] **Step 4: Run the new tests and the full host GWS test file**

```bash
pnpm exec vitest run src/gws-correlation-ipc.test.ts
```
Expected: ALL tests PASS (the 15 pre-existing + 7 new). If `atomically advances from the exact first accepted input...` (~145) or the lifecycle-barrier tests fail, the close-broadening (3c) or reopen guard (3e) is wrong — fix before proceeding.

- [ ] **Step 5: Recovery-pipeline regression — an interrupted adopted mixed-batch turn recovers through the real host-sweep entry points**

Falsified-A3 gate (test-gated residual from the assumption ledger): adoption keeps the immutable original triple, so ONE interrupted adopted turn's claims split into ≥2 partitions keyed `inputId\0routeKey\0acceptedAt` (`partitionGwsClaims`, `host-sweep.ts` ~1089) — `gwsDiscoveryScope` (~1005) returns `{}` when `partitions.length !== 1`, and `sealAndDrainAcceptedGwsClaims` (~1135) seals per partition. The split is EXPECTED AND SAFE — one partition per immutable original input triple, and prior-life partitions were already reconciled at the prior life's confirmed stop (A1) — but it must be pinned as non-throwing (V3's probe drove exactly these entry points). Add to `src/host-sweep.test.ts`, inside the describe that owns `setupSession()` (~968) and `addAcceptedClaim()` (~1020) — the existing `sealAndDrainAcceptedGwsClaims` test at ~1659 is the harness reference:

```ts
  it('recovers an interrupted adopted mixed-batch turn without throwing (multi-partition split expected)', async () => {
    const { inPath, outPath } = setupSession();
    const inDb = new Database(inPath);
    const outDb = new Database(outPath);
    // Post-fix row shapes: the adopted row keeps its immutable ORIGINAL triple
    // (prior-life input + old acceptedAt) with a reopened (NULL-ended) interval;
    // the trigger row is accepted under the current input. Both hold
    // 'processing' claims from the interrupted turn.
    const adopted = addAcceptedClaim(inDb, outDb, {
      messageId: 'm-adopted-mix',
      inputId: 'in-prior-life',
      routeKey: 'opencode|discord|chan-mix|dm:mg-mix',
      acceptedAt: '2026-07-25T10:00:00.000Z',
    });
    const fresh = addAcceptedClaim(inDb, outDb, {
      messageId: 'm-trigger-mix',
      inputId: 'in-current',
      routeKey: adopted.routeKey,
      acceptedAt: '2026-08-01T09:00:00.000Z',
    });
    // One turn => two partitions after adoption: default discovery collapses to
    // the empty scope (fail-closed default — unchanged), and seal/drain must
    // complete per partition instead of throwing the malformed-acceptance error.
    expect(gwsDiscoveryScope(inDb, outDb)).toEqual({});
    const sealed: Array<{ inputId: string; routeKey: string }> = [];
    const receipts = await sealAndDrainAcceptedGwsClaims({
      inDb,
      outDb,
      stoppedAt: '2026-08-01T09:30:00.000Z',
      env: {
        GWS_CONTROL_SOCKET: '/srv/gws-proxy/control/control.sock',
        GWS_FINALIZE_TOKEN_FILE: '/run/credentials/nanoclaw.service/gws-finalize-token',
      },
      sealAndDrain: async (request) => {
        sealed.push({ inputId: request.inputId, routeKey: request.routeKey });
        return { inputId: request.inputId, routeKey: request.routeKey, sealed: true, drained: true };
      },
    });
    expect(receipts).toHaveLength(2); // one per immutable original input triple
    expect(sealed.map((entry) => entry.inputId).sort()).toEqual([fresh.inputId, adopted.inputId].sort());
    inDb.close();
    outDb.close();
  });
```

`gwsDiscoveryScope` and `sealAndDrainAcceptedGwsClaims` are already imported in this file (~36/~43). Run:

```bash
pnpm exec vitest run src/host-sweep.test.ts -t 'adopted mixed-batch'
pnpm exec vitest run src/host-sweep.test.ts
```

Expected: PASS — with Step 3's `closedAt` stamp in place, no post-fix shape produces a past-dated `ended_at`, so the `:1122–1126` malformed-acceptance throw has no trigger, and the multi-partition split seals cleanly. **Specified fallback if it fails** (e.g. a fail-closed gate inside `strictAcceptedGwsRecoveryPlan`/`recoverGwsClaimPartitions` fires on the prior-life partition): make host-sweep TOLERATE already-reconciled prior-life partitions (e.g. treat a partition whose scope predates the current interval bookkeeping and whose side effects are already reconciled as seal-only/skippable) — do NOT weaken first-acceptance triple immutability to force a single partition. Record which branch was taken in the commit body.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm exec tsc --noEmit
git add src/gws-correlation-ipc.ts src/gws-correlation-ipc.test.ts
git commit -m "fix(gws): permit durable re-acceptance of rows whose acceptance interval has ended"
git add src/host-sweep.test.ts
git commit -m "test(host-sweep): pin recovery of an interrupted adopted mixed-batch turn (multi-partition split)"
```

---

### Task 2: Host — derive `originalAcceptedAt` from the durable row + authenticated-level regression

**Files:**
- Modify: `src/gws-correlation-ipc.ts` (interface `AcceptedLeaseInput` ~98; function `processAuthenticatedGwsCorrelationRequest` ~814–890)
- Test: `src/gws-correlation-ipc.test.ts` (inside the existing `describe('authenticated GWS correlation acceptance lease')` ~232, which provides the `request()`/`process()` signed-request factories, seeded rows `m-active`/`m-future`, outbound DB with `processing_ack` claim `claim-active`, and lease `lease-host-issued-1`)

**Interfaces:**
- Consumes: Task 1's `bindAcceptedGwsCorrelation` behavior; `openInboundDb(dbPath)` from `./db/session-db.js` (already imported at ~line 8).
- Produces: `processAuthenticatedGwsCorrelationRequest` behavior change — for a bind whose `inputId` is unknown to the in-memory lease map but already durably accepted in the inbound DB, the host derives the effective `originalAcceptedAt` from the row's `host_accepted_at` (skipping the `originalAcceptedAt === providerAcceptance.acceptedAt` requirement) and passes THAT to `bindAcceptedGwsCorrelation` as `acceptedAt` — while ALWAYS passing `closedAt: request.providerAcceptance.acceptedAt` (the request's current time, freshness-validated at ~849–855; it is the in-scope current-time string — `opts.now` is only parsed to `nowMs`, never retained) so a pointer-advance close is never past-dated by the derived value. New private module function `readDurableOriginalAcceptance(dbPath: string, inputId: string): string | undefined`. `AcceptedLeaseInput` gains required field `durableAcceptedAt: string` (the value used for DB stamping; equals `originalAcceptedAt` unless derived). Wire protocol and request validation are UNCHANGED.

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

Then in the `bindAcceptedGwsCorrelation({...})` call (~868–880), change `acceptedAt: request.originalAcceptedAt` to `acceptedAt: effectiveOriginalAcceptedAt` AND add `closedAt: request.providerAcceptance.acceptedAt,` — the request's current time (freshness-validated at ~849–855; `opts.now` is only parsed to `nowMs` and not retained as a string, so `providerAcceptance.acceptedAt` is the in-scope value). Precede the call with this comment (implementation, not just plan prose):

```ts
    // For DB-known inputs the signed originalAcceptedAt becomes advisory: the
    // host stamps its own durable value. Anti-replay/authenticity are carried
    // by the MAC + per-lease sequence + active-lease marker +
    // exactProcessingClaim + the freshness window above (A13) — none of which
    // this weakens. closedAt is the request's current time so a pointer-advance
    // close can never be past-dated by a derived-old acceptedAt (a past-dated
    // ended_at would hard-fail host-sweep recovery — see bindAcceptedGwsCorrelation).
```

And in the `state.acceptedInputs.set(request.inputId, {...})` (~881–887) add `durableAcceptedAt: effectiveOriginalAcceptedAt,` alongside the existing `originalAcceptedAt: request.originalAcceptedAt` (the map keeps storing what the container will resend, so the in-lease replay check at ~858–862 stays correct, while DB stamping stays on the durable time).

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

**Interfaces:**
- Consumes: `CodexProvider(options, queryDependencies)` — 2nd ctor arg `CodexQueryDependencies` with seams `syncManagedSkillLinks`, `writeMcpConfig`, `createConfigOverrides`, `spawnServer`, `attachAutoApproval`, `initializeServer`, `startThread`, `terminateServer` (codex.ts ~326–357). `ProviderQuiescenceError` from `./types.js` (supports `cause` via `ErrorOptions`).
- Produces: when the `gen()` try body exits with an exception AND teardown also throws, `query.events` rejects with the ORIGINAL body error object (type preserved), with the `ProviderQuiescenceError` attached — as `cause` if the original has none, else as a `quiescenceFailure` property. The quiescence promise (awaited by `query.abort()`) still rejects with the `ProviderQuiescenceError` (via `failQuiescence`, unchanged). When the body exits cleanly, behavior is unchanged (teardown failure still throws the quiescence error). Task 5 mirrors this contract for opencode. Task 6 (the poll-loop finally fix) relies on the poll-loop now RECEIVING the original error type from `query.events` and extends the same attach-don't-replace contract to the second mask — this provider-level unmask alone does NOT make the graceful `poll-loop.ts` ~745 path reachable (falsified A6/A10: `processQuery`'s finally replaces the body error with the abort-await quiescence rejection).

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

**Former Steps 5–6 (the `integration.test.ts` e2e with the real `CodexProvider`) have MOVED to Task 6.** Reason (falsified A6/A14 — V4/V9 executed spikes): with the always-throwing `terminateServer`, `query.abort()` rejects, and `processQuery`'s finally (`poll-loop.ts` ~1721–1776) throws that rejection, replacing the unmasked body error — so the e2e's graceful outcome is unreachable until the poll-loop finally fix lands; `poll-loop.test.ts` ~4436 currently PINS the fatal outcome for exactly that shape. The provider-level test above (Step 1) stays here: it proves this task's own contract at the `query.events` boundary.

- [ ] **Step 5: Fix the version-comment drift (comments only)**

In `container/agent-runner/src/providers/codex-app-server.ts`, three stale references say `0.139.0`; the deployed pin is `0.144.1` (`container/Dockerfile:24 ARG CODEX_VERSION=0.144.1`). Update the version string in each comment, leaving the surrounding prose intact:
- ~462: `the pinned 0.139.0 app-server sends the canonical v2 signal` → `the pinned 0.144.1 app-server sends the canonical v2 signal`
- ~584: `verified against the bundled codex-cli 0.139.0 native binary's embedded protocol types` → `... codex-cli 0.144.1 native binary's embedded protocol types`
- ~589: "Shapes verified with `codex app-server generate-ts` from codex-cli 0.139.0" → `... from codex-cli 0.144.1`

- [ ] **Step 6: Typecheck and commit**

```bash
cd /home/dan/code/nanoclaw-reboot-resilience/.worktrees/gws-reacceptance
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
git add container/agent-runner/src/providers/codex.ts container/agent-runner/src/providers/codex-error-masking.test.ts
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

### Task 6: Container — poll-loop: stop replacing the in-flight body error in `processQuery`'s finally (pre-accept only)

**Files:**
- Modify: `container/agent-runner/src/poll-loop.ts` (`processQuery`'s finally, ~1721–1776; verify exact lines before editing)
- Modify: `container/agent-runner/src/poll-loop.test.ts` (two new tests; the pinned test at ~4436 re-verified/annotated)
- Modify: `container/agent-runner/src/integration.test.ts` (e2e moved here from Task 4)

**Why this task exists (falsified A6/A10/A14):** even after Tasks 4–5, `processQuery`'s catch (~1565–1574) *unconditionally* calls `abortQuery()` on any stream failure, and the finally (~1721–1773) awaits `abortPromise`, captures its rejection as `quiescenceFailure`, recovery-owns the uncertain rows (`provider_quiescence_unproven`, ~1746) and THROWS it (~1773; ~1774–1776 wraps even non-quiescence rejections) — a throw from a finally REPLACES the in-flight body error. Since codex's `abort()` always rejects post-spawn, the graceful routing at ~745/~761 is dead code for the production class until THIS fix lands (V4/V9 executed spikes), and the moved e2e is unreachable without it.

**Interfaces:**
- Consumes (all in scope inside the finally): `providerStreamFailure` (declared ~1372, set ~1566), `abortPromise`, `boundGwsInputs` (~1077, alias of `ledgerCtx.acceptanceContext.boundGwsInputs`; entries added at bind success `:969` and lifecycle fault `:978`, removed only by successful release `:1782` — and the release loop `:1779–1794` never runs on the quiescence path), `ledger`, `log`. Tasks 4/5's attach contract (`cause` if unset, else `quiescenceFailure` property).
- Produces: when the abort-await rejects AND a non-quiescence body error is in flight AND nothing was host-committed for this query (`boundGwsInputs.size === 0` — the reliable discriminator; `acceptanceObserved` is NOT one, per falsified A11), the finally attaches the quiescence failure to the body error and rethrows the ORIGINAL body error, and NO `provider_quiescence_unproven` recovery entry is written for that case — the rows were already returned to pending at ~1710 and must STAY pending (V4 showed the current code immediately re-owns them into recovery). When anything WAS host-committed (`boundGwsInputs` nonempty) or the body error is itself a `ProviderQuiescenceError`, behavior is UNCHANGED: recovery-own + throw the quiescence failure (A7-verified intentional protection of accepted work). Task 7's guard reuses the same discriminator.

**Multi-claim caveat for the implementer:** `boundGwsInputs` covers the initial claim AND followups (both flow through `createInputClaim` → `ctx.bind` → `ctx.boundGwsInputs.add`). V4 verified its accuracy for the initial-claim path only — VERIFY the followup topology while implementing (a followup bound while the initial is unbound must count as host-committed; a nonempty set gives the conservative fatal outcome, which is correct). If you find any bind path that does not add to `boundGwsInputs`, STOP and fix that first.

- [ ] **Step 1: Write the failing pre-accept graceful test**

In `poll-loop.test.ts`, inside `describe('provider finalization barriers')` (~4073), add a sibling of the ~4436 test (`always awaits provider abort after a raw stream failure and never releases on failed quiescence`) reusing its `insertMessage` + inline-provider + `Promise.race` settle-probe wiring. Important harness fact: the file's `runPollLoop` wrapper (~52–100) awaits `input.acceptInput()` before iterating provider events, and its default no-op bind SUCCEEDS — i.e. HOST-COMMITS. For the pre-accept shape, pass an explicitly FAILING `bindGwsCorrelation` so nothing commits and the body error is the loop's own `TrustedInputAcceptanceError`:

```ts
  it('continues gracefully when a pre-accept bind failure coincides with a rejecting abort (nothing host-committed)', async () => {
    insertMessage(
      'preaccept-unmask-init',
      'chat',
      { sender: 'User', text: 'run once' },
      { platformId: 'chan-preaccept-unmask', channelType: 'discord' },
    );
    let abortCalls = 0;
    let bindCalls = 0;
    let releaseCalls = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        return {
          push() {},
          end() {},
          abort: async () => {
            abortCalls++;
            throw new ProviderQuiescenceError('post-spawn teardown quiescence unproven');
          },
          events: (async function* (): AsyncGenerator<ProviderEvent> {
            // Never reached: the gated wrapper's acceptInput() rejects first.
          })(),
        };
      },
    };
    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
      bindGwsCorrelation: async () => {
        bindCalls++;
        throw new Error('host bind unavailable');
      },
      releaseGwsCorrelation: async () => {
        releaseCalls++;
      },
    });
    // Observe rejection immediately: bun:test attributes an unhandled loop
    // rejection to the running test (the pattern the ~4352 test uses).
    void loopPromise.catch(() => {});
    const settled = await Promise.race([
      loopPromise.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 350)),
    ]);
    expect(settled).toBe('timeout'); // graceful continuation — the loop did NOT die on the abort rejection
    expect(bindCalls).toBeGreaterThanOrEqual(1);
    expect(abortCalls).toBe(1);
    expect(releaseCalls).toBe(0); // never release on failed quiescence — invariant unchanged
    expect(getAckStatus('preaccept-unmask-init')).not.toBe('recovery'); // returned to pending, NOT recovery-owned
    controller.abort();
    await loopPromise.catch(() => {});
  });
```

- [ ] **Step 2: Write the post-acceptance still-fatal guard test**

Sibling test — the falsified-A11 shape: bind committed, echo missing, then a body error with a rejecting abort. This pins that the new branch does NOT weaken accepted-work protection (it may already pass pre-fix; keep it as the guard):

```ts
  it('still exits fatally when a body error follows a host-committed bind (echo missing) and abort rejects', async () => {
    insertMessage(
      'postcommit-quiescence-init',
      'chat',
      { sender: 'User', text: 'run once' },
      { platformId: 'chan-postcommit-quiescence', channelType: 'discord' },
    );
    let bindCalls = 0;
    const provider: AgentProvider = {
      supportsNativeSlashCommands: false,
      isSessionInvalid: () => false,
      query() {
        return {
          push() {},
          end() {},
          abort: async () => {
            throw new ProviderQuiescenceError('abort quiescence unproven');
          },
          events: (async function* (): AsyncGenerator<ProviderEvent> {
            // The gated wrapper already awaited acceptInput() (bind committed).
            // Fail BEFORE any input-accepted echo: acceptanceObserved stays
            // false while boundGwsInputs is nonempty (falsified A11).
            throw new Error('stream died after the host commit');
          })(),
        };
      },
    };
    const controller = new AbortController();
    const loopPromise = runPollLoop({
      provider,
      providerName: 'test',
      cwd: '/tmp',
      signal: controller.signal,
      bindGwsCorrelation: async () => {
        bindCalls++;
      },
      releaseGwsCorrelation: async () => {},
    });
    void loopPromise.catch(() => {});
    await expect(loopPromise).rejects.toBeInstanceOf(ProviderQuiescenceError);
    expect(bindCalls).toBe(1);
    expect(getAckStatus('postcommit-quiescence-init')).toBe('recovery'); // accepted work stays recovery-owned (A7)
    controller.abort();
  });
```

- [ ] **Step 3: Re-verify the pinned test at ~4436 and annotate it (intended-behavior-change callout)**

Read `always awaits provider abort after a raw stream failure and never releases on failed quiescence` (~4436). Through the gated wrapper its DEFAULT no-op bind succeeds before the stream failure, so that test is actually the HOST-COMMITTED shape under the new discriminator — its fatal assertions (`settled === 'rejected'`, `releaseCalls === 0`, ack `'recovery'`) remain correct and must stay green unchanged. Update its comments/title to say it pins the post-commit branch (the raw-stream-failure-with-NOTHING-committed shape now continues gracefully — Step 1's test). If your implementation makes ~4436 fail, your discriminator is wrong (keyed on something other than host commitment) — fix the code, not the test. Call out in the commit body that the pre-accept fatal previously pinned by this class of test is an intended behavior change.

- [ ] **Step 4: Run to verify the failing state**

```bash
cd container/agent-runner && bun test src/poll-loop.test.ts -t 'pre-accept bind failure coincides'
bun test src/poll-loop.test.ts -t 'body error follows a host-committed bind'
```
Expected: Step 1's test FAILS (`settled` is `'rejected'` — the finally replaced the bind failure with the quiescence rejection, and the row lands recovery-owned); Step 2's test PASSES already (record that — it is the guard).

- [ ] **Step 5: Implement in `poll-loop.ts`**

In `processQuery`'s finally, insert the pre-accept branch at the head of the `if (quiescenceFailure) {` block (~1733), BEFORE the recovery-ownership section, leaving everything else in the block untouched:

```ts
    if (quiescenceFailure) {
      // PRE-ACCEPT UNMASK (companion to the provider-level unmask): when a
      // non-quiescence body error is in flight and NOTHING was host-committed
      // for this query, the abort-await's rejection must not replace it — the
      // outer catch's designed pre-accept routing (TrustedInputAcceptanceError
      // → return-to-pending + poll backoff; other pre-accept errors → durable
      // retry schedule) is the correct disposition. boundGwsInputs is the
      // host-commit discriminator: entries are added on bind success and
      // lifecycle fault and removed only by successful release —
      // acceptanceObserved is NOT reliable here (bind success does not set it).
      // The rows were already returned to pending above and STAY pending: no
      // provider_quiescence_unproven recovery entry for this case. Accepted
      // work keeps the fatal path below — that protection is intentional.
      const bodyErrorInFlight =
        providerStreamFailure !== undefined && !(providerStreamFailure instanceof ProviderQuiescenceError);
      if (bodyErrorInFlight && boundGwsInputs.size === 0) {
        const failure =
          quiescenceFailure instanceof ProviderQuiescenceError
            ? quiescenceFailure
            : new ProviderQuiescenceError('provider did not prove quiescence before correlation release', {
                cause: quiescenceFailure,
              });
        if (providerStreamFailure instanceof Error && providerStreamFailure.cause === undefined) {
          (providerStreamFailure as Error & { cause?: unknown }).cause = failure;
        } else if (providerStreamFailure instanceof Error) {
          (providerStreamFailure as Error & { quiescenceFailure?: unknown }).quiescenceFailure = failure;
        }
        log(
          JSON.stringify({
            severity: 'warn',
            event: 'preaccept_body_error_kept_over_quiescence_failure',
            error:
              providerStreamFailure instanceof Error ? providerStreamFailure.message : String(providerStreamFailure),
            quiescence_error: failure.message,
          }),
        );
        // Rethrow the ORIGINAL body error: throwing from this finally replaces
        // the in-flight copy with the same object — identity preserved, so the
        // outer catch's instanceof routing works (Tasks 4/5 contract).
        throw providerStreamFailure;
      }
      const uncertainEntries = [...ledger.values()].filter((entry) =>
```

(The final line above is the existing first line of the block — anchor there; do not duplicate it.)

- [ ] **Step 6: Run the poll-loop suite**

```bash
cd container/agent-runner && bun test src/poll-loop.test.ts
```
Expected: ALL PASS — Step 1's test now sees graceful continuation; Step 2's and the ~4436 host-committed tests stay fatal/recovery-owned; the finalization-barrier tests (~4073–end) are post-acceptance shapes and must be unaffected.

- [ ] **Step 7: Move the poll-loop e2e regression here (graceful path with the REAL CodexProvider)**

This is the e2e formerly specified as Task 4 Steps 5–6 — it passes only now (A14/V9). In `container/agent-runner/src/integration.test.ts`: first read the existing test `cancels before model output and backs off when trusted input binding fails` (~210) — reuse its exact loop-runner (`runProductionPollLoop` called directly), config, `insertMessage`, `waitFor`/`sleep`, and pending/undelivered assertions. Add a sibling test that swaps in a real `CodexProvider` with fake deps (imports: `CodexProvider` from `./providers/codex.js`, `ProviderQuiescenceError` from `./providers/types.js`, plus a local `queryServer()` helper identical to Task 4 Step 1's):

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
    // the '~210' test — it is the canonical way this file runs and stops the
    // loop. ALSO attach `void loopPromise.catch(() => {});` at creation:
    // bun:test fails the running test on an unhandled loop rejection (V9).
    // Assertions (same shape as the '~210' test):
    await waitFor(() => bindAttempts === 1, 1000);
    await sleep(100);
    expect(bindAttempts).toBe(1); // durable backoff, no hot retry loop
    expect(getPendingMessages().map((m) => m.id)).toContain('m-codex-bind-fail'); // returned to pending, not fatal
  });
```

The loop-invocation lines marked by the comment must be copied from the ~210 test verbatim (same helper names, same signal/timeout handling). The NEW assertions are exactly the three `expect`s above. Critically, the loop promise must NOT reject with `ProviderQuiescenceError` — if the ~210 test asserts on the loop promise, mirror that assertion here expecting graceful continuation.

```bash
cd container/agent-runner && bun test src/integration.test.ts
```
Expected: ALL PASS (this test fails without Step 5's fix — if you want proof, `git stash` the poll-loop.ts change, run, unstash).

- [ ] **Step 8: Typecheck and commit**

```bash
cd /home/dan/code/nanoclaw-reboot-resilience/.worktrees/gws-reacceptance
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
git add container/agent-runner/src/poll-loop.ts container/agent-runner/src/poll-loop.test.ts container/agent-runner/src/integration.test.ts
git commit -m "fix(poll-loop): keep the pre-accept body error instead of replacing it with the abort quiescence rejection" -m "Intended behavior change: a raw stream failure with NOTHING host-committed no longer exits fatally recovery-owned; it propagates the original error to the designed pre-accept routing (return-to-pending / durable retry schedule). Host-committed work keeps the fatal quiescence protection (A7). The previously pinned fatal for the nothing-committed shape is superseded by the new pre-accept graceful test."
```

---

### Task 7: Container — belt-and-braces: persist the pre-accept retry schedule (host-commit-guarded) before a fatal quiescence rethrow

**Files:**
- Modify: `container/agent-runner/src/poll-loop.ts` (the catch block, ~736–743)
- Test: `container/agent-runner/src/poll-loop.test.ts`

**Interfaces:**
- Consumes: in-scope at the ~743 rethrow site: `err`, `errMsg`, `initialClaim` (`InputClaimBatch | undefined`, field `acceptanceObserved: boolean`), `acceptanceContext` (declared ~514 in the same function scope; its `boundGwsInputs` is the same set Task 6's discriminator uses), `config.providerName`, `activeRouteKey`, `topLevelInputId`, `withSqliteRetry`, `scheduleProviderRetry(providerName, routeKey, nowMs, triggerInputId)` from `./db/session-state.js` (already imported; bounded: 10 attempts, exp backoff capped 30 s, then durably `exhausted`), `log`. `readProviderRetrySchedule(providerName, routeKey)` for the test.
- Produces: when a `ProviderQuiescenceError` reaches the fatal rethrow with `initialClaim?.acceptanceObserved === false` AND `acceptanceContext.boundGwsInputs.size === 0` (nothing observed AND nothing host-committed — the same discriminator as Task 6; A11 falsified the `acceptanceObserved`-only guard, since bind success sets `state='accepted'` + `boundGwsInputs.add` WITHOUT setting `acceptanceObserved`), the durable retry schedule is written first, then the error is rethrown unchanged. Host-committed/echo-missing exits, `TrustedInputLifecycleError`, and post-acceptance quiescence exits get NO schedule — retrying a host-committed input from a fresh container is the duplicate-work case, and those rows are already recovery-owned (dual ownership would result).

- [ ] **Step 1: Write the failing test**

In `poll-loop.test.ts`, find `describe('provider finalization barriers')` (~4073) and the existing test `exits fatally and retains correlation when provider quiescence cannot be proved` (~4199) — read it first for the message/route/provider-name conventions. **Harness caution:** that test runs through the file's gated `runPollLoop` wrapper (~52–100), which awaits `input.acceptInput()` with a default no-op bind that SUCCEEDS — i.e. host-commits, which the new guard must treat as no-schedule. For the pre-accept schedule test, call `runProductionPollLoop` DIRECTLY (already imported at ~38) with explicit no-op `bindGwsCorrelation`/`releaseGwsCorrelation` and a RAW provider that never calls `acceptInput` — then `boundGwsInputs` stays empty and the PQE body error is a genuine nothing-committed fatal. Add the tests as siblings; ensure `readProviderRetrySchedule` is imported from `./db/session-state.js` and `ProviderQuiescenceError` from `./providers/types.js`:

```ts
  it('persists a bounded pre-accept retry schedule before a fatal quiescence exit', async () => {
    // Insert one pending trigger message and stamp its host input/route using
    // the ~4199 test's message/route/provider-name conventions. Run the loop
    // via runProductionPollLoop DIRECTLY (no gated wrapper — see the caution
    // above) with explicit no-op bindGwsCorrelation/releaseGwsCorrelation and
    // this RAW provider, whose event stream rejects with
    // ProviderQuiescenceError BEFORE acceptInput is ever called — so nothing is
    // observed AND nothing is host-committed (boundGwsInputs stays empty):
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
    // Run the loop via runProductionPollLoop with an AbortController signal and
    // no-op bind/release, attach `void loopPromise.catch(() => {});` at
    // creation, and assert the SAME fatal exit as ~4199:
    // await expect(loopPromise).rejects.toBeInstanceOf(ProviderQuiescenceError);
    // NEW assertion — the durable schedule exists for the next incarnation
    // (use the same provider name and route key the copied wiring uses; the
    // schedule-asserting tests at ~4489/4540 show the exact naming):
    const schedule = readProviderRetrySchedule(PROVIDER_NAME, ROUTE_KEY);
    expect(schedule?.attempts).toBe(1);
    expect(schedule?.status).toBe('scheduled');
  });

  it('does NOT persist a retry schedule when the bind host-committed (echo missing) before the quiescence exit', async () => {
    // The falsified-A11 shape, reusing Task 6 Step 2's exact wiring (gated
    // runPollLoop wrapper, default succeeding bind, events throw a plain Error
    // before any input-accepted echo, abort rejects ProviderQuiescenceError)
    // with a DISTINCT message id / platformId / route. The loop still exits
    // fatally (Task 6 keeps host-committed work fatal) and the rows are
    // recovery-owned — the guard must not add a duplicate-work schedule:
    // await expect(loopPromise).rejects.toBeInstanceOf(ProviderQuiescenceError);
    expect(readProviderRetrySchedule(PROVIDER_NAME, ROUTE_KEY_2)).toBeUndefined();
  });
```

`PROVIDER_NAME` / `ROUTE_KEY` / `ROUTE_KEY_2` stand for the provider name and route keys the copied wiring uses (the ~4199 test and the schedule-asserting tests at ~4489/4540 — `durably backs off a provider failure before input-accepted and emits one bounded user error` — are the naming reference; substitute their literal values).

- [ ] **Step 2: Run to verify it fails**

```bash
cd container/agent-runner && bun test src/poll-loop.test.ts -t 'persists a bounded pre-accept retry schedule'
```
Expected: the first test FAILS — `schedule` is `undefined` (nothing persisted before the fatal rethrow). The second test may already pass (record that; it is the guard against the A11 regression).

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
        if (
          err instanceof ProviderQuiescenceError &&
          initialClaim?.acceptanceObserved === false &&
          acceptanceContext.boundGwsInputs.size === 0
        ) {
          // Belt-and-braces: nothing was observed AND nothing was host-committed,
          // so this fatal exit must leave a durable, bounded retry schedule
          // behind for the next runner incarnation instead of an unbounded
          // crash loop on the route. acceptanceObserved alone is NOT a
          // host-commit discriminator (bind success sets state='accepted' +
          // boundGwsInputs.add without setting it — A11); retrying a
          // host-committed input from a fresh container is the duplicate-work
          // case, and its rows are already recovery-owned. Same discriminator
          // as processQuery's pre-accept unmask branch.
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
Expected: ALL PASS — in particular the finalization-barrier tests at ~4073–end (their quiescence exits happen post-acceptance or post-commit — `acceptanceObserved === true` or `boundGwsInputs` nonempty — so no schedule is written for them; if one now fails on an unexpected schedule, the guard condition is wrong).

Scope note: the graceful pre-accept path introduced by Task 6 (bind failure → return-to-pending → in-process poll backoff at ~745–759) has NO durable cross-wake schedule — by design it never leaves the process. It is bounded in practice because host-side acceptance now succeeds on retry (Tasks 1–2), with Task 3's host-side warn log as the visibility net if a route's binds keep failing. This task's schedule covers only quiescence-TYPED pre-accept fatals (the body error itself a `ProviderQuiescenceError` with nothing committed).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /home/dan/code/nanoclaw-reboot-resilience/.worktrees/gws-reacceptance
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
git add container/agent-runner/src/poll-loop.ts container/agent-runner/src/poll-loop.test.ts
git commit -m "fix(poll-loop): persist the pre-accept retry schedule (host-commit-guarded) before a fatal quiescence exit"
```

---

### Task 8: Full verification gates

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
Expected: every command exits 0. Host test count ≥ 1,119 + the ~12 new tests (Task 1: 7 in `gws-correlation-ipc.test.ts` + 1 in `host-sweep.test.ts`; Task 2: 3; Task 3: 1); container count ≥ 419 + the ~7 new tests (Task 4: 1; Task 5: 1; Task 6: 2 poll-loop + 1 integration e2e; Task 7: 2). `format:check` failures: run `pnpm run format:fix` and re-run. Lint failures around the new host code: most likely `preserve-caught-error` — ensure every wrap carries `{ cause: err }` (note: the Task 4/5 pattern rethrows the ORIGINAL error, which satisfies the rule; the attachment property is additive).

- [ ] **Step 2: Verify the acceptance-critical behaviors one more time by name**

```bash
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 're-binds the same input'
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'hinda signature'
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'LIVE'
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'release after adoption'
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'stamps the explicit closedAt'
pnpm exec vitest run src/gws-correlation-ipc.test.ts -t 'dvora/hinda regression'
pnpm exec vitest run src/host-sweep.test.ts -t 'adopted mixed-batch'
(cd container/agent-runner && bun test src/providers/codex-error-masking.test.ts && bun test src/poll-loop.test.ts -t 'pre-accept bind failure coincides' && bun test src/poll-loop.test.ts -t 'host-committed bind' && bun test src/integration.test.ts -t 'codex bind failure' && bun test src/poll-loop.test.ts -t 'persists a bounded pre-accept')
```
Expected: all PASS.

- [ ] **Step 3: Commit any straggler fixes**

```bash
git status --short   # should be clean; if format:fix touched files:
git add -A && git commit -m "chore: formatting fixes from format:fix"
```

---

## Self-Review (re-run after incorporating the validated findings)

**1. Spec coverage:**
- Fix 1 same-input re-bind → Task 1 (conflict relaxation + reopen UPDATE) + Task 2 (derivation). Mixed-batch adoption → Task 1 + Task 2 regression test. Companion derivation → Task 2 (now also threading `closedAt: request.providerAcceptance.acceptedAt`). Fail-closed for live conflicts kept → Task 1 (code comment + dedicated test), with the safety carrier corrected to LEASE ADMISSION per verified A1 (constraints section, key facts, 3d comment, and the pin-in-tests note). First-acceptance immutability → asserted in every re-bind/adoption test. Falsified A3 → Task 1's explicit `closedAt` (never a derived-old `acceptedAt`; invariant `ended_at ≥ accepted_at` stated and tested) + the Step 5 recovery-pipeline regression through the real `gwsDiscoveryScope`/`sealAndDrainAcceptedGwsClaims` entry points, with the multi-partition split pinned as expected-and-safe. Falsified A4 → Task 1 3f broadened release + the release-after-adoption test.
- Fix 2 unmask codex → Task 4; opencode → Task 5 (hazard confirmed at ~1441–1448, not ~455).
- Fix 3 (NEW task — exists because A6/A10/A14 were FALSIFIED): the provider-level unmask alone leaves the graceful ~745 path dead code — `processQuery`'s finally replaces the body error with the abort-await quiescence rejection and recovery-owns the rows. Task 6 fixes the second mask for the pre-accept case only (discriminator: `boundGwsInputs` empty — NOT `acceptanceObserved`, per falsified A11), keeps post-commit fatality (verified A7), and now hosts the real-CodexProvider e2e moved from Task 4 (unreachable before this fix — A14).
- Fix 4 host-side rejection logging → Task 3 (also the visibility net for the graceful pre-accept path, which deliberately has no durable cross-wake schedule — noted in Task 7).
- Fix 5 belt-and-braces schedule persistence → Task 7, guard strengthened to `acceptanceObserved === false && boundGwsInputs.size === 0` (falsified A11: bind success host-commits without setting `acceptanceObserved`; retrying a host-committed input from a fresh container is the duplicate-work case), plus the no-schedule-when-host-committed test.
- Cleanup version comments → Task 4 Step 5. Live poisoned-row disposition → rewritten from V5's live findings (22 sessions already unblocked by R2 at the cost of message loss — recovery of `failed` rows documented as an explicitly-unowned, out-of-scope ops decision; real target = ~180 stale rows / 178 DBs; drain pacing bounded by the 10-row batch cap; verification query extended with container-liveness and outbound `processing_ack` cross-checks), documented only, as required.
- Required tests: same-input re-bind after crash (Tasks 1–2), mixed-batch adoption (Tasks 1–2), live-conflict still-throws (Task 1), closedAt stamping + `ended_at ≥ accepted_at` invariant (Task 1), release-after-adoption (Task 1), recovery-pipeline multi-partition regression (Task 1 Step 5), unmasked error routing reaching the graceful paths (Task 4 Step 1 provider-level; Task 6 Steps 1+7 loop-level and e2e), post-commit fatality preserved (Task 6 Step 2 + the ~4436 pin re-verified), dvora/hinda regression end-to-end at the level the infra supports (Task 2 authenticated-request level — full HMAC/lease/sequence/DB/pointer path — plus Task 6 Step 7 for the container half; no harness drives host IPC and container poll-loop in one process, so the pair is the deepest available reproduction).
- R2 semantics ("bounded retries now SUCCEED on retry"): host-side acceptance of the retried bind is Tasks 1/2's subject; container-side graceful continuation is Task 6 (primary path for the production class — not Task 4 alone); the pre-accept schedule paths are untouched except Task 7's guarded addition. R1/R8/R9: no recovery/expiry/sanitization code changes; the one data-shape interaction A3 surfaced is neutralized by `closedAt` and pinned by the Task 1 Step 5 regression (specified fallback: teach host-sweep to tolerate already-reconciled prior-life partitions — never weaken triple immutability).

**1b. No silent deferrals:** No stubs or fakes stand in for required production behavior — provider tests use the repo's established seam-injection harnesses while exercising the real `CodexProvider`/`OpenCodeProvider`/`bindAcceptedGwsCorrelation`/`processAuthenticatedGwsCorrelationRequest`/`sealAndDrainAcceptedGwsClaims` code paths. The two spots where a finding could have been deferred are instead gated: (a) the A3.2 partition-split residual is converted into the mandatory Task 1 Step 5 regression test with a SPECIFIED fallback (tolerate already-reconciled prior partitions; do not weaken immutability); (b) the ~4436 pinned-fatal expectation change is an INTENDED behavior change, scoped precisely — re-verification shows that test's gated-wrapper bind host-commits, so its fatal assertions stay valid under the new discriminator; the previously-pinned nothing-committed fatal is superseded by Task 6 Step 1's graceful test, and the commit body must say so. No UNRESOLVED COVERAGE GAPS.

**2. Placeholder scan:** Intentional read-then-copy directives remain in Task 6 Step 7 and Task 7 Step 1 (they reference the exact existing tests to copy loop wiring from — `integration.test.ts` ~210, `poll-loop.test.ts` ~4199/~4436/~4489 — with the new logic and assertions given in full); Tasks 3/5 include fallback instructions keyed to named seams; Task 1 Step 5 names its harness helpers (`setupSession`/`addAcceptedClaim`) by line. These reference *existing repo code by name and line*, not undefined future work. No TBD/TODO/"handle edge cases" items.

**3. Type consistency:** `AcceptedRow.host_acceptance_ended_at: string | null` (Task 1) matches the SELECT; `BindAcceptedGwsCorrelationOptions.closedAt?: string` is canonicalized beside `acceptedAt` and consumed at the single close site; `AcceptedLeaseInput.durableAcceptedAt: string` (Task 2) is set at the single `state.acceptedInputs.set` site and read at the single `existing.durableAcceptedAt` site; `readDurableOriginalAcceptance(dbPath: string, inputId: string): string | undefined` matches its call; the attachment contract (`cause` if absent else `quiescenceFailure`) is identical in Task 4 code/test, Task 5 code/test, and Task 6's finally branch; `boundGwsInputs: Set<string>` is the same object at both consumption sites (`processQuery` finally via the ~1077 alias; outer catch via `acceptanceContext.boundGwsInputs`); `scheduleProviderRetry(providerName, routeKey, nowMs, triggerInputId)` in Task 7 matches `session-state.ts:147`.
