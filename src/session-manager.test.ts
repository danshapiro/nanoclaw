/**
 * Tests for session-manager host-side session directory helpers.
 *
 * Most session lifecycle behavior is exercised through consumer tests
 * (host-sweep, router, delivery). This file covers helpers whose contract
 * is filesystem durability, tested directly against a temp directory.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ensureDurableSideEffectLedger } from './session-manager.js';

describe('ensureDurableSideEffectLedger', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ledger-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates an empty side-effects.jsonl when missing', () => {
    const sessDir = path.join(tmpRoot, 'sess');
    fs.mkdirSync(sessDir, { recursive: true });
    ensureDurableSideEffectLedger(sessDir);

    const ledgerPath = path.join(sessDir, 'side-effects.jsonl');
    expect(fs.existsSync(ledgerPath)).toBe(true);
    expect(fs.statSync(ledgerPath).size).toBe(0);
  });

  it('is idempotent: repeated calls leave an empty ledger in place', () => {
    const sessDir = path.join(tmpRoot, 'sess');
    fs.mkdirSync(sessDir, { recursive: true });
    ensureDurableSideEffectLedger(sessDir);
    ensureDurableSideEffectLedger(sessDir);

    const ledgerPath = path.join(sessDir, 'side-effects.jsonl');
    expect(fs.existsSync(ledgerPath)).toBe(true);
    expect(fs.statSync(ledgerPath).size).toBe(0);
  });

  it('never truncates: pre-existing ledger content survives byte-for-byte', () => {
    const sessDir = path.join(tmpRoot, 'sess');
    fs.mkdirSync(sessDir, { recursive: true });
    const ledgerPath = path.join(sessDir, 'side-effects.jsonl');
    const content =
      JSON.stringify({ kind: 'gmail_draft_created', audit_id: 'a1' }) +
      '\n' +
      JSON.stringify({ kind: 'gws_mutation_completed', audit_id: 'a2' }) +
      '\n';
    fs.writeFileSync(ledgerPath, content);
    const before = fs.readFileSync(ledgerPath);

    ensureDurableSideEffectLedger(sessDir);

    const after = fs.readFileSync(ledgerPath);
    expect(after.equals(before)).toBe(true);
  });
});
