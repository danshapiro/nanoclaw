import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildYenteInventory, hashSourceState, sha256File, writeInventory } from './yente-inventory.js';

let tempDir: string;
let stateRoot: string;
let configRoot: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yente-inventory-test-'));
  stateRoot = path.join(tempDir, 'shared');
  configRoot = path.join(tempDir, 'config');
  createInventoryFixture(stateRoot, configRoot);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('yente inventory', () => {
  it('reports v1 state, credential material, provider policy, and remote-control evidence without secrets', () => {
    const inventory = buildYenteInventory({ stateRoot, configRoot, checkedAt: '2026-04-26T00:00:00.000Z' });

    expect(inventory.source.chats.map((c) => c.jid).sort()).toEqual([
      '12015550100@s.whatsapp.net',
      'cli:smoke',
      'dc:dm:admin-user',
      'dc:guild-1:chan-prod',
    ]);
    expect(inventory.source.groups.map((g) => g.folder).sort()).toEqual(['chava', 'cli-smoke', 'main']);
    expect(inventory.source.senders.map((s) => s.senderId).sort()).toEqual([
      '12015550100@s.whatsapp.net',
      'admin-user',
      'known-user',
      'owner-user',
    ]);
    expect(inventory.source.roles).toContainEqual({
      userId: 'discord:owner-user',
      role: 'owner',
      agentGroupFolder: null,
    });
    expect(inventory.source.tasks.map((t) => t.id).sort()).toEqual(['task-once', 'task-recurring']);
    expect(inventory.source.targetSessions.map((s) => s.groupFolder).sort()).toEqual(['chava', 'main']);
    expect(inventory.source.files).toEqual(
      expect.arrayContaining([
        'data/sessions/main/.claude/projects/-workspace-group/old-main-session.jsonl',
        'groups/main/browser-auth/example/state.json',
        'groups/main/inbox/attachment.txt',
        'store/messages.db',
      ]),
    );

    expect(inventory.credentialMaterial.map((c) => c.path).sort()).toEqual(
      expect.arrayContaining([
        '.env',
        'data/env',
        'data/sessions/main/.claude/.credentials.json',
        'data/sessions/main/.claude/settings.json',
        'groups/main/browser-auth/example/state.json',
        'store/auth/baileys/creds.json',
      ]),
    );
    expect(inventory.credentialMaterial.find((c) => c.path === '.env')?.keys).toEqual(['NANOCLAW_SECRET']);
    expect(inventory.providerPolicyEvidence).toEqual([
      {
        provider: 'claude-code',
        officialDocsUrl: 'https://docs.anthropic.com/en/docs/claude-code/settings',
        checkedAt: '2026-04-26T00:00:00.000Z',
        decision: 'preserve',
      },
    ]);
    expect(inventory.providerSettings).toEqual([
      {
        path: 'data/sessions/main/.claude/settings.json',
        provider: 'claude-code',
        keys: ['env', 'model'],
        hasModelPolicy: true,
        hasSecretEnv: true,
      },
    ]);
    expect(inventory.remoteControl).toEqual({
      stateFile: 'data/remote-control.json',
      liveDependency: false,
      usageEvidence: true,
    });

    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('provider-secret-token');
    expect(serialized).not.toContain('browser-secret-cookie');
    expect(serialized).not.toContain('fixture-stale-provider-setting');
  });

  it('writes inventory JSON to the requested path', () => {
    const outputJson = path.join(tempDir, 'inventory.json');
    const inventory = writeInventory({ stateRoot, configRoot, outputJson, checkedAt: '2026-04-26T00:00:00.000Z' });

    expect(fs.existsSync(outputJson)).toBe(true);
    expect(JSON.parse(fs.readFileSync(outputJson, 'utf8'))).toEqual(inventory);
  });

  it('hashes source files in chunks without whole-file reads', () => {
    const payload = Buffer.alloc(1024 * 1024 + 1, 7);
    const largePath = path.join(stateRoot, 'data', 'large-source.bin');
    fs.writeFileSync(largePath, payload);
    const expectedFileHash = crypto.createHash('sha256').update(payload).digest('hex');

    const originalReadFileSync = fs.readFileSync;
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      options?: Parameters<typeof fs.readFileSync>[1],
    ) => {
      if (typeof filePath === 'string' && path.resolve(filePath) === largePath) {
        throw new RangeError('File size (2670498298) is greater than 2 GiB');
      }
      return originalReadFileSync(filePath as never, options as never) as never;
    }) as typeof fs.readFileSync);

    try {
      expect(sha256File(largePath)).toBe(expectedFileHash);
      expect(hashSourceState(stateRoot)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      readFileSyncSpy.mockRestore();
    }
  });

  it('records unreadable credential files without opening their contents', () => {
    const envPath = path.join(stateRoot, '.env');
    fs.chmodSync(envPath, 0o000);

    try {
      const inventory = buildYenteInventory({ stateRoot, configRoot, checkedAt: '2026-04-26T00:00:00.000Z' });

      expect(hashSourceState(stateRoot)).toMatch(/^[a-f0-9]{64}$/);
      expect(inventory.credentialMaterial).toContainEqual({
        path: '.env',
        reason: 'environment file',
        keys: [],
        unreadable: true,
      });
      expect(JSON.stringify(inventory)).not.toContain('super-secret-token');
    } finally {
      fs.chmodSync(envPath, 0o600);
    }
  });

  it('excludes host backup directories from the source state hash', () => {
    const before = hashSourceState(stateRoot);
    const backupDir = path.join(stateRoot, 'backups', 'predeploy-archive');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'nanoclaw-state.tar.gz'), 'generated backup material');

    try {
      fs.chmodSync(backupDir, 0o000);
      expect(hashSourceState(stateRoot)).toBe(before);
    } finally {
      fs.chmodSync(backupDir, 0o700);
    }
  });
});

function createInventoryFixture(root: string, config: string): void {
  fs.mkdirSync(path.join(root, 'store'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_SECRET=super-secret-token\nPUBLIC_SHAPE=present\n');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'env'), 'PROVIDER_TOKEN=provider-secret-token\n');
  fs.writeFileSync(path.join(root, 'data', 'remote-control.json'), JSON.stringify({ status: 'ended' }));
  fs.mkdirSync(path.join(root, 'store', 'auth', 'baileys'), { recursive: true });
  fs.writeFileSync(path.join(root, 'store', 'auth', 'baileys', 'creds.json'), '{"noiseKey":"secret"}');
  fs.mkdirSync(path.join(root, 'groups', 'main', 'browser-auth', 'example'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'groups', 'main', 'browser-auth', 'example', 'state.json'),
    '{"cookies":["browser-secret-cookie"]}',
  );
  fs.mkdirSync(path.join(root, 'groups', 'main', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'groups', 'main', 'inbox', 'attachment.txt'), 'non-secret attachment');
  fs.mkdirSync(path.join(root, 'data', 'sessions', 'main', '.claude', 'projects', '-workspace-group'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, 'data', 'sessions', 'main', '.claude', 'settings.json'),
    JSON.stringify({ model: 'fixture-stale-provider-setting', env: { PROVIDER_TOKEN: 'provider-secret-token' } }),
  );
  fs.writeFileSync(path.join(root, 'data', 'sessions', 'main', '.claude', '.credentials.json'), '{"token":"x"}');
  fs.writeFileSync(
    path.join(root, 'data', 'sessions', 'main', '.claude', 'projects', '-workspace-group', 'old-main-session.jsonl'),
    '{"type":"summary"}\n',
  );

  const db = new Database(path.join(root, 'store', 'messages.db'));
  db.exec(`
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0
    );
    CREATE TABLE sessions (group_folder TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      script TEXT,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE TABLE task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT
    );
    CREATE TABLE known_senders (
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      channel_type TEXT NOT NULL,
      group_folder TEXT NOT NULL
    );
    CREATE TABLE admin_senders (
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      channel_type TEXT NOT NULL,
      role TEXT NOT NULL,
      group_folder TEXT
    );
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const now = '2026-04-26T00:00:00.000Z';
  db.prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?)').run(
    'dc:guild-1:chan-prod',
    'Guild General',
    now,
    'discord',
    1,
  );
  db.prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?)').run('dc:dm:admin-user', 'Admin DM', now, 'discord', 0);
  db.prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?)').run(
    '12015550100@s.whatsapp.net',
    'WhatsApp DM',
    now,
    'whatsapp',
    0,
  );
  db.prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?)').run('cli:smoke', 'CLI Smoke', now, 'cli', 0);
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'm1',
    'dc:guild-1:chan-prod',
    'known-user',
    'Known User',
    'hello',
    now,
    0,
    0,
  );
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'm2',
    'dc:guild-1:chan-prod',
    'admin-user',
    'Admin User',
    '/remote-control',
    now,
    0,
    0,
  );
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'm3',
    '12015550100@s.whatsapp.net',
    '12015550100@s.whatsapp.net',
    'Phone Sender',
    'hello',
    now,
    0,
    0,
  );
  db.prepare('INSERT INTO registered_groups VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'dc:guild-1:chan-prod',
    'Yente Main',
    'main',
    '@Yente',
    now,
    '{"packages":["ripgrep"]}',
    1,
    1,
  );
  db.prepare('INSERT INTO registered_groups VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    '12015550100@s.whatsapp.net',
    'Yente Chava',
    'chava',
    '@Yente',
    now,
    null,
    0,
    0,
  );
  db.prepare('INSERT INTO registered_groups VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'cli:smoke',
    'CLI Smoke',
    'cli-smoke',
    '.',
    now,
    null,
    0,
    0,
  );
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('main', 'old-main-session');
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('chava', 'old-chava-session');
  db.prepare('INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'task-recurring',
    'main',
    'dc:guild-1:chan-prod',
    'Recurring prompt',
    'echo ok',
    'cron',
    '0 * * * *',
    'shared',
    '2026-04-26T01:00:00.000Z',
    null,
    null,
    'active',
    now,
  );
  db.prepare('INSERT INTO scheduled_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'task-once',
    'chava',
    '12015550100@s.whatsapp.net',
    'One shot',
    null,
    'once',
    '',
    'isolated',
    '2026-04-27T01:00:00.000Z',
    null,
    null,
    'active',
    now,
  );
  db.prepare(
    'INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('task-recurring', now, 100, 'ok', 'done', null);
  db.prepare('INSERT INTO known_senders VALUES (?, ?, ?, ?)').run('known-user', 'Known User', 'discord', 'main');
  db.prepare('INSERT INTO known_senders VALUES (?, ?, ?, ?)').run(
    '12015550100@s.whatsapp.net',
    'Phone Sender',
    'whatsapp',
    'chava',
  );
  db.prepare('INSERT INTO admin_senders VALUES (?, ?, ?, ?, ?)').run(
    'owner-user',
    'Owner User',
    'discord',
    'owner',
    null,
  );
  db.prepare('INSERT INTO admin_senders VALUES (?, ?, ?, ?, ?)').run(
    'admin-user',
    'Admin User',
    'discord',
    'admin',
    'main',
  );
  db.prepare('INSERT INTO router_state VALUES (?, ?)').run('remote-control:last-command', '/remote-control');
  db.close();
}
