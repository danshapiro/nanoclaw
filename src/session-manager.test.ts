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
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import {
  ensureDurableSideEffectLedger,
  initSessionFolder,
  materializeStagedAttachments,
  writeSessionMessage,
  inboundDbPath,
} from './session-manager.js';
import { attachmentStagingDir } from './yente/attachments.js';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-session-manager-data',
    GROUPS_DIR: '/tmp/nanoclaw-test-session-manager-data/groups',
  };
});

const TEST_DATA_DIR = '/tmp/nanoclaw-test-session-manager-data';

describe('ensureDurableSideEffectLedger', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-session-manager-'));
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-session-test',
      name: 'Session Test',
      folder: 'agent',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
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

  it('materializes a staged host file for the direct session-manager path', async () => {
    const stagingDir = attachmentStagingDir(TEST_DATA_DIR);
    fs.mkdirSync(stagingDir, { recursive: true });
    const sourcePath = path.join(stagingDir, 'session-manager.attachment');
    fs.writeFileSync(sourcePath, 'direct session-manager materialization');
    const content = JSON.stringify({
      text: 'Please read this.',
      attachments: [{ id: 'file-1', name: 'brief.docx', stagedHostPath: sourcePath }],
    });

    const materialized = await materializeStagedAttachments(
      'ag-session-test',
      'msg-session-materialize',
      'discord',
      content,
    );

    const parsed = JSON.parse(materialized) as {
      attachments: Array<{ workspacePath: string; sizeBytes: number; stagedHostPath?: string }>;
    };
    expect(parsed.attachments[0]?.workspacePath).toBe(
      '/workspace/agent/attachments/discord/msg-session-materialize/file-1-brief.docx',
    );
    expect(parsed.attachments[0]?.stagedHostPath).toBeUndefined();
    const hostPath = path.join(
      TEST_DATA_DIR,
      'groups',
      'agent',
      'attachments',
      'discord',
      'msg-session-materialize',
      'file-1-brief.docx',
    );
    expect(fs.readFileSync(hostPath, 'utf8')).toBe('direct session-manager materialization');
    expect(fs.statSync(hostPath).mode & 0o777).toBe(0o644);
  });

  it('rejects a staged host path outside the inbound staging and approval spool roots', async () => {
    const sourcePath = path.join(tmpRoot, 'untrusted.attachment');
    fs.writeFileSync(sourcePath, 'outside the owned roots');
    const content = JSON.stringify({
      attachments: [{ id: 'file-1', name: 'brief.docx', stagedHostPath: sourcePath }],
    });

    await expect(
      materializeStagedAttachments('ag-session-test', 'msg-outside-source', 'discord', content),
    ).rejects.toThrow(/staging|spool|source/i);
  });

  it('preserves agent-to-agent localPath attachments in writeSessionMessage', () => {
    const sessionId = 'agent-to-agent-session';
    initSessionFolder('ag-session-test', sessionId);
    const attachment = {
      name: 'report.docx',
      filename: 'report.docx',
      type: 'file',
      localPath: 'inbox/a2a-1/report.docx',
    };
    writeSessionMessage('ag-session-test', sessionId, {
      id: 'a2a-message-1',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      channelType: 'agent',
      content: JSON.stringify({ text: 'Review this file.', attachments: [attachment] }),
    });

    const inbound = new Database(inboundDbPath('ag-session-test', sessionId));
    try {
      const row = inbound.prepare('SELECT content FROM messages_in WHERE id = ?').get('a2a-message-1') as {
        content: string;
      };
      const parsed = JSON.parse(row.content) as { attachments: Array<{ localPath?: string }> };
      expect(parsed.attachments[0]?.localPath).toBe('inbox/a2a-1/report.docx');
    } finally {
      inbound.close();
    }
  });
});
