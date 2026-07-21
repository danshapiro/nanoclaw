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

    expect(() => finalizeOperatorGwsSession({ operator, containerStopped: false, gwsPublicKey: undefined })).toThrow(
      'confirmed stopped',
    );
    expect(fs.existsSync(operator.correlationPath)).toBe(true);
    expect(fs.existsSync(operator.ledgerPath)).toBe(true);

    const result = finalizeOperatorGwsSession({
      operator,
      containerStopped: true,
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
});
