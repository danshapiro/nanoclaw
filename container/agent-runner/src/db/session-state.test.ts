import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import {
  canonicalSideEffectPayload,
  classifyAndSanitize,
  getAuthoritativeSideEffects,
  getSideEffectHints,
  importSideEffectLedger,
  verifyGwsSideEffectSignature,
} from './side-effects.js';
import {
  appendRecoveryEntry,
  appendRecoveryEntryAndOwnRows,
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
function newRecoveryEntry(
  scope: ProviderRecoveryScope,
  overrides: Partial<ProviderRecoveryEntry> = {},
): ProviderRecoveryEntry {
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

  test('runtime scopes are isolated within one provider', () => {
    setContinuation('opencode', 'old-default');
    setContinuation('opencode', 'openai-session', 'openai-gpt-5.5-xhigh');
    setContinuation('opencode', 'deepseek-session', 'opencode-go-deepseek-v4-pro');

    expect(getContinuation('opencode')).toBe('old-default');
    expect(getContinuation('opencode', 'openai-gpt-5.5-xhigh')).toBe('openai-session');
    expect(getContinuation('opencode', 'opencode-go-deepseek-v4-pro')).toBe('deepseek-session');
  });

  test('clearContinuation only affects the specified provider', () => {
    setContinuation('claude', 'keep-me');
    setContinuation('codex', 'drop-me');

    clearContinuation('codex');

    expect(getContinuation('claude')).toBe('keep-me');
    expect(getContinuation('codex')).toBeUndefined();
  });

  test('clearContinuation only affects the specified runtime scope', () => {
    setContinuation('opencode', 'keep-unscoped');
    setContinuation('opencode', 'drop-scoped', 'scope-a');
    setContinuation('opencode', 'keep-scoped', 'scope-b');

    clearContinuation('opencode', 'scope-a');

    expect(getContinuation('opencode')).toBe('keep-unscoped');
    expect(getContinuation('opencode', 'scope-a')).toBeUndefined();
    expect(getContinuation('opencode', 'scope-b')).toBe('keep-scoped');
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

  test('does not adopt legacy continuation into scoped runtime config', () => {
    seedLegacy('old-session-id');

    const adopted = migrateLegacyContinuation('opencode', 'openai-gpt-5.5-xhigh');

    expect(adopted).toBeUndefined();
    expect(getContinuation('opencode', 'openai-gpt-5.5-xhigh')).toBeUndefined();
    expect(migrateLegacyContinuation('claude')).toBeUndefined();
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

    const row = getOutboundDb()
      .prepare('SELECT kind, evidence_json FROM side_effect_ledger WHERE id = ?')
      .get('tc-1') as {
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

  test('authoritative side effects are filterable by inputId so an earlier/other turn does not leak into the active turn', () => {
    const dir = tmpdir();
    const root = path.join(dir, 'allowed');
    fs.mkdirSync(root, { recursive: true });
    const artifact = path.join(root, 'sum.md');
    fs.writeFileSync(artifact, 'BODY');
    const size = fs.statSync(artifact).size;

    importSideEffectLedger({
      jsonl: [
        // An EARLIER turn's authoritative entry on a DIFFERENT route/input.
        JSON.stringify({
          kind: 'summarize_dnd_summary_artifact',
          audit_id: 'other-turn',
          occurred_at: new Date().toISOString(),
          input_id: 'in-OTHER',
          route_key: 'opencode|discord|chan-9|dm:mg-9',
          evidence: { artifact_path: artifact, size_bytes: size },
        }),
        // The ACTIVE turn's authoritative entry.
        JSON.stringify({
          kind: 'summarize_dnd_summary_artifact',
          audit_id: 'active-turn',
          occurred_at: new Date().toISOString(),
          input_id: 'in-ACTIVE',
          route_key: 'opencode|discord|chan-1|dm:mg-1',
          evidence: { artifact_path: artifact, size_bytes: size },
        }),
      ].join('\n'),
      allowedArtifactRoots: [root],
    });

    // Only the active turn's entry is surfaced when correlated by inputId; the
    // unrelated earlier entry is excluded.
    const active = getAuthoritativeSideEffects({ inputId: 'in-ACTIVE' });
    expect(active.map((s) => s.id)).toEqual(['active-turn']);
    // Combining route + input is also exact.
    const combined = getAuthoritativeSideEffects({ inputId: 'in-ACTIVE', routeKey: 'opencode|discord|chan-1|dm:mg-1' });
    expect(combined.map((s) => s.id)).toEqual(['active-turn']);
    // A mismatched route with the active inputId yields nothing (no cross-leak).
    const mismatch = getAuthoritativeSideEffects({ inputId: 'in-ACTIVE', routeKey: 'opencode|discord|chan-9|dm:mg-9' });
    expect(mismatch.map((s) => s.id)).toEqual([]);
    // No filter still returns both (back-compat).
    expect(
      getAuthoritativeSideEffects()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['active-turn', 'other-turn']);
  });
});

// ── Task 4B: signed gmail import + cross-copy verifier check (container half) ─

function signedGmailLine(
  auditId: string,
  key: ReturnType<typeof generateKeyPairSync>,
  overrides: { tamper?: boolean; recordAuditId?: string; accountLabel?: 'personal' | 'glowforge' } = {},
): string {
  const accountLabel = overrides.accountLabel ?? 'personal';
  const accountEmail = accountLabel === 'personal' ? 'dan@danshapiro.com' : 'dan@glowforge.com';
  const payload = canonicalSideEffectPayload({
    schema_version: 2,
    audit_id: auditId,
    profile: 'nanoclaw',
    account_label: accountLabel,
    account_email: accountEmail,
    input_id: 'in-1',
    route_key: 'opencode|discord|chan-1|dm:mg-1',
    service: 'gmail',
    method: 'users.drafts.create',
    request_class: 'api',
    api_effect: true,
    operation_succeeded: true,
    occurred_at: '2026-05-29T00:00:00.000Z',
    result_digest: 'r-abc',
  });
  const sig = edSign(null, Buffer.from(payload, 'utf8'), key.privateKey).toString('base64');
  // Tampered: present a DIFFERENT payload than what was signed.
  const forwardedPayload = overrides.tamper
    ? canonicalSideEffectPayload({
        schema_version: 2,
        audit_id: auditId,
        profile: 'nanoclaw',
        account_label: accountLabel,
        account_email: accountEmail,
        input_id: 'in-1',
        route_key: 'opencode|discord|chan-1|dm:mg-1',
        service: 'gmail',
        method: 'users.drafts.create',
        request_class: 'api',
        api_effect: true,
        operation_succeeded: true,
        occurred_at: '2026-05-29T00:00:00.000Z',
        result_digest: 'TAMPERED',
      })
    : payload;
  return JSON.stringify({
    kind: 'gmail_draft_created',
    payload_schema_version: 2,
    // Rebinding vector: the RECORD's audit_id (idempotency key) may differ from
    // the audit_id embedded in the validly-signed payload.
    audit_id: overrides.recordAuditId ?? auditId,
    profile: 'nanoclaw',
    account_label: accountLabel,
    account_email: accountEmail,
    operation: 'gmail users.drafts.create',
    occurred_at: '2026-05-29T00:00:00.000Z',
    input_id: 'in-1',
    route_key: 'opencode|discord|chan-1|dm:mg-1',
    signature: sig,
    payload: forwardedPayload,
    evidence: { draft_id: 'r-abc' },
  });
}

describe('side_effect_ledger signed gmail import (Task 4B)', () => {
  test('a validly signed gmail_draft_created is authoritative with the public key', () => {
    const key = generateKeyPairSync('ed25519');
    const pem = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const r = importSideEffectLedger({ jsonl: signedGmailLine('signed-1', key), gwsPublicKey: pem });
    expect(r.imported).toBe(1);
    expect(r.validated).toBe(1);
    expect(getAuthoritativeSideEffects().some((s) => s.id === 'signed-1')).toBe(true);
    const row = getOutboundDb()
      .prepare(
        `SELECT payload_schema_version, account_label, account_email, input_id, route_key, operation,
                signed_payload, signature FROM side_effect_ledger WHERE id = 'signed-1'`,
      )
      .get() as Record<string, unknown>;
    expect(row.payload_schema_version).toBe(2);
    expect(row.account_label).toBe('personal');
    expect(row.account_email).toBe('dan@danshapiro.com');
    expect(row.input_id).toBe('in-1');
    expect(row.route_key).toBe('opencode|discord|chan-1|dm:mg-1');
    expect(row.operation).toBe('gmail users.drafts.create');
    expect(row.signed_payload).toBeTruthy();
    expect(row.signature).toBeTruthy();
  });

  test('personal and Glowforge incident replays retain their exact signed Gmail account', () => {
    const key = generateKeyPairSync('ed25519');
    const pem = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const result = importSideEffectLedger({
      jsonl: [
        signedGmailLine('personal-replay', key, { accountLabel: 'personal' }),
        signedGmailLine('glowforge-replay', key, { accountLabel: 'glowforge' }),
      ].join('\n'),
      gwsPublicKey: pem,
    });
    expect(result.validated).toBe(2);
    const recovered = getAuthoritativeSideEffects();
    expect(recovered.find((effect) => effect.id === 'personal-replay')).toMatchObject({
      accountLabel: 'personal',
      accountEmail: 'dan@danshapiro.com',
      kind: 'gmail_draft_created',
    });
    expect(recovered.find((effect) => effect.id === 'glowforge-replay')).toMatchObject({
      accountLabel: 'glowforge',
      accountEmail: 'dan@glowforge.com',
      kind: 'gmail_draft_created',
    });
  });

  test('an existing schema-v1 SQL row claiming authoritative is downgraded and rendered account-unknown', () => {
    getOutboundDb()
      .prepare(
        `INSERT INTO side_effect_ledger
          (id, source, kind, operation, evidence_json, validation_json, replay_policy, occurred_at, imported_at)
         VALUES (?, 'gws', 'gmail_draft_created', 'gmail users.drafts.create', '{}', ?, 'no_duplicate_draft', ?, ?)`,
      )
      .run('legacy-authoritative', JSON.stringify({ authoritative: true }), '2026-05-29T00:00:00Z', new Date().toISOString());

    expect(getAuthoritativeSideEffects().some((s) => s.id === 'legacy-authoritative')).toBe(false);
    const legacy = getSideEffectHints().find((s) => s.id === 'legacy-authoritative');
    expect(legacy?.label).toBe('legacy account unknown; do not recreate automatically; reconcile');
    expect(legacy?.payloadSchemaVersion).toBe(1);
    expect(legacy?.accountLabel).toBeNull();
    expect(legacy?.accountEmail).toBeNull();
  });

  test('idempotency key = audit_id: replaying a genuine signed entry imports one row', () => {
    const key = generateKeyPairSync('ed25519');
    const pem = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const line = signedGmailLine('dup-1', key);
    importSideEffectLedger({ jsonl: line, gwsPublicKey: pem });
    importSideEffectLedger({ jsonl: line, gwsPublicKey: pem });
    const count = (
      getOutboundDb().prepare("SELECT COUNT(*) AS c FROM side_effect_ledger WHERE id = 'dup-1'").get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  test('a forged signature stays an unvalidated hint even with a verify key', () => {
    const real = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const pem = real.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    // Signed by attacker, verified against the real public key.
    const r = importSideEffectLedger({ jsonl: signedGmailLine('forged-1', attacker), gwsPublicKey: pem });
    expect(r.imported).toBe(1);
    expect(getAuthoritativeSideEffects().some((s) => s.id === 'forged-1')).toBe(false);
    expect(getSideEffectHints().some((s) => s.id === 'forged-1')).toBe(true);
  });

  test('a tampered payload (genuine sig over different bytes) stays a hint', () => {
    const key = generateKeyPairSync('ed25519');
    const pem = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const r = importSideEffectLedger({ jsonl: signedGmailLine('tamper-1', key, { tamper: true }), gwsPublicKey: pem });
    expect(r.imported).toBe(1);
    expect(getAuthoritativeSideEffects().some((s) => s.id === 'tamper-1')).toBe(false);
    expect(getSideEffectHints().some((s) => s.id === 'tamper-1')).toBe(true);
  });

  test('no public key ⇒ a signed gmail entry stays an unvalidated hint (feature inactive)', () => {
    const key = generateKeyPairSync('ed25519');
    const r = importSideEffectLedger({ jsonl: signedGmailLine('nokey-1', key) });
    expect(r.imported).toBe(1);
    expect(getAuthoritativeSideEffects().some((s) => s.id === 'nokey-1')).toBe(false);
    expect(getSideEffectHints().some((s) => s.id === 'nokey-1')).toBe(true);
  });

  test('audit_id-rebinding: a valid signature over payload audit_id "X" attached to a record audit_id "Y" stays a hint', () => {
    const key = generateKeyPairSync('ed25519');
    const pem = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    // Genuinely sign a payload with audit_id "X", but attach it to a record
    // whose own idempotency key (audit_id) is "Y". A genuine past signature must
    // not be replayable under a different audit_id.
    const r = importSideEffectLedger({
      jsonl: signedGmailLine('X', key, { recordAuditId: 'Y' }),
      gwsPublicKey: pem,
    });
    expect(r.imported).toBe(1);
    expect(getAuthoritativeSideEffects().some((s) => s.id === 'Y')).toBe(false);
    expect(getSideEffectHints().some((s) => s.id === 'Y')).toBe(true);

    // Control: the same signature with a MATCHING record audit_id "X" IS
    // authoritative — proving only the rebinding was rejected, not the signature.
    const ok = importSideEffectLedger({ jsonl: signedGmailLine('X', key), gwsPublicKey: pem });
    expect(ok.validated).toBe(1);
    expect(getAuthoritativeSideEffects().some((s) => s.id === 'X')).toBe(true);
  });
});

// Container half of the shared cross-copy verifier cross-check. The SAME vectors
// run through the HOST copy in src/db/side-effects-verify.test.ts; the two
// side-effects-verify.ts files are byte-identical, so identical vectors must
// yield identical verify/reject results.
describe('side-effects-verify cross-check (container copy)', () => {
  test('uses the shared schema-v2 golden bytes and rejects every adversarial substitution', () => {
    type CorpusPayload = Parameters<typeof canonicalSideEffectPayload>[0];
    const corpus = JSON.parse(
      fs.readFileSync(new URL('./side-effect-schema-v2-corpus.json', import.meta.url), 'utf8'),
    ) as {
      payload: CorpusPayload;
      canonical: string;
      seed_base64: string;
      adversarial: Array<{ field: keyof CorpusPayload; value: string | boolean }>;
      non_gmail_payload: CorpusPayload;
    };
    const seed = Buffer.from(corpus.seed_base64, 'base64');
    const privateKey = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString();
    const canonical = canonicalSideEffectPayload(corpus.payload);
    const signature = edSign(null, Buffer.from(canonical), privateKey).toString('base64');

    expect(canonical).toBe(corpus.canonical);
    expect(verifyGwsSideEffectSignature(canonical, signature, publicKey)).toBe('valid');
    for (const substitution of corpus.adversarial) {
      const mutated = canonicalSideEffectPayload({ ...corpus.payload, [substitution.field]: substitution.value });
      expect(verifyGwsSideEffectSignature(mutated, signature, publicKey), substitution.field).toBe('invalid');
    }

    const drivePayload = canonicalSideEffectPayload(corpus.non_gmail_payload);
    const driveSignature = edSign(null, Buffer.from(drivePayload), privateKey).toString('base64');
    const drive = classifyAndSanitize(
      {
        kind: 'gmail_draft_created',
        payload_schema_version: 2,
        audit_id: corpus.non_gmail_payload.audit_id,
        profile: corpus.non_gmail_payload.profile,
        account_label: corpus.non_gmail_payload.account_label,
        account_email: corpus.non_gmail_payload.account_email,
        input_id: corpus.non_gmail_payload.input_id,
        route_key: corpus.non_gmail_payload.route_key,
        operation: `${corpus.non_gmail_payload.service} ${corpus.non_gmail_payload.method}`,
        occurred_at: corpus.non_gmail_payload.occurred_at,
        payload: drivePayload,
        signature: driveSignature,
      },
      { gwsPublicKey: publicKey },
    );
    expect(drive?.validation.authoritative).toBe(true);
    expect(drive?.kind).toBe('gws_mutation_completed');
    expect(drive?.accountLabel).toBe('glowforge');
    expect(drive?.accountEmail).toBe('dan@glowforge.com');
  });

  test('verifies/rejects each shared vector exactly', () => {
    const key = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const pem = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const rawB64 = key.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    const otherPem = other.publicKey.export({ format: 'pem', type: 'spki' }).toString();

    const canonical = canonicalSideEffectPayload({
      schema_version: 2,
      audit_id: 'abc123',
      profile: 'nanoclaw',
      account_label: 'personal',
      account_email: 'dan@danshapiro.com',
      input_id: 'in-1',
      route_key: 'route-1',
      service: 'gmail',
      method: 'users.drafts.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-05-29T00:00:00.000Z',
      result_digest: 'deadbeef',
    });
    const tampered = canonicalSideEffectPayload({
      schema_version: 2,
      audit_id: 'abc123',
      profile: 'nanoclaw',
      account_label: 'personal',
      account_email: 'dan@danshapiro.com',
      input_id: 'in-1',
      route_key: 'route-1',
      service: 'gmail',
      method: 'users.drafts.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-05-29T00:00:00.000Z',
      result_digest: 'cafef00d',
    });
    const goodSig = edSign(null, Buffer.from(canonical, 'utf8'), key.privateKey).toString('base64');
    const forgedSig = edSign(null, Buffer.from(canonical, 'utf8'), attacker.privateKey).toString('base64');

    expect(verifyGwsSideEffectSignature(canonical, goodSig, pem)).toBe('valid');
    expect(verifyGwsSideEffectSignature(canonical, goodSig, rawB64)).toBe('valid');
    expect(verifyGwsSideEffectSignature(tampered, goodSig, pem)).toBe('invalid');
    expect(verifyGwsSideEffectSignature(canonical, forgedSig, pem)).toBe('invalid');
    expect(verifyGwsSideEffectSignature(canonical, goodSig, otherPem)).toBe('invalid');
    expect(verifyGwsSideEffectSignature(canonical, undefined, pem)).toBe('unvalidated');
    expect(verifyGwsSideEffectSignature(canonical, goodSig, undefined)).toBe('unvalidated');
    expect(verifyGwsSideEffectSignature(canonical, 'not-base64-!!!', pem)).toBe('invalid');
  });

  test('canonical payload bytes match the cross-language contract', () => {
    expect(
      canonicalSideEffectPayload({
        schema_version: 2,
        audit_id: 'abc123',
        profile: 'nanoclaw',
        account_label: 'personal',
        account_email: 'dan@danshapiro.com',
        input_id: 'in-1',
        route_key: 'route-1',
        service: 'gmail',
        method: 'users.drafts.create',
        request_class: 'api',
        api_effect: true,
        operation_succeeded: true,
        occurred_at: '2026-05-29T00:00:00.000Z',
        result_digest: 'deadbeef',
      }),
    ).toBe(
      '{"schema_version":2,"audit_id":"abc123","profile":"nanoclaw","account_label":"personal","account_email":"dan@danshapiro.com","input_id":"in-1","route_key":"route-1","service":"gmail","method":"users.drafts.create","request_class":"api","api_effect":true,"operation_succeeded":true,"occurred_at":"2026-05-29T00:00:00.000Z","result_digest":"deadbeef"}',
    );
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
    const otherScope = dmScope({
      routeKey: 'opencode|discord|chan-2|dm:mg-2',
      messagingGroupId: 'mg-2',
      platformId: 'chan-2',
    });
    expect(listRecoveryEntries(otherScope)).toHaveLength(0);
  });

  test('pending -> in_flight -> resolved deletes only after successful resolution', () => {
    const scope = dmScope();
    const entry = newRecoveryEntry(scope, {
      acceptedUnresolvedInputs: [{ inputId: 'in-1', messageIds: ['m1'], prompt: 'do it' }],
    });
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
    const entry = newRecoveryEntry(scope, {
      acceptedUnresolvedInputs: [{ inputId: 'in-1', messageIds: ['m1'], prompt: 'do it' }],
    });
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
    appendRecoveryEntry(
      scope,
      newRecoveryEntry(scope, {
        originalTasks: [{ messageId: 'm-keep', text: 'keep me', timestamp: new Date().toISOString() }],
      }),
    );
    // Corrupt the stored JSON.
    const key = `recovery:${scope.providerName}:${scope.routeKey}`;
    getOutboundDb().prepare('UPDATE session_state SET value = ? WHERE key = ?').run('{not valid json', key);

    const outcome = recoverMalformedRecovery(scope);
    // Either reconstructed into a replacement entry or returned a fallback — never silently dropped.
    expect(outcome.destroyedSilently).toBe(false);
    expect(['reconstructed', 'fallback', 'returned_to_pending']).toContain(outcome.disposition);
  });

  // ── Step 3 line 533/164: move rows into recovery ownership + append recovery
  // payload is ONE atomic transaction on the outbound DB. ───────────────────────
  function ackStatus(id: string): string | null {
    const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  }

  test('appendRecoveryEntryAndOwnRows moves rows to recovery and stores the payload atomically', () => {
    const scope = dmScope();
    // Rows are currently claimed (processing) — terminal interruption is moving
    // them to recovery ownership.
    getOutboundDb()
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m1', 'processing', datetime('now'))",
      )
      .run();
    getOutboundDb()
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m2', 'processing', datetime('now'))",
      )
      .run();

    const entry = newRecoveryEntry(scope, {
      acceptedUnresolvedInputs: [{ inputId: 'in-1', messageIds: ['m1', 'm2'], prompt: 'do it' }],
    });
    const result = appendRecoveryEntryAndOwnRows(scope, entry, ['m1', 'm2']);
    expect(result.pressureExceeded).toBeUndefined();

    // Both halves landed: payload stored AND rows owned by recovery.
    expect(listRecoveryEntries(scope)).toHaveLength(1);
    expect(listRecoveryEntries(scope)[0].id).toBe(entry.id);
    expect(ackStatus('m1')).toBe('recovery');
    expect(ackStatus('m2')).toBe('recovery');
  });

  test('a mid-transaction failure rolls back BOTH the ownership move and the payload append (no partial state)', () => {
    const scope = dmScope();
    getOutboundDb()
      .prepare(
        "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('m1', 'processing', datetime('now'))",
      )
      .run();

    const entry = newRecoveryEntry(scope, {
      acceptedUnresolvedInputs: [{ inputId: 'in-1', messageIds: ['m1'], prompt: 'do it' }],
    });

    // Inject a throw partway through the atomic transaction (after the payload
    // write begins but before it commits). The whole transaction must roll back.
    expect(() =>
      appendRecoveryEntryAndOwnRows(scope, entry, ['m1'], {
        __injectMidTransactionThrow: () => {
          throw new Error('simulated crash mid-transaction');
        },
      }),
    ).toThrow('simulated crash mid-transaction');

    // NEITHER half landed: the row is still 'processing' (not stranded in
    // 'recovery' with no payload, and not lost), and no recovery payload exists.
    expect(ackStatus('m1')).toBe('processing');
    expect(listRecoveryEntries(scope)).toHaveLength(0);
  });
});
