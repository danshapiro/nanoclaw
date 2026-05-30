/**
 * Pure, DB-free side-effect verification + sanitization helpers.
 *
 * DELIBERATE DUPLICATION. This module exists as two byte-identical copies:
 * the CONTAINER copy at `container/agent-runner/src/db/side-effects-verify.ts`
 * and the HOST copy at `src/db/side-effects-verify.ts`. They are kept LITERALLY
 * byte-identical (a Task 4B cross-check test diffs them) so they cannot drift.
 * It is NOT a cross-project import: the host TS project (`tsconfig.json`
 * `rootDir:"./src"`, include `src` glob only) cannot include the container `src`
 * tree, and the container `side-effects.ts`/`connection.ts` pull in `bun:sqlite`,
 * which does not resolve under the host's Node/Vitest runtime. Only the Node/Bun
 * built-in `crypto` is used here — no DB import, no `bun:sqlite`, no
 * `better-sqlite3`. A shared cross-check test feeds both copies the same
 * signed/forged/tampered vectors and asserts identical verify/reject results.
 *
 * The Ed25519 verifier is REAL (Task 4B): a `gmail_draft_created` entry is
 * authoritative only when the proxy's detached Ed25519 signature verifies over
 * the EXACT canonical payload bytes with a configured PUBLIC verify key. Without
 * a key (dev, pre-deploy), or for an unsigned/forged/tampered entry, it stays an
 * unvalidated hint and can never become authoritative recovery evidence. The
 * security invariant "agent-writable staged JSONL is never authoritative" holds
 * with or without the key. The agent never holds the private key, so it cannot
 * fabricate a valid entry. `summarize-dnd` artifact validation (existence + size
 * under an allowed root) needs no key.
 */
import { createPublicKey, verify as edVerify, type KeyObject } from 'crypto';

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
  /**
   * The proxy's canonical signed payload, forwarded VERBATIM by the shim as the
   * exact JSON string the proxy signed (X-GWS-Side-Effect-Payload). The verifier
   * checks the Ed25519 signature over these exact bytes — it never re-serializes,
   * so float/ordering differences cannot break cross-language verification. A
   * legacy object form is tolerated by canonicalizing it.
   */
  payload?: string | Record<string, unknown>;
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
 * unambiguous byte sequence on both sides of the mount. This is byte-identical
 * to the Go `canonicalSideEffectPayload` in the gws-proxy (no whitespace, fixed
 * key order, JS string escaping with HTML escaping disabled), which is what
 * makes the cross-language Ed25519 verify work.
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
 * Parse a configured Ed25519 PUBLIC verify key. Accepts either a PEM SPKI block
 * or the base64 of the raw 32-byte public key. Returns null when the key is
 * absent or unparseable (⇒ 'unvalidated', the secure default).
 */
function parseEd25519PublicKey(publicKey: string | undefined): KeyObject | null {
  if (!publicKey || typeof publicKey !== 'string') return null;
  const trimmed = publicKey.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.includes('BEGIN')) {
      return createPublicKey({ key: trimmed, format: 'pem' });
    }
    // Raw 32-byte Ed25519 public key, base64-encoded. Wrap in the SPKI DER
    // prefix for X25519/Ed25519 public keys (RFC 8410): the 12-byte header
    // 302a300506032b6570032100 followed by the 32-byte key.
    const raw = Buffer.from(trimmed, 'base64');
    if (raw.length === 32) {
      const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
      return createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
    if (raw.length === 44) {
      // Already SPKI DER (12-byte prefix + 32-byte key).
      return createPublicKey({ key: raw, format: 'der', type: 'spki' });
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Verify the proxy's Ed25519 detached signature over the canonical payload.
 *
 * Returns:
 *   - 'unvalidated' when no usable public key is configured, or the entry has no
 *     signature/payload (feature inactive / unsigned hint).
 *   - 'invalid' when a key + signature are present but verification fails
 *     (forged or tampered — never authoritative).
 *   - 'valid' when the Ed25519 signature verifies over the exact payload bytes.
 */
export function verifyGwsSideEffectSignature(
  canonicalPayload: string | undefined,
  signatureBase64: string | undefined,
  publicKey: string | undefined,
): GwsVerifyResult {
  const key = parseEd25519PublicKey(publicKey);
  if (!key) return 'unvalidated';
  if (!canonicalPayload || !signatureBase64) return 'unvalidated';
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureBase64, 'base64');
  } catch {
    return 'invalid';
  }
  if (sig.length !== 64) return 'invalid';
  try {
    const ok = edVerify(null, Buffer.from(canonicalPayload, 'utf8'), key, sig);
    return ok ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
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
    // Authoritative ONLY when the proxy's Ed25519 signature verifies over the
    // forwarded canonical payload AND that payload's audit_id binds to this
    // record's idempotency key (so a genuine signature cannot be replayed under
    // a different audit_id). Unsigned/forged/tampered/missing-key stays a hint.
    const canonical = payloadCanonicalString(raw.payload);
    let verify = verifyGwsSideEffectSignature(canonical, raw.signature, opts.gwsPublicKey);
    if (verify === 'valid' && payloadAuditId(raw.payload) !== id) {
      verify = 'invalid';
    }
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

/**
 * Return the exact canonical payload string to verify the signature over. The
 * shim forwards the proxy's payload verbatim as a string; verify over those
 * exact bytes. A legacy object form is re-serialized canonically as a fallback.
 */
function payloadCanonicalString(payload: string | Record<string, unknown> | undefined): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
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
  return '';
}

/** Extract the audit_id embedded in the signed payload (string or object). */
function payloadAuditId(payload: string | Record<string, unknown> | undefined): string | null {
  if (typeof payload === 'string') {
    try {
      const obj = JSON.parse(payload) as { audit_id?: unknown };
      return typeof obj.audit_id === 'string' ? obj.audit_id : null;
    } catch {
      return null;
    }
  }
  if (payload && typeof payload === 'object') {
    return typeof payload.audit_id === 'string' ? payload.audit_id : null;
  }
  return null;
}
