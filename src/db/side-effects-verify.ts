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
import writeInventory from './gws-v0.18.1-write-operations.json' with { type: 'json' };

export type SideEffectSource = 'gws' | 'summarize_dnd' | 'tool' | 'unknown';

export type SideEffectKind =
  | 'gmail_draft_created'
  | 'gws_mutation_completed'
  | 'summarize_dnd_recording_cached'
  | 'summarize_dnd_summary_artifact'
  | 'tool_completed'
  | 'other';

export interface RawSideEffectRecord {
  kind?: string;
  payload_schema_version?: number;
  audit_id?: string;
  profile?: string;
  account_label?: string;
  account_email?: string;
  operation?: string;
  input_id?: string;
  route_key?: string;
  occurred_at?: string;
  response_input_id?: string;
  response_route_key?: string;
  response_service?: string;
  response_method?: string;
  signature?: string;
  /**
   * The proxy's canonical signed payload, forwarded VERBATIM by the shim as the
   * exact JSON string the proxy signed (X-GWS-Side-Effect-Payload). The verifier
   * checks the Ed25519 signature over these exact bytes and requires the string
   * itself to equal the schema-v2 canonical serialization. Legacy object forms
   * remain schema-v1 diagnostics and can never become authoritative.
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
  payloadSchemaVersion: number;
  profile: string | null;
  accountLabel: string | null;
  accountEmail: string | null;
  inputId: string | null;
  routeKey: string | null;
  occurredAt: string | null;
  signedPayload: string | null;
  signature: string | null;
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
  schema_version: number;
  audit_id: string;
  profile: string;
  account_label: string;
  account_email: string;
  input_id: string;
  route_key: string;
  service: string;
  method: string;
  request_class: string;
  api_effect: boolean;
  operation_succeeded: boolean;
  occurred_at: string;
  result_digest: string;
}): string {
  return JSON.stringify({
    schema_version: payload.schema_version,
    audit_id: payload.audit_id,
    profile: payload.profile,
    account_label: payload.account_label,
    account_email: payload.account_email,
    input_id: payload.input_id,
    route_key: payload.route_key,
    service: payload.service,
    method: payload.method,
    request_class: payload.request_class,
    api_effect: payload.api_effect,
    operation_succeeded: payload.operation_succeeded,
    occurred_at: payload.occurred_at,
    result_digest: payload.result_digest,
  })
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
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

export interface SchemaV2SideEffectPayload {
  schema_version: number;
  audit_id: string;
  profile: string;
  account_label: string;
  account_email: string;
  input_id: string;
  route_key: string;
  service: string;
  method: string;
  request_class: string;
  api_effect: boolean;
  operation_succeeded: boolean;
  occurred_at: string;
  result_digest: string;
}

const CANONICAL_ACCOUNT_EMAILS: Record<string, string> = {
  personal: 'dan@danshapiro.com',
  glowforge: 'dan@glowforge.com',
};

const EXACT_GWS_WRITE_OPERATIONS = new Set<string>(writeInventory.operations);

function parseCanonicalSchemaV2(payload: RawSideEffectRecord['payload']): {
  canonical: string;
  value: SchemaV2SideEffectPayload;
} | null {
  if (typeof payload !== 'string' || payload === '') return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  const stringKeys = [
    'audit_id',
    'profile',
    'account_label',
    'account_email',
    'input_id',
    'route_key',
    'service',
    'method',
    'request_class',
    'occurred_at',
    'result_digest',
  ] as const;
  if (value.schema_version !== 2 || value.api_effect !== true || value.operation_succeeded !== true) return null;
  if (stringKeys.some((key) => typeof value[key] !== 'string')) return null;
  const typed = value as unknown as SchemaV2SideEffectPayload;
  const canonical = canonicalSideEffectPayload(typed);
  // Verbatim canonical bytes are part of the schema. This also rejects extra,
  // missing, reordered, duplicated, or type-coerced fields.
  if (payload !== canonical) return null;
  return { canonical, value: typed };
}

/** Inspect bindings using the same canonical schema-v2 parser as classification. */
export function parseCanonicalGwsSideEffectPayload(
  payload: RawSideEffectRecord['payload'],
): SchemaV2SideEffectPayload | null {
  return parseCanonicalSchemaV2(payload)?.value ?? null;
}

function exactSignedOperation(payload: SchemaV2SideEffectPayload): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(payload.service) || !/^[+a-zA-Z0-9][+a-zA-Z0-9_.-]*$/.test(payload.method)) {
    return null;
  }
  return `${payload.service} ${payload.method}`;
}

function isExactGuardedWrite(payload: SchemaV2SideEffectPayload): boolean {
  return EXACT_GWS_WRITE_OPERATIONS.has(`${payload.service} ${payload.method.replaceAll('.', ' ')}`);
}

function baseValidatedFields(raw: RawSideEffectRecord) {
  return {
    payloadSchemaVersion:
      typeof raw.payload_schema_version === 'number' && Number.isInteger(raw.payload_schema_version)
        ? raw.payload_schema_version
        : 1,
    profile: null,
    accountLabel: null,
    accountEmail: null,
    signedPayload: typeof raw.payload === 'string' ? raw.payload : null,
    signature: typeof raw.signature === 'string' ? raw.signature : null,
  };
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

  const isGwsRecord =
    kind === 'gmail_draft_created' ||
    kind === 'gws_mutation_completed' ||
    raw.payload !== undefined ||
    raw.signature !== undefined;

  if (isGwsRecord) {
    const parsed = parseCanonicalSchemaV2(raw.payload);
    const payloadSchemaVersion = parsed?.value.schema_version ?? baseValidatedFields(raw).payloadSchemaVersion;
    const verify = parsed
      ? verifyGwsSideEffectSignature(parsed.canonical, raw.signature, opts.gwsPublicKey)
      : raw.payload_schema_version === 2
        ? 'invalid'
        : 'unvalidated';
    const signedOperation = parsed ? exactSignedOperation(parsed.value) : null;
    const accountPairValid = Boolean(
      parsed &&
      parsed.value.account_label &&
      CANONICAL_ACCOUNT_EMAILS[parsed.value.account_label] === parsed.value.account_email,
    );
    const bindingsValid = Boolean(
      parsed &&
      raw.payload_schema_version === 2 &&
      raw.audit_id === parsed.value.audit_id &&
      raw.profile === parsed.value.profile &&
      raw.account_label === parsed.value.account_label &&
      raw.account_email === parsed.value.account_email &&
      raw.input_id === parsed.value.input_id &&
      raw.route_key === parsed.value.route_key &&
      raw.operation === signedOperation &&
      raw.occurred_at === parsed.value.occurred_at &&
      raw.response_input_id === parsed.value.input_id &&
      raw.response_route_key === parsed.value.route_key &&
      raw.response_service === parsed.value.service &&
      raw.response_method === parsed.value.method &&
      parsed.value.profile !== '' &&
      parsed.value.input_id !== '' &&
      parsed.value.route_key !== '' &&
      parsed.value.request_class === 'api' &&
      parsed.value.api_effect === true &&
      parsed.value.operation_succeeded === true &&
      parsed.value.result_digest !== '' &&
      Number.isFinite(Date.parse(parsed.value.occurred_at)) &&
      accountPairValid &&
      signedOperation !== null &&
      isExactGuardedWrite(parsed.value),
    );
    const authoritative = payloadSchemaVersion === 2 && verify === 'valid' && bindingsValid;
    const authoritativeKind: SideEffectKind =
      parsed?.value.service === 'gmail' && parsed.value.method === 'users.drafts.create'
        ? 'gmail_draft_created'
        : 'gws_mutation_completed';
    let reason = 'legacy_schema_v1_account_unknown';
    if (payloadSchemaVersion === 2) {
      if (!parsed) reason = 'schema_v2_payload_noncanonical';
      else if (verify !== 'valid') reason = `gws_${verify}`;
      else if (!isExactGuardedWrite(parsed.value)) reason = 'gws_operation_not_exact_guarded_write';
      else if (!bindingsValid) reason = 'gws_binding_invalid';
      else reason = 'ed25519_schema_v2_authoritative';
    }
    return {
      id,
      source: 'gws',
      kind: authoritative
        ? authoritativeKind
        : kind === 'gmail_draft_created'
          ? 'gmail_draft_created'
          : 'gws_mutation_completed',
      operation: authoritative ? signedOperation : operation,
      payloadSchemaVersion,
      profile: authoritative ? parsed!.value.profile : null,
      accountLabel: authoritative ? parsed!.value.account_label : null,
      accountEmail: authoritative ? parsed!.value.account_email : null,
      inputId,
      routeKey,
      occurredAt: authoritative ? parsed!.value.occurred_at : null,
      signedPayload: typeof raw.payload === 'string' ? raw.payload : null,
      signature: typeof raw.signature === 'string' ? raw.signature : null,
      evidence: sanitizeEvidence(raw.evidence, { allowPathKeys: [] }),
      validation: { authoritative, reason },
      replayPolicy: authoritativeKind === 'gmail_draft_created' ? 'no_duplicate_draft' : 'no_duplicate_operation',
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
      ...baseValidatedFields(raw),
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
      ...baseValidatedFields(raw),
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
    ...baseValidatedFields(raw),
    inputId,
    routeKey,
    occurredAt,
    evidence: sanitizeEvidence(raw.evidence, { allowPathKeys: [], allowedArtifactRoots: opts.allowedArtifactRoots }),
    validation: { authoritative: false, reason: 'unknown_kind_sanitized' },
    replayPolicy: 'none',
  };
}
