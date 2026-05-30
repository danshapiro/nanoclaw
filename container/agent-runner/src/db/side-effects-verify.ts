/**
 * Pure, DB-free side-effect verification + sanitization helpers.
 *
 * ⚠ DELIBERATE DUPLICATION. This is the CONTAINER copy of this file.
 * The byte-equivalent HOST copy will live at `src/db/side-effects-verify.ts`
 * (created in Task 4B). It is NOT a cross-project import: the host TS project
 * (`tsconfig.json` `rootDir:"./src"`,
 * include `src` glob only) cannot include the container `src` tree, and
 * the container `side-effects.ts`/`connection.ts` pull in `bun:sqlite`, which
 * does not resolve under the host's Node/Vitest runtime. Only the Node/Bun
 * built-in `crypto` is used here — no DB import, no `bun:sqlite`, no
 * `better-sqlite3`. A shared cross-check test (Task 4B) feeds both copies the
 * same signed/forged/tampered vectors and asserts identical verify/reject
 * results so the two copies cannot drift.
 *
 * Task 1 scope: the Ed25519 verifier is a FAIL-CLOSED STUB. Without a configured
 * verify key (or until the real verify lands in Task 4B), every
 * `gmail_draft_created` entry stays an unvalidated hint and can never become
 * authoritative recovery evidence. The security invariant
 * "agent-writable staged JSONL is never authoritative" therefore holds with or
 * without the key. `summarize-dnd` artifact validation (existence + size under
 * an allowed root) is real and implemented in Task 1.
 */

export type SideEffectSource = 'gws' | 'summarize_dnd' | 'tool' | 'unknown';

export type SideEffectKind =
  | 'gmail_draft_created'
  | 'summarize_dnd_recording_cached'
  | 'summarize_dnd_summary_artifact'
  | 'tool_completed'
  | 'other';

export interface RawSideEffectRecord {
  kind?: string;
  audit_id?: string;
  operation?: string;
  input_id?: string;
  route_key?: string;
  occurred_at?: string;
  signature?: string;
  payload?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ValidatedSideEffect {
  id: string;
  source: SideEffectSource;
  kind: SideEffectKind;
  operation: string | null;
  inputId: string | null;
  routeKey: string | null;
  occurredAt: string | null;
  /** Sanitized, bounded evidence safe to persist and surface to recovery. */
  evidence: Record<string, string | number | boolean | null>;
  /** Validation outcome metadata (why this is/ isn't authoritative). */
  validation: { authoritative: boolean; reason: string };
  replayPolicy: string;
}

/**
 * Stable canonical JSON serialization of the proxy's signed payload. Keys are
 * emitted in the fixed contract order so the signature is computed over an
 * unambiguous byte sequence on both sides of the mount.
 */
export function canonicalSideEffectPayload(payload: {
  audit_id: string;
  service: string;
  method: string;
  request_class: string;
  api_effect: boolean;
  operation_succeeded: boolean;
  occurred_at: string;
  result_digest: string;
}): string {
  return JSON.stringify({
    audit_id: payload.audit_id,
    service: payload.service,
    method: payload.method,
    request_class: payload.request_class,
    api_effect: payload.api_effect,
    operation_succeeded: payload.operation_succeeded,
    occurred_at: payload.occurred_at,
    result_digest: payload.result_digest,
  });
}

export type GwsVerifyResult = 'valid' | 'invalid' | 'unvalidated';

/**
 * Verify the proxy's Ed25519 detached signature over the canonical payload.
 *
 * Task 1 FAIL-CLOSED STUB: always returns 'unvalidated' so no Gmail entry is
 * ever authoritative until the real Ed25519 verify + key wiring lands in
 * Task 4B. `publicKey` absent ⇒ 'unvalidated' is the correct, secure default.
 */
export function verifyGwsSideEffectSignature(
  _canonicalPayload: string,
  _signatureBase64: string | undefined,
  _publicKeyPem: string | undefined,
): GwsVerifyResult {
  // Real Ed25519 verification is added in Task 4B. Until then, unsigned and
  // signed Gmail entries alike are treated as unvalidated hints only.
  return 'unvalidated';
}

const MAX_EVIDENCE_KEYS = 12;
const MAX_EVIDENCE_VALUE_LEN = 256;
// Keys that may carry secrets / full bodies / arbitrary paths are dropped from
// sanitized evidence regardless of kind.
const FORBIDDEN_EVIDENCE_KEYS =
  /(secret|token|api[_-]?key|password|cookie|authorization|body|transcript|content|email_body|raw)/i;

function sanitizeEvidence(
  evidence: Record<string, unknown> | undefined,
  opts: { allowedArtifactRoots?: string[]; allowPathKeys?: string[] },
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!evidence) return out;
  const allowPath = new Set(opts.allowPathKeys ?? []);
  let count = 0;
  for (const [key, value] of Object.entries(evidence)) {
    if (count >= MAX_EVIDENCE_KEYS) break;
    if (FORBIDDEN_EVIDENCE_KEYS.test(key)) continue;
    // Path-like keys are only kept when explicitly allowed AND inside an allowed
    // artifact root; otherwise drop them so we never leak arbitrary host paths.
    const isPathKey = /path|file|dir/i.test(key);
    if (isPathKey && !allowPath.has(key)) continue;
    if (isPathKey && typeof value === 'string') {
      const roots = opts.allowedArtifactRoots ?? [];
      if (!roots.some((root) => isUnderRoot(value, root))) continue;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      out[key] = value;
      count++;
    } else if (typeof value === 'string') {
      out[key] = value.length > MAX_EVIDENCE_VALUE_LEN ? value.slice(0, MAX_EVIDENCE_VALUE_LEN) : value;
      count++;
    }
    // objects/arrays are dropped — never store nested raw structures
  }
  return out;
}

/** True when `candidate` is the same path as, or nested under, `root`. */
export function isUnderRoot(candidate: string, root: string): boolean {
  const normalize = (p: string): string[] => p.replace(/\/+$/, '').split('/').filter(Boolean);
  const c = normalize(candidate);
  const r = normalize(root);
  if (c.length < r.length) return false;
  for (let i = 0; i < r.length; i++) {
    if (c[i] !== r[i]) return false;
  }
  return true;
}

/** Parse JSONL ledger text into raw records, skipping unparseable lines. */
export function parseLedgerLines(text: string): RawSideEffectRecord[] {
  const records: RawSideEffectRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as RawSideEffectRecord);
    } catch {
      /* skip malformed line */
    }
  }
  return records;
}

export interface ClassifyOptions {
  /** Allowed roots under which a summarize-dnd artifact must live to validate. */
  allowedArtifactRoots?: string[];
  /** Public verify key for GWS signatures (host or container). */
  gwsPublicKey?: string;
  /**
   * Filesystem probe: returns the artifact's byte size, or null if missing.
   * Injected so this module stays DB- and platform-free (the caller wires fs).
   */
  statSize?: (path: string) => number | null;
}

/**
 * Classify, validate, and sanitize a single raw ledger record into a
 * persistable ValidatedSideEffect. Unknown kinds collapse to a sanitized
 * `tool_completed` entry. `validation.authoritative` is the single source of
 * truth for whether recovery may rely on the record.
 */
export function classifyAndSanitize(raw: RawSideEffectRecord, opts: ClassifyOptions = {}): ValidatedSideEffect | null {
  const id = typeof raw.audit_id === 'string' && raw.audit_id ? raw.audit_id : null;
  if (!id) return null; // no idempotency key — cannot import

  const inputId = typeof raw.input_id === 'string' ? raw.input_id : null;
  const routeKey = typeof raw.route_key === 'string' ? raw.route_key : null;
  const operation = typeof raw.operation === 'string' ? raw.operation : null;
  const occurredAt = typeof raw.occurred_at === 'string' ? raw.occurred_at : null;
  const kind = raw.kind;

  if (kind === 'gmail_draft_created') {
    // Fail-closed: authoritative only when the Ed25519 signature verifies. The
    // Task 1 stub always returns 'unvalidated', so this stays a hint.
    const verify = verifyGwsSideEffectSignature(
      typeof raw.payload === 'object' && raw.payload ? canonicalFromPayload(raw.payload) : '',
      raw.signature,
      opts.gwsPublicKey,
    );
    return {
      id,
      source: 'gws',
      kind: 'gmail_draft_created',
      operation,
      inputId,
      routeKey,
      occurredAt,
      evidence: sanitizeEvidence(raw.evidence, { allowPathKeys: [] }),
      validation: {
        authoritative: verify === 'valid',
        reason: verify === 'valid' ? 'ed25519_signature_valid' : `gmail_${verify}`,
      },
      replayPolicy: 'no_duplicate_draft',
    };
  }

  if (kind === 'summarize_dnd_summary_artifact') {
    const artifactPath =
      raw.evidence && typeof raw.evidence.artifact_path === 'string' ? (raw.evidence.artifact_path as string) : null;
    const declaredSize =
      raw.evidence && typeof raw.evidence.size_bytes === 'number' ? (raw.evidence.size_bytes as number) : null;
    let authoritative = false;
    let reason = 'artifact_not_validated';
    if (artifactPath && declaredSize != null && opts.statSize) {
      const roots = opts.allowedArtifactRoots ?? [];
      const underRoot = roots.some((root) => isUnderRoot(artifactPath, root));
      if (!underRoot) {
        reason = 'artifact_outside_allowed_root';
      } else {
        const actualSize = opts.statSize(artifactPath);
        if (actualSize == null) reason = 'artifact_missing';
        else if (actualSize !== declaredSize) reason = 'artifact_size_mismatch';
        else {
          authoritative = true;
          reason = 'artifact_exists_size_match';
        }
      }
    }
    return {
      id,
      source: 'summarize_dnd',
      kind: 'summarize_dnd_summary_artifact',
      operation,
      inputId,
      routeKey,
      occurredAt,
      evidence: sanitizeEvidence(raw.evidence, {
        allowPathKeys: ['artifact_path'],
        allowedArtifactRoots: opts.allowedArtifactRoots,
      }),
      validation: { authoritative, reason },
      replayPolicy: 'no_redo_summary',
    };
  }

  if (kind === 'summarize_dnd_recording_cached') {
    // RESERVED kind with no producer in this plan. Recorded as a non-
    // authoritative hint only; recovery does not depend on it.
    return {
      id,
      source: 'summarize_dnd',
      kind: 'summarize_dnd_recording_cached',
      operation,
      inputId,
      routeKey,
      occurredAt,
      evidence: sanitizeEvidence(raw.evidence, { allowPathKeys: [], allowedArtifactRoots: opts.allowedArtifactRoots }),
      validation: { authoritative: false, reason: 'reserved_kind_no_producer' },
      replayPolicy: 'none',
    };
  }

  // Unknown / over-detailed → sanitized tool_completed, never authoritative.
  return {
    id,
    source: 'tool',
    kind: 'tool_completed',
    operation,
    inputId,
    routeKey,
    occurredAt,
    evidence: sanitizeEvidence(raw.evidence, { allowPathKeys: [], allowedArtifactRoots: opts.allowedArtifactRoots }),
    validation: { authoritative: false, reason: 'unknown_kind_sanitized' },
    replayPolicy: 'none',
  };
}

function canonicalFromPayload(payload: Record<string, unknown>): string {
  // Best-effort canonicalization of a forwarded payload object; only used when
  // the real verifier lands (Task 4B). Returns a stable string today so the
  // stub has a deterministic (ignored) input.
  try {
    return canonicalSideEffectPayload({
      audit_id: String(payload.audit_id ?? ''),
      service: String(payload.service ?? ''),
      method: String(payload.method ?? ''),
      request_class: String(payload.request_class ?? ''),
      api_effect: Boolean(payload.api_effect),
      operation_succeeded: Boolean(payload.operation_succeeded),
      occurred_at: String(payload.occurred_at ?? ''),
      result_digest: String(payload.result_digest ?? ''),
    });
  } catch {
    return '';
  }
}
