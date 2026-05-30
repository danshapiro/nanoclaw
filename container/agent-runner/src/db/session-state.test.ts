import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import {
  getAuthoritativeSideEffects,
  getSideEffectHints,
  importSideEffectLedger,
} from './side-effects.js';
import {
  appendRecoveryEntry,
  clearContinuation,
  enrichRecoveryEntry,
  getContinuation,
  listRecoveryEntries,
  markRecoveryInFlight,
  migrateLegacyContinuation,
  pruneResolvedRecoveryEntries,
  recoverMalformedRecovery,
  resolveRecoveryEntry,
  setContinuation,
  type ProviderRecoveryEntry,
  type ProviderRecoveryScope,
} from './session-state.js';

beforeEach(() => {
  initTestSessionDb();
});

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-side-effects-'));
}

function dmScope(overrides: Partial<ProviderRecoveryScope> = {}): ProviderRecoveryScope {
  return {
    providerName: 'opencode',
    routeKey: 'opencode|discord|chan-1|dm:mg-1',
    messagingGroupId: 'mg-1',
    isGroup: 0,
    platformId: 'chan-1',
    channelType: 'discord',
    threadKey: null,
    ...overrides,
  };
}

let recoverySeq = 0;
function newRecoveryEntry(scope: ProviderRecoveryScope, overrides: Partial<ProviderRecoveryEntry> = {}): ProviderRecoveryEntry {
  const now = new Date().toISOString();
  recoverySeq += 1;
  return {
    id: `rec-${recoverySeq}`,
    status: 'pending',
    classification: 'transport-timeout',
    agentMessage: 'I was interrupted and will resume.',
    fallbackUserMessage: 'Something interrupted me — please resend if needed.',
    originalTasks: [{ messageId: 'm1', text: 'do the thing', timestamp: now }],
    acceptedUnresolvedInputs: [],
    pendingFollowups: [],
    priorProgress: [],
    observations: [],
    sideEffects: [],
    continuationPolicy: 'preserve',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function seedLegacy(value: string): void {
  getOutboundDb()
    .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('sdk_session_id', value, new Date().toISOString());
}

describe('session-state — per-provider continuations', () => {
  test('set/get round-trip, case-insensitive provider key', () => {
    setContinuation('claude', 'claude-conv-1');
    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('Claude')).toBe('claude-conv-1');
    expect(getContinuation('CLAUDE')).toBe('claude-conv-1');
  });

  test('providers are isolated — switching reads the right slot', () => {
    setContinuation('claude', 'claude-conv-1');
    setContinuation('codex', 'codex-thread-xyz');

    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('codex')).toBe('codex-thread-xyz');
  });

  test('clearContinuation only affects the specified provider', () => {
    setContinuation('claude', 'keep-me');
    setContinuation('codex', 'drop-me');

    clearContinuation('codex');

    expect(getContinuation('claude')).toBe('keep-me');
    expect(getContinuation('codex')).toBeUndefined();
  });

  test('unknown provider returns undefined', () => {
    expect(getContinuation('never-used')).toBeUndefined();
  });
});

describe('session-state — legacy migration', () => {
  test('adopts legacy value into current provider when current is empty', () => {
    seedLegacy('old-session-id');

    const adopted = migrateLegacyContinuation('claude');

    expect(adopted).toBe('old-session-id');
    expect(getContinuation('claude')).toBe('old-session-id');
  });

  test('always deletes legacy row regardless of migration outcome', () => {
    seedLegacy('old-session-id');
    setContinuation('claude', 'existing');

    migrateLegacyContinuation('claude');

    // After migration the legacy key must be gone, whether or not it was adopted.
    // A subsequent migration for a different provider must not see it.
    const resultAfterSecondCall = migrateLegacyContinuation('codex');
    expect(resultAfterSecondCall).toBeUndefined();
  });

  test('prefers existing current-provider slot over legacy', () => {
    seedLegacy('legacy-value');
    setContinuation('claude', 'claude-value');

    const result = migrateLegacyContinuation('claude');

    expect(result).toBe('claude-value');
    expect(getContinuation('claude')).toBe('claude-value');
  });

  test('no legacy row — returns current provider value (possibly undefined)', () => {
    expect(migrateLegacyContinuation('claude')).toBeUndefined();

    setContinuation('codex', 'codex-value');
    expect(migrateLegacyContinuation('codex')).toBe('codex-value');
  });

  test('migration is idempotent on a second call (legacy already gone)', () => {
    seedLegacy('once');

    const first = migrateLegacyContinuation('claude');
    expect(first).toBe('once');

    const second = migrateLegacyContinuation('claude');
    expect(second).toBe('once');
  });
});

// ── Task 1 Step 1: side-effect ledger import + validation ────────────────────

describe('side_effect_ledger import', () => {
  test('imports known JSONL records idempotently keyed by audit_id', () => {
    const dir = tmpdir();
    const root = path.join(dir, 'out');
    fs.mkdirSync(root, { recursive: true });
    const artifact = path.join(root, 'summary.md');
    fs.writeFileSync(artifact, 'SUMMARY');
    const size = fs.statSync(artifact).size;

    const jsonl = [
      JSON.stringify({
        kind: 'summarize_dnd_summary_artifact',
        audit_id: 'run-1',
        operation: 'summarize',
        occurred_at: new Date().toISOString(),
        input_id: 'in-1',
        route_key: 'opencode|discord|chan-1|dm:mg-1',
        evidence: { artifact_path: artifact, size_bytes: size },
      }),
    ].join('\n');

    const r1 = importSideEffectLedger({ jsonl, allowedArtifactRoots: [root] });
    const r2 = importSideEffectLedger({ jsonl, allowedArtifactRoots: [root] });
    expect(r1.imported).toBe(1);
    expect(r2.imported).toBe(0);

    const count = (getOutboundDb().prepare('SELECT COUNT(*) AS c FROM side_effect_ledger').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test('over-detailed / unknown evidence is sanitized into a tool_completed entry without raw secrets', () => {
    const jsonl = JSON.stringify({
      kind: 'mystery_effect',
      audit_id: 'tc-1',
      occurred_at: new Date().toISOString(),
      evidence: {
        api_key: 'sk-SECRET-DO-NOT-STORE',
        email_body: 'Dear Matt, here is the whole confidential body...',
        path: '/etc/shadow',
      },
    });
    const r = importSideEffectLedger({ jsonl });
    expect(r.imported).toBe(1);

    const row = getOutboundDb().prepare('SELECT kind, evidence_json FROM side_effect_ledger WHERE id = ?').get('tc-1') as {
      kind: string;
      evidence_json: string;
    };
    expect(row.kind).toBe('tool_completed');
    expect(row.evidence_json).not.toContain('sk-SECRET-DO-NOT-STORE');
    expect(row.evidence_json).not.toContain('confidential body');
    expect(row.evidence_json).not.toContain('/etc/shadow');
  });

  test('summarize-dnd entry is authoritative only when artifact exists under an allowed root and matches size', () => {
    const dir = tmpdir();
    const root = path.join(dir, 'allowed');
    fs.mkdirSync(root, { recursive: true });
    const artifact = path.join(root, 'sum.md');
    fs.writeFileSync(artifact, 'BODY');
    const size = fs.statSync(artifact).size;

    // (a) artifact missing → not authoritative
    importSideEffectLedger({
      jsonl: JSON.stringify({
        kind: 'summarize_dnd_summary_artifact',
        audit_id: 'missing-art',
        occurred_at: new Date().toISOString(),
        evidence: { artifact_path: path.join(root, 'nope.md'), size_bytes: 10 },
      }),
      allowedArtifactRoots: [root],
    });
    // (b) outside allowed root → not authoritative
    const outside = path.join(dir, 'outside.md');
    fs.writeFileSync(outside, 'BODY');
    importSideEffectLedger({
      jsonl: JSON.stringify({
        kind: 'summarize_dnd_summary_artifact',
        audit_id: 'outside-root',
        occurred_at: new Date().toISOString(),
        evidence: { artifact_path: outside, size_bytes: fs.statSync(outside).size },
      }),
      allowedArtifactRoots: [root],
    });
    // (c) size mismatch → not authoritative
    importSideEffectLedger({
      jsonl: JSON.stringify({
        kind: 'summarize_dnd_summary_artifact',
        audit_id: 'bad-size',
        occurred_at: new Date().toISOString(),
        evidence: { artifact_path: artifact, size_bytes: size + 999 },
      }),
      allowedArtifactRoots: [root],
    });
    // (d) valid
    importSideEffectLedger({
      jsonl: JSON.stringify({
        kind: 'summarize_dnd_summary_artifact',
        audit_id: 'good',
        operation: 'summarize',
        occurred_at: new Date().toISOString(),
        evidence: { artifact_path: artifact, size_bytes: size },
      }),
      allowedArtifactRoots: [root],
    });

    const authoritative = getAuthoritativeSideEffects();
    const ids = authoritative.map((s) => s.id).sort();
    expect(ids).toEqual(['good']);
  });

  test('unsigned gmail_draft_created is NEVER authoritative (fail-closed in Task 1) but retained as a hint', () => {
    importSideEffectLedger({
      jsonl: JSON.stringify({
        kind: 'gmail_draft_created',
        audit_id: 'draft-1',
        occurred_at: new Date().toISOString(),
        evidence: { draft_id: 'r-12345' },
        // no signature → never authoritative
      }),
    });

    expect(getAuthoritativeSideEffects().some((s) => s.id === 'draft-1')).toBe(false);
    expect(getSideEffectHints().some((s) => s.id === 'draft-1')).toBe(true);
  });

  test('gmail and summarize-dnd side effects are available to recovery construction before provider tool events', () => {
    const dir = tmpdir();
    const root = path.join(dir, 'allowed');
    fs.mkdirSync(root, { recursive: true });
    const artifact = path.join(root, 'sum.md');
    fs.writeFileSync(artifact, 'BODY');
    const size = fs.statSync(artifact).size;

    importSideEffectLedger({
      jsonl: [
        JSON.stringify({
          kind: 'summarize_dnd_summary_artifact',
          audit_id: 'sum-ready',
          occurred_at: new Date().toISOString(),
          route_key: 'opencode|discord|chan-1|dm:mg-1',
          evidence: { artifact_path: artifact, size_bytes: size },
        }),
        JSON.stringify({
          kind: 'gmail_draft_created',
          audit_id: 'gmail-hint',
          occurred_at: new Date().toISOString(),
          evidence: { draft_id: 'r-1' },
        }),
      ].join('\n'),
      allowedArtifactRoots: [root],
    });

    // No provider tool event has fired; recovery can already see the validated summary.
    const authoritative = getAuthoritativeSideEffects({ routeKey: 'opencode|discord|chan-1|dm:mg-1' });
    expect(authoritative.map((s) => s.kind)).toContain('summarize_dnd_summary_artifact');
  });
});

// ── Task 1 Step 3: route-scoped recovery + lifecycle ─────────────────────────

describe('provider recovery entries', () => {
  test('entries are keyed by provider plus normalized route and read non-destructively', () => {
    const scope = dmScope();
    appendRecoveryEntry(scope, newRecoveryEntry(scope));

    const first = listRecoveryEntries(scope);
    const second = listRecoveryEntries(scope);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1); // non-destructive read

    // A different route does not see this entry.
    const otherScope = dmScope({ routeKey: 'opencode|discord|chan-2|dm:mg-2', messagingGroupId: 'mg-2', platformId: 'chan-2' });
    expect(listRecoveryEntries(otherScope)).toHaveLength(0);
  });

  test('pending -> in_flight -> resolved deletes only after successful resolution', () => {
    const scope = dmScope();
    const entry = newRecoveryEntry(scope, { acceptedUnresolvedInputs: [{ inputId: 'in-1', messageIds: ['m1'], prompt: 'do it' }] });
    appendRecoveryEntry(scope, entry);

    markRecoveryInFlight(scope, entry.id, 'in-1');
    expect(listRecoveryEntries(scope)[0].status).toBe('in_flight');
    // still present while in_flight
    expect(listRecoveryEntries(scope)).toHaveLength(1);

    const resolved = resolveRecoveryEntry(scope, entry.id, { resolvedInputIds: ['in-1'] });
    expect(resolved.resolvedMessageIds).toContain('m1');
    // resolved entries can be pruned
    pruneResolvedRecoveryEntries(scope);
    expect(listRecoveryEntries(scope).filter((e) => e.status !== 'resolved')).toHaveLength(0);
  });

  test('an in_flight entry that gets another terminal interruption is retained and enriched, not deleted', () => {
    const scope = dmScope();
    const entry = newRecoveryEntry(scope, { acceptedUnresolvedInputs: [{ inputId: 'in-1', messageIds: ['m1'], prompt: 'do it' }] });
    appendRecoveryEntry(scope, entry);
    markRecoveryInFlight(scope, entry.id, 'in-1');

    enrichRecoveryEntry(scope, entry.id, { observations: ['second interruption observed'] });

    const after = listRecoveryEntries(scope);
    expect(after).toHaveLength(1);
    expect(after[0].observations).toContain('second interruption observed');
    // It is retained as in_flight (or pending), never resolved/deleted by enrichment.
    expect(after[0].status === 'in_flight' || after[0].status === 'pending').toBe(true);
  });

  test('unresolved recovery entries are never count-pruned; only resolved/superseded are', () => {
    const scope = dmScope();
    for (let i = 0; i < 5; i++) {
      const e = newRecoveryEntry(scope);
      appendRecoveryEntry(scope, e);
      if (i < 2) {
        markRecoveryInFlight(scope, e.id, `in-${i}`);
        resolveRecoveryEntry(scope, e.id, { resolvedInputIds: [`in-${i}`] });
      }
    }
    pruneResolvedRecoveryEntries(scope, { keep: 0 });
    const remaining = listRecoveryEntries(scope);
    // Only the 3 unresolved (pending) entries survive; the 2 resolved are pruned.
    expect(remaining.every((e) => e.status !== 'resolved' && e.status !== 'superseded')).toBe(true);
    expect(remaining).toHaveLength(3);
  });

  test('excess unresolved recovery pressure fails closed without deleting recovery-owned work', () => {
    const scope = dmScope();
    for (let i = 0; i < 3; i++) appendRecoveryEntry(scope, newRecoveryEntry(scope));

    // With a tight pressure limit, appending must NOT silently discard unresolved entries.
    let threwOrFlagged = false;
    let result: { pressureExceeded?: boolean } | undefined;
    try {
      result = appendRecoveryEntry(scope, newRecoveryEntry(scope), { maxUnresolved: 3 });
    } catch {
      threwOrFlagged = true;
    }
    if (result?.pressureExceeded) threwOrFlagged = true;
    expect(threwOrFlagged).toBe(true);
    // All unresolved entries remain recoverable.
    expect(listRecoveryEntries(scope).length).toBeGreaterThanOrEqual(3);
  });

  test('malformed recovery JSON is not destructively deleted until owned rows are reconstructed', () => {
    const scope = dmScope();
    // Plant a malformed payload directly under the route's storage key.
    appendRecoveryEntry(scope, newRecoveryEntry(scope, { originalTasks: [{ messageId: 'm-keep', text: 'keep me', timestamp: new Date().toISOString() }] }));
    // Corrupt the stored JSON.
    const key = `recovery:${scope.providerName}:${scope.routeKey}`;
    getOutboundDb()
      .prepare('UPDATE session_state SET value = ? WHERE key = ?')
      .run('{not valid json', key);

    const outcome = recoverMalformedRecovery(scope);
    // Either reconstructed into a replacement entry or returned a fallback — never silently dropped.
    expect(outcome.destroyedSilently).toBe(false);
    expect(['reconstructed', 'fallback', 'returned_to_pending']).toContain(outcome.disposition);
  });
});
