import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalSideEffectPayload } from '../db/side-effects-verify.js';
import { finalizeOperatorGwsSession, startOperatorGwsSession } from './operator-gws-session.js';

const roots: string[] = [];

function tempRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('operator-owned GWS session lifecycle', () => {
  it('survives source-input release, keeps exact operator correlation, and imports durable staged writes after stop', () => {
    const base = tempRoot('nanoclaw-operator-gws');
    const sourceCorrelation = path.join(base, 'source-correlation');
    fs.mkdirSync(sourceCorrelation, { recursive: true });
    fs.writeFileSync(path.join(sourceCorrelation, 'current.json'), '{"inputId":"source-input"}\n');
    fs.writeFileSync(path.join(sourceCorrelation, 'active-lease.json'), '{"leaseId":"source-lease"}\n');

    const operator = startOperatorGwsSession({
      root: path.join(base, 'operator-session'),
      agentGroupId: 'ag-main',
      groupFolder: 'main',
      operatorId: 'operator-test-1',
      containerUid: process.getuid?.() ?? 0,
      containerGid: process.getgid?.() ?? 0,
      acceptedAt: '2026-07-21T15:00:00.000Z',
      leaseId: 'operator-lease-1',
    });
    const auditStorePath = path.join(base, 'gws-audit.jsonl');
    fs.writeFileSync(auditStorePath, '');

    // Releasing the source turn cannot invalidate or rewrite the independent
    // operator interval.
    fs.unlinkSync(path.join(sourceCorrelation, 'current.json'));
    expect(fs.readFileSync(path.join(sourceCorrelation, 'active-lease.json'), 'utf8')).toContain('source-lease');
    const current = JSON.parse(fs.readFileSync(operator.correlationPath, 'utf8')) as Record<string, unknown>;
    expect(current).toMatchObject({
      schemaVersion: 1,
      sessionId: 'operator-test-1',
      inputId: operator.inputId,
      routeKey: 'operator|ag-main|operator-test-1',
      leaseId: 'operator-lease-1',
    });
    expect(JSON.parse(fs.readFileSync(operator.activeLeasePath, 'utf8'))).toMatchObject({
      agentGroupId: 'ag-main',
      sessionId: 'operator-test-1',
      leaseId: 'operator-lease-1',
    });

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = {
      schema_version: 2,
      audit_id: 'operator-audit-1',
      profile: 'nanoclaw',
      account_label: 'glowforge',
      account_email: 'dan@glowforge.com',
      input_id: operator.inputId,
      route_key: operator.routeKey,
      service: 'drive',
      method: 'files.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-07-21T15:01:00.000Z',
      result_digest: 'operator-result-digest',
    };
    const payload = canonicalSideEffectPayload(signed);
    const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
    fs.appendFileSync(
      operator.ledgerPath,
      `${JSON.stringify({
        kind: 'gws_mutation_completed',
        payload_schema_version: 2,
        audit_id: signed.audit_id,
        profile: signed.profile,
        account_label: signed.account_label,
        account_email: signed.account_email,
        input_id: signed.input_id,
        route_key: signed.route_key,
        operation: `${signed.service} ${signed.method}`,
        occurred_at: signed.occurred_at,
        response_input_id: signed.input_id,
        response_route_key: signed.route_key,
        response_service: signed.service,
        response_method: signed.method,
        signature,
        payload,
        evidence: {},
      })}\n`,
    );

    expect(() =>
      finalizeOperatorGwsSession({
        operator,
        containerStopped: false,
        auditStorePath,
        gwsPublicKey: undefined,
      }),
    ).toThrow('confirmed stopped');
    expect(fs.existsSync(operator.correlationPath)).toBe(true);
    expect(fs.existsSync(operator.ledgerPath)).toBe(true);

    const result = finalizeOperatorGwsSession({
      operator,
      containerStopped: true,
      auditStorePath,
      gwsPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      stoppedAt: '2026-07-21T15:02:00.000Z',
    });

    expect(result).toEqual({ imported: 1, skipped: 0, validated: 1 });
    expect(fs.existsSync(operator.correlationPath)).toBe(false);
    expect(fs.existsSync(operator.activeLeasePath)).toBe(false);
    expect(fs.existsSync(operator.ledgerPath)).toBe(true);
    expect(fs.existsSync(operator.reconciliationReceiptPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(operator.reconciliationReceiptPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      operatorId: 'operator-test-1',
      leaseId: 'operator-lease-1',
      importResult: result,
    });

    const db = new Database(operator.outboundDbPath, { readonly: true });
    try {
      expect(db.prepare('SELECT id, account_label, input_id, route_key FROM side_effect_ledger').all()).toEqual([
        {
          id: signed.audit_id,
          account_label: 'glowforge',
          input_id: operator.inputId,
          route_key: operator.routeKey,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('discovers an audit-only completed write from the exact operator kill window before releasing authority', () => {
    const base = tempRoot('nanoclaw-operator-audit-only');
    const operator = startOperatorGwsSession({
      root: path.join(base, 'operator-session'),
      agentGroupId: 'ag-main',
      groupFolder: 'main',
      operatorId: 'operator-audit-only',
      containerUid: process.getuid?.() ?? 0,
      containerGid: process.getgid?.() ?? 0,
      acceptedAt: '2026-07-21T16:00:00.000Z',
      leaseId: 'operator-lease-audit-only',
    });
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = {
      schema_version: 2,
      audit_id: 'operator-audit-only-write',
      profile: 'nanoclaw',
      account_label: 'personal',
      account_email: 'dan@danshapiro.com',
      input_id: operator.inputId,
      route_key: operator.routeKey,
      service: 'gmail',
      method: 'users.drafts.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-07-21T16:00:05.000Z',
      result_digest: 'operator-audit-only-result',
    };
    const payload = canonicalSideEffectPayload(signed);
    const auditStorePath = path.join(base, 'gws-audit.jsonl');
    fs.writeFileSync(
      auditStorePath,
      `${JSON.stringify({
        ...signed,
        payload,
        signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64'),
      })}\n`,
    );

    const result = finalizeOperatorGwsSession({
      operator,
      containerStopped: true,
      auditStorePath,
      gwsPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      stoppedAt: '2026-07-21T16:00:10.000Z',
    });

    expect(result).toEqual({ imported: 0, skipped: 0, validated: 0 });
    expect(fs.existsSync(operator.correlationPath)).toBe(false);
    expect(fs.existsSync(operator.activeLeasePath)).toBe(false);
    const db = new Database(operator.outboundDbPath, { readonly: true });
    try {
      const row = db
        .prepare('SELECT id, account_label, input_id, route_key, validation_json FROM side_effect_ledger')
        .get() as Record<string, unknown>;
      expect(row).toMatchObject({
        id: signed.audit_id,
        account_label: 'personal',
        input_id: operator.inputId,
        route_key: operator.routeKey,
      });
      expect(JSON.parse(String(row.validation_json))).toMatchObject({ authoritative: true });
    } finally {
      db.close();
    }
  });

  it('retains authority across missing/truncated audit and unresolved evidence, then retries atomically', () => {
    const base = tempRoot('nanoclaw-operator-audit-retry');
    const operator = startOperatorGwsSession({
      root: path.join(base, 'operator-session'),
      agentGroupId: 'ag-main',
      groupFolder: 'main',
      operatorId: 'operator-audit-retry',
      containerUid: process.getuid?.() ?? 0,
      containerGid: process.getgid?.() ?? 0,
      acceptedAt: '2026-07-21T17:00:00.000Z',
      leaseId: 'operator-lease-audit-retry',
    });
    const auditStorePath = path.join(base, 'gws-audit.jsonl');
    const publicKeyPair = crypto.generateKeyPairSync('ed25519');
    const publicKey = publicKeyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const assertRetained = () => {
      expect(fs.existsSync(operator.correlationPath)).toBe(true);
      expect(fs.existsSync(operator.activeLeasePath)).toBe(true);
      expect(fs.existsSync(operator.reconciliationReceiptPath)).toBe(false);
    };

    expect(() =>
      finalizeOperatorGwsSession({
        operator,
        containerStopped: true,
        auditStorePath,
        gwsPublicKey: publicKey,
        stoppedAt: '2026-07-21T17:00:10.000Z',
      }),
    ).toThrow(/audit/i);
    assertRetained();

    fs.writeFileSync(auditStorePath, '');
    fs.writeFileSync(operator.ledgerPath, '{"truncated":true');
    expect(() =>
      finalizeOperatorGwsSession({
        operator,
        containerStopped: true,
        auditStorePath,
        gwsPublicKey: publicKey,
        stoppedAt: '2026-07-21T17:00:10.000Z',
      }),
    ).toThrow(/truncated|complete/i);
    assertRetained();

    fs.writeFileSync(operator.ledgerPath, '');
    fs.writeFileSync(auditStorePath, '{"truncated":true');
    expect(() =>
      finalizeOperatorGwsSession({
        operator,
        containerStopped: true,
        auditStorePath,
        gwsPublicKey: publicKey,
        stoppedAt: '2026-07-21T17:00:10.000Z',
      }),
    ).toThrow(/truncated|complete/i);
    assertRetained();

    const signed = {
      schema_version: 2,
      audit_id: 'operator-retry-write',
      profile: 'nanoclaw',
      account_label: 'glowforge',
      account_email: 'dan@glowforge.com',
      input_id: operator.inputId,
      route_key: operator.routeKey,
      service: 'drive',
      method: 'files.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-07-21T17:00:05.000Z',
      result_digest: 'operator-retry-result',
    };
    const payload = canonicalSideEffectPayload(signed);
    fs.writeFileSync(
      operator.ledgerPath,
      `${JSON.stringify({
        kind: 'gws_mutation_completed',
        payload_schema_version: 2,
        audit_id: signed.audit_id,
        profile: signed.profile,
        account_label: signed.account_label,
        account_email: signed.account_email,
        input_id: signed.input_id,
        route_key: signed.route_key,
        operation: `${signed.service} ${signed.method}`,
        occurred_at: signed.occurred_at,
        response_input_id: signed.input_id,
        response_route_key: signed.route_key,
        response_service: signed.service,
        response_method: signed.method,
        signature: 'forged-signature',
        payload,
        evidence: {},
      })}\n`,
    );
    fs.writeFileSync(auditStorePath, '');
    expect(() =>
      finalizeOperatorGwsSession({
        operator,
        containerStopped: true,
        auditStorePath,
        gwsPublicKey: publicKey,
        stoppedAt: '2026-07-21T17:00:10.000Z',
      }),
    ).toThrow(/unresolved/i);
    assertRetained();

    fs.writeFileSync(
      auditStorePath,
      `${JSON.stringify({
        ...signed,
        payload,
        signature: crypto.sign(null, Buffer.from(payload), publicKeyPair.privateKey).toString('base64'),
      })}\n`,
    );
    expect(() =>
      finalizeOperatorGwsSession({
        operator,
        containerStopped: true,
        auditStorePath,
        gwsPublicKey: publicKey,
        stoppedAt: '2026-07-21T17:00:10.000Z',
      }),
    ).not.toThrow();
    expect(fs.existsSync(operator.correlationPath)).toBe(false);
    expect(fs.existsSync(operator.activeLeasePath)).toBe(false);
    expect(fs.existsSync(operator.reconciliationReceiptPath)).toBe(true);
    const db = new Database(operator.outboundDbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT validation_json FROM side_effect_ledger WHERE id = ?').get(signed.audit_id) as {
        validation_json: string;
      };
      expect(JSON.parse(row.validation_json)).toMatchObject({ authoritative: true });
    } finally {
      db.close();
    }
  });

  it.each([
    ['forged preseed', 'forged'],
    ['tampered duplicated binding', 'tampered'],
    ['valid but out-of-scope preseed', 'out-of-scope'],
  ])('re-verifies stored GWS evidence instead of trusting %s validation metadata', (_label, mode) => {
    const base = tempRoot(`nanoclaw-operator-db-${mode}`);
    const operator = startOperatorGwsSession({
      root: path.join(base, 'operator-session'),
      agentGroupId: 'ag-main',
      groupFolder: 'main',
      operatorId: `operator-db-${mode}`,
      containerUid: process.getuid?.() ?? 0,
      containerGid: process.getgid?.() ?? 0,
      acceptedAt: '2026-07-21T18:00:00.000Z',
      leaseId: `operator-lease-${mode}`,
    });
    const auditStorePath = path.join(base, 'gws-audit.jsonl');
    fs.writeFileSync(auditStorePath, '');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = {
      schema_version: 2,
      audit_id: `operator-db-${mode}-write`,
      profile: 'nanoclaw',
      account_label: 'glowforge',
      account_email: 'dan@glowforge.com',
      input_id: mode === 'out-of-scope' ? 'operator:different-operator' : operator.inputId,
      route_key: mode === 'out-of-scope' ? 'operator|ag-other|different-operator' : operator.routeKey,
      service: 'drive',
      method: 'files.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-07-21T18:00:05.000Z',
      result_digest: `operator-db-${mode}-result`,
    };
    const payload = canonicalSideEffectPayload(signed);
    const signature =
      mode === 'forged'
        ? 'forged-but-validation-json-claims-authoritative'
        : crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
    const db = new Database(operator.outboundDbPath);
    try {
      db.prepare(
        `INSERT INTO side_effect_ledger
           (id, source, kind, operation, payload_schema_version, profile, account_label, account_email,
            input_id, route_key, signed_payload, signature, evidence_json, validation_json, replay_policy,
            occurred_at, imported_at)
         VALUES (?, 'gws', 'gws_mutation_completed', ?, 2, ?, ?, ?, ?, ?, ?, ?, '{}', ?,
                 'no_duplicate_operation', ?, ?)`,
      ).run(
        signed.audit_id,
        `${signed.service} ${signed.method}`,
        signed.profile,
        mode === 'tampered' ? 'personal' : signed.account_label,
        mode === 'tampered' ? 'dan@danshapiro.com' : signed.account_email,
        signed.input_id,
        signed.route_key,
        payload,
        signature,
        JSON.stringify({ authoritative: true, reason: 'container-controlled-claim' }),
        signed.occurred_at,
        signed.occurred_at,
      );
    } finally {
      db.close();
    }

    expect(() =>
      finalizeOperatorGwsSession({
        operator,
        containerStopped: true,
        auditStorePath,
        gwsPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        stoppedAt: '2026-07-21T18:00:10.000Z',
      }),
    ).toThrow(/unresolved|scope|binding|authoritative/i);
    expect(fs.existsSync(operator.correlationPath)).toBe(true);
    expect(fs.existsSync(operator.activeLeasePath)).toBe(true);
    expect(fs.existsSync(operator.reconciliationReceiptPath)).toBe(false);
  });

  it('retains authority for signed completed-audit-failed evidence missing its outer audit id', () => {
    const base = tempRoot('nanoclaw-operator-missing-outer-id');
    const operator = startOperatorGwsSession({
      root: path.join(base, 'operator-session'),
      agentGroupId: 'ag-main',
      groupFolder: 'main',
      operatorId: 'operator-missing-outer-id',
      containerUid: process.getuid?.() ?? 0,
      containerGid: process.getgid?.() ?? 0,
      acceptedAt: '2026-07-21T19:00:00.000Z',
      leaseId: 'operator-lease-missing-outer-id',
    });
    const auditStorePath = path.join(base, 'gws-audit.jsonl');
    fs.writeFileSync(auditStorePath, '');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const signed = {
      schema_version: 2,
      audit_id: 'signed-id-with-missing-outer-binding',
      profile: 'nanoclaw',
      account_label: 'personal',
      account_email: 'dan@danshapiro.com',
      input_id: operator.inputId,
      route_key: operator.routeKey,
      service: 'gmail',
      method: 'users.drafts.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-07-21T19:00:05.000Z',
      result_digest: 'completed-but-global-audit-failed',
    };
    const payload = canonicalSideEffectPayload(signed);
    fs.writeFileSync(
      operator.ledgerPath,
      `${JSON.stringify({
        kind: 'gmail_draft_created',
        payload_schema_version: 2,
        profile: signed.profile,
        account_label: signed.account_label,
        account_email: signed.account_email,
        input_id: signed.input_id,
        route_key: signed.route_key,
        operation: `${signed.service} ${signed.method}`,
        occurred_at: signed.occurred_at,
        response_input_id: signed.input_id,
        response_route_key: signed.route_key,
        response_service: signed.service,
        response_method: signed.method,
        signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64'),
        payload,
        outcome: 'completed_audit_failed',
        evidence: {},
      })}\n`,
    );

    expect(() =>
      finalizeOperatorGwsSession({
        operator,
        containerStopped: true,
        auditStorePath,
        gwsPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        stoppedAt: '2026-07-21T19:00:10.000Z',
      }),
    ).toThrow(/unresolved|missing|audit/i);
    expect(fs.existsSync(operator.correlationPath)).toBe(true);
    expect(fs.existsSync(operator.activeLeasePath)).toBe(true);
    expect(fs.existsSync(operator.reconciliationReceiptPath)).toBe(false);
  });

  it.each([
    ['signed payload is current but outer bindings are stale', 'payload-current-outer-stale', true],
    ['outer bindings are current but signed payload and timestamp disagree', 'outer-current-payload-other', true],
    ['authoritative exact evidence is outside the operator window', 'exact-outside-window', true],
    ['unrelated malformed evidence belongs to another session', 'unrelated-other-session', false],
  ])('%s', (_label, mode, shouldRetain) => {
    const base = tempRoot(`nanoclaw-operator-audit-candidate-${mode}`);
    const operator = startOperatorGwsSession({
      root: path.join(base, 'operator-session'),
      agentGroupId: 'ag-main',
      groupFolder: 'main',
      operatorId: `operator-audit-candidate-${mode}`,
      containerUid: process.getuid?.() ?? 0,
      containerGid: process.getgid?.() ?? 0,
      acceptedAt: '2026-07-21T20:00:00.000Z',
      leaseId: `operator-lease-audit-candidate-${mode}`,
    });
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const signedUsesCurrentIds = mode === 'payload-current-outer-stale' || mode === 'exact-outside-window';
    const malformedTime = mode === 'unrelated-other-session';
    const signed = {
      schema_version: 2,
      audit_id: `operator-audit-candidate-${mode}-write`,
      profile: 'nanoclaw',
      account_label: 'glowforge',
      account_email: 'dan@glowforge.com',
      input_id: signedUsesCurrentIds ? operator.inputId : 'operator:different-session',
      route_key: signedUsesCurrentIds ? operator.routeKey : 'operator|ag-other|different-session',
      service: 'drive',
      method: 'files.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at:
        mode === 'exact-outside-window'
          ? '2026-07-21T19:59:59.000Z'
          : malformedTime
            ? 'not-a-timestamp'
            : '2026-07-21T20:00:05.000Z',
      result_digest: `operator-audit-candidate-${mode}-result`,
    };
    const payload = canonicalSideEffectPayload(signed);
    const outer = {
      ...signed,
      ...(mode === 'payload-current-outer-stale'
        ? {
            input_id: 'operator:stale-outer-session',
            route_key: 'operator|ag-stale|stale-outer-session',
            occurred_at: '2026-07-20T20:00:05.000Z',
          }
        : {}),
      ...(mode === 'outer-current-payload-other'
        ? { input_id: operator.inputId, route_key: operator.routeKey, occurred_at: 'not-a-timestamp' }
        : {}),
      payload,
      signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64'),
    };
    const auditStorePath = path.join(base, 'gws-audit.jsonl');
    fs.writeFileSync(auditStorePath, `${JSON.stringify(outer)}\n`);

    const finalize = () =>
      finalizeOperatorGwsSession({
        operator,
        containerStopped: true,
        auditStorePath,
        gwsPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
        stoppedAt: '2026-07-21T20:00:10.000Z',
      });

    if (shouldRetain) {
      expect(finalize).toThrow(/unresolved|scope|window|binding/i);
      expect(fs.existsSync(operator.correlationPath)).toBe(true);
      expect(fs.existsSync(operator.activeLeasePath)).toBe(true);
      expect(fs.existsSync(operator.reconciliationReceiptPath)).toBe(false);
    } else {
      expect(finalize).not.toThrow();
      expect(fs.existsSync(operator.correlationPath)).toBe(false);
      expect(fs.existsSync(operator.activeLeasePath)).toBe(false);
      expect(fs.existsSync(operator.reconciliationReceiptPath)).toBe(true);
    }
  });
});
