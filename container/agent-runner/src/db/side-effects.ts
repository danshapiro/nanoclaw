/**
 * Container-side side-effect ledger: idempotently import staged
 * `/workspace/side-effects.jsonl` evidence into the outbound DB
 * `side_effect_ledger`, then expose query helpers for recovery prompt
 * construction and replay tests.
 *
 * Workspace JSONL is a STAGING CHANNEL, not authoritative truth. Validation
 * decides what recovery may rely on:
 *   - `gmail_draft_created` is authoritative ONLY if its detached Ed25519
 *     signature verifies over the staged canonical payload with the configured
 *     PUBLIC verify key. Unsigned, no-key-configured, forged, or tampered
 *     entries fail closed and stay unvalidated hints — the agent cannot forge a
 *     valid entry because it never holds the proxy's private key.
 *   - `summarize_dnd_summary_artifact` requires the referenced artifact to
 *     exist under an allowed output root and match the staged size.
 * Only validated entries are authoritative; unvalidated entries are retained as
 * hints only and can never satisfy recovery or final-success assertions.
 *
 * The pure, DB-free Ed25519 verify + canonical-JSON + classify/sanitize logic
 * lives in `side-effects-verify.ts` (no `bun:sqlite`), re-exported here. It is
 * duplicated byte-equivalently as a host copy at `src/db/side-effects-verify.ts`
 * because the host and container are separate TS projects (the host cannot pull
 * in `bun:sqlite`).
 */
import fs from 'fs';

import { getOutboundDb } from './connection.js';
import {
  classifyAndSanitize,
  parseLedgerLines,
  type ValidatedSideEffect,
} from './side-effects-verify.js';
import type { ProviderSideEffect } from '../providers/types.js';

export {
  canonicalSideEffectPayload,
  classifyAndSanitize,
  isUnderRoot,
  parseLedgerLines,
  verifyGwsSideEffectSignature,
} from './side-effects-verify.js';
export type { GwsVerifyResult, ValidatedSideEffect } from './side-effects-verify.js';

export interface ImportLedgerOptions {
  /** Raw JSONL text to import. */
  jsonl?: string;
  /** Path to a JSONL file to import (read if `jsonl` is not supplied). */
  path?: string;
  /** Allowed roots for summarize-dnd artifact validation. */
  allowedArtifactRoots?: string[];
  /** Public verify key for GWS signatures. */
  gwsPublicKey?: string;
}

export interface ImportLedgerResult {
  imported: number;
  skipped: number;
  validated: number;
}

/**
 * Idempotently import staged side-effect JSONL into `side_effect_ledger`.
 * Idempotency key = the record id (proxy `audit_id` for GWS, stable
 * artifact/run key for summarize-dnd). Re-importing the same id is a no-op.
 */
export function importSideEffectLedger(opts: ImportLedgerOptions = {}): ImportLedgerResult {
  const result: ImportLedgerResult = { imported: 0, skipped: 0, validated: 0 };
  let text = opts.jsonl;
  if (text === undefined && opts.path) {
    if (!fs.existsSync(opts.path)) return result;
    text = fs.readFileSync(opts.path, 'utf8');
  }
  if (!text) return result;

  const raws = parseLedgerLines(text);
  if (raws.length === 0) return result;

  const db = getOutboundDb();
  const existsStmt = db.prepare('SELECT 1 AS ok FROM side_effect_ledger WHERE id = $id');
  const insertStmt = db.prepare(
    `INSERT INTO side_effect_ledger
       (id, source, kind, operation, input_id, route_key, evidence_json, validation_json, replay_policy, occurred_at, imported_at)
     VALUES ($id, $source, $kind, $operation, $input_id, $route_key, $evidence_json, $validation_json, $replay_policy, $occurred_at, $imported_at)`,
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const raw of raws) {
      const validated = classifyAndSanitize(raw, {
        allowedArtifactRoots: opts.allowedArtifactRoots,
        gwsPublicKey: opts.gwsPublicKey,
        statSize: (p: string) => (fs.existsSync(p) ? fs.statSync(p).size : null),
      });
      if (!validated) {
        result.skipped++;
        continue;
      }
      if (existsStmt.get({ $id: validated.id })) {
        result.skipped++;
        continue;
      }
      insertStmt.run({
        $id: validated.id,
        $source: validated.source,
        $kind: validated.kind,
        $operation: validated.operation,
        $input_id: validated.inputId,
        $route_key: validated.routeKey,
        $evidence_json: JSON.stringify(validated.evidence),
        $validation_json: JSON.stringify(validated.validation),
        $replay_policy: validated.replayPolicy,
        $occurred_at: validated.occurredAt,
        $imported_at: now,
      });
      result.imported++;
      if (validated.validation.authoritative) result.validated++;
    }
  })();
  return result;
}

interface LedgerRow {
  id: string;
  source: string;
  kind: string;
  operation: string | null;
  input_id: string | null;
  route_key: string | null;
  evidence_json: string;
  validation_json: string;
  occurred_at: string | null;
}

function rowToProviderSideEffect(row: LedgerRow): ProviderSideEffect {
  let evidence: Record<string, string | number | boolean | null> = {};
  try {
    evidence = JSON.parse(row.evidence_json);
  } catch {
    evidence = {};
  }
  const kind = (
    ['gmail_draft_created', 'summarize_dnd_recording_cached', 'summarize_dnd_summary_artifact', 'tool_completed'].includes(
      row.kind,
    )
      ? row.kind
      : 'other'
  ) as ProviderSideEffect['kind'];
  return {
    id: row.id,
    inputId: row.input_id ?? '',
    kind,
    label: row.operation ?? row.kind,
    evidence,
    occurredAt: row.occurred_at ?? '',
  };
}

function queryLedger(opts: { authoritativeOnly: boolean; routeKey?: string; inputId?: string }): ProviderSideEffect[] {
  const db = getOutboundDb();
  const rows = db.prepare('SELECT * FROM side_effect_ledger').all() as Array<LedgerRow & { validation_json: string }>;
  const out: ProviderSideEffect[] = [];
  for (const row of rows) {
    if (opts.routeKey && row.route_key && row.route_key !== opts.routeKey) continue;
    // Input correlation: when an active inputId is supplied, only that turn's
    // entries surface (entries with a row input_id that differs are excluded).
    // A null row input_id is never assumed to belong to the active turn.
    if (opts.inputId && row.input_id !== opts.inputId) continue;
    let authoritative = false;
    try {
      authoritative = Boolean((JSON.parse(row.validation_json) as { authoritative?: boolean }).authoritative);
    } catch {
      authoritative = false;
    }
    if (opts.authoritativeOnly && !authoritative) continue;
    if (!opts.authoritativeOnly && authoritative) continue; // hints = non-authoritative only
    out.push(rowToProviderSideEffect(row));
  }
  return out;
}

/**
 * Validated, authoritative side effects available to recovery construction
 * BEFORE any provider-observed tool event. Optionally route-scoped.
 */
export function getAuthoritativeSideEffects(opts: { routeKey?: string; inputId?: string } = {}): ProviderSideEffect[] {
  return queryLedger({ authoritativeOnly: true, routeKey: opts.routeKey, inputId: opts.inputId });
}

/**
 * Unvalidated hints (e.g. an unsigned / no-key / forged / tampered
 * gmail_draft_created whose Ed25519 signature did not verify). NEVER
 * authoritative; surfaced only for diagnostics, never to satisfy recovery or
 * final-success assertions.
 */
export function getSideEffectHints(opts: { routeKey?: string; inputId?: string } = {}): ProviderSideEffect[] {
  return queryLedger({ authoritativeOnly: false, routeKey: opts.routeKey, inputId: opts.inputId });
}
