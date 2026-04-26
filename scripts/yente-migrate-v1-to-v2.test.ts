import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyYenteMigration,
  createMigrationDryRun,
  writeMigrationReport,
  type YenteMigrationReport,
} from './yente-migrate-v1-to-v2.js';

let tempDir: string;
let stateRoot: string;
let configRoot: string;
let stagingMapPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yente-migration-test-'));
  stateRoot = path.join(tempDir, 'shared');
  configRoot = path.join(tempDir, 'config');
  stagingMapPath = path.join(configRoot, 'staging-channel-map.json');
  createMigrationFixture(stateRoot, configRoot);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('yente v1-to-v2 migration dry-run', () => {
  it('reports source state, provider policy, continuation decisions, and staging rewrites without secrets', () => {
    const report = createMigrationDryRun({
      stateRoot,
      configRoot,
      assistantName: 'Yente',
      target: 'staging',
      stagingChannelMapPath: stagingMapPath,
      checkedAt: '2026-04-26T00:00:00.000Z',
    });

    expect(report.migrationVersion).toBe('yente-v1-to-v2@1');
    expect(report.target).toBe('staging');
    expect(report.sourceStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.v1DbHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.stagingChannelMapHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.providerPolicyEvidence[0]).toMatchObject({
      provider: 'claude-code',
      officialDocsUrl: 'https://docs.anthropic.com/en/docs/claude-code/settings',
      checkedAt: '2026-04-26T00:00:00.000Z',
      decision: 'preserve',
    });

    expect(report.inventory.source.chats).toHaveLength(4);
    expect(report.inventory.source.groups.map((g) => g.folder).sort()).toEqual(['chava', 'cli-smoke', 'main']);
    expect(report.inventory.source.tasks.map((t) => t.id).sort()).toEqual(['task-once', 'task-recurring']);
    expect(report.continuations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupFolder: 'main',
          oldSessionId: 'old-main-session',
          claudeStateCopied: true,
          requiresOperatorApproval: false,
        }),
        expect.objectContaining({
          groupFolder: 'chava',
          oldSessionId: 'old-chava-session',
          claudeStateCopied: true,
          requiresOperatorApproval: false,
        }),
      ]),
    );
    expect(report.messagingGroupMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          oldJid: 'dc:guild-1:chan-prod',
          channelType: 'discord',
          sourcePlatformId: 'guild-1:chan-prod',
          targetPlatformId: 'stage-discord-chan',
          stagingQuarantined: false,
        }),
        expect.objectContaining({
          oldJid: 'cli:smoke',
          channelType: 'cli',
          sourcePlatformId: 'cli:smoke',
          targetPlatformId: null,
          stagingQuarantined: true,
        }),
      ]),
    );
    expect(report.remoteControl).toEqual({
      stateFile: 'data/remote-control.json',
      liveDependency: false,
      usageEvidence: true,
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('provider-secret-token');
    expect(serialized).not.toContain('fixture-stale-provider-setting');
  });
});

describe('yente v1-to-v2 migration apply', () => {
  it('requires an authoritative dry-run report and refuses stale or unsafe apply input', () => {
    expect(() =>
      applyYenteMigration({
        stateRoot,
        configRoot,
        assistantName: 'Yente',
        target: 'staging',
        stagingChannelMapPath: stagingMapPath,
        reportPath: path.join(tempDir, 'apply.json'),
      }),
    ).toThrow(/--dry-run-report is required/);

    const reportPath = writeGoodDryRunReport('staging');
    const stale = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as YenteMigrationReport;
    stale.sourceStateHash = '0'.repeat(64);
    const stalePath = path.join(tempDir, 'stale-report.json');
    fs.writeFileSync(stalePath, JSON.stringify(stale, null, 2));

    expect(() =>
      applyYenteMigration({
        stateRoot,
        configRoot,
        assistantName: 'Yente',
        target: 'staging',
        stagingChannelMapPath: stagingMapPath,
        dryRunReportPath: stalePath,
        reportPath: path.join(tempDir, 'apply.json'),
      }),
    ).toThrow(/source state hash does not match/);

    const prodReportPath = writeGoodDryRunReport('prod');
    expect(() =>
      applyYenteMigration({
        stateRoot,
        configRoot,
        assistantName: 'Yente',
        target: 'prod',
        dryRunReportPath: prodReportPath,
        reportPath: path.join(tempDir, 'prod-apply.json'),
      }),
    ).toThrow(/--confirm-prod is required/);

    const missingProviderPolicy = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as YenteMigrationReport;
    missingProviderPolicy.providerPolicyEvidence = [];
    const missingPolicyPath = path.join(tempDir, 'missing-policy.json');
    fs.writeFileSync(missingPolicyPath, JSON.stringify(missingProviderPolicy, null, 2));
    expect(() =>
      applyYenteMigration({
        stateRoot,
        configRoot,
        assistantName: 'Yente',
        target: 'staging',
        stagingChannelMapPath: stagingMapPath,
        dryRunReportPath: missingPolicyPath,
        reportPath: path.join(tempDir, 'apply.json'),
      }),
    ).toThrow(/provider policy evidence/);
  });

  it('migrates central DB rows, sessions, continuations, scheduled tasks, and filesystem state idempotently', () => {
    const oldSkillDir = path.join(stateRoot, 'data', 'sessions', 'main', '.claude', 'skills', 'FullQAPass');
    fs.mkdirSync(oldSkillDir, { recursive: true });
    fs.writeFileSync(path.join(oldSkillDir, 'SKILL.md'), '# legacy skill copy\n');
    const reportPath = writeGoodDryRunReport('staging');
    const v1DbPath = path.join(stateRoot, 'store', 'messages.db');
    const beforeDbHash = sha256File(v1DbPath);

    const applyReport = applyYenteMigration({
      stateRoot,
      configRoot,
      assistantName: 'Yente',
      target: 'staging',
      stagingChannelMapPath: stagingMapPath,
      dryRunReportPath: reportPath,
      reportPath: path.join(tempDir, 'apply.json'),
    });

    expect(sha256File(v1DbPath)).toBe(beforeDbHash);
    expect(applyReport.applied).toBe(true);

    const db = new Database(path.join(stateRoot, 'data', 'v2.db'));
    expect((db.prepare('SELECT COUNT(*) AS c FROM agent_groups').get() as { c: number }).c).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS c FROM messaging_groups').get() as { c: number }).c).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS c FROM messaging_group_agents').get() as { c: number }).c).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c).toBeGreaterThanOrEqual(4);
    expect((db.prepare('SELECT COUNT(*) AS c FROM user_roles').get() as { c: number }).c).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS c FROM agent_group_members').get() as { c: number }).c).toBe(2);
    expect(db.prepare("SELECT platform_id FROM messaging_groups WHERE channel_type = 'discord'").get()).toEqual({
      platform_id: 'stage-discord-chan',
    });

    const mainContinuation = applyReport.continuations.find((c) => c.groupFolder === 'main');
    expect(mainContinuation).toBeDefined();
    const mainAgentGroup = db.prepare("SELECT id FROM agent_groups WHERE folder = 'main'").get() as { id: string };
    const mainSessionRows = db
      .prepare("SELECT * FROM sessions WHERE agent_group_id = ? AND status = 'active'")
      .all(mainAgentGroup.id);
    expect(mainSessionRows).toHaveLength(1);
    db.close();

    const oldClaude = path.join(stateRoot, 'data', 'sessions', 'main', '.claude');
    const copiedClaude = path.join(stateRoot, 'data', 'v2-sessions', mainAgentGroup.id, '.claude-shared');
    expect(fs.existsSync(path.join(oldClaude, 'projects', '-workspace-group', 'old-main-session.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(copiedClaude, 'projects', '-workspace-group', 'old-main-session.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(copiedClaude, '.credentials.json'))).toBe(false);
    expect(fs.existsSync(path.join(copiedClaude, 'skills', 'FullQAPass'))).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'groups', 'main', 'container.json'))).toBe(true);
    expect(fs.existsSync(path.join(copiedClaude, 'settings.json'))).toBe(true);

    const outboundDb = new Database(
      path.join(stateRoot, 'data', 'v2-sessions', mainAgentGroup.id, mainContinuation!.newSessionId, 'outbound.db'),
      { readonly: true },
    );
    expect(outboundDb.prepare("SELECT value FROM session_state WHERE key = 'continuation:claude'").get()).toEqual({
      value: 'old-main-session',
    });
    outboundDb.close();

    const inboundDb = new Database(
      path.join(stateRoot, 'data', 'v2-sessions', mainAgentGroup.id, mainContinuation!.newSessionId, 'inbound.db'),
      { readonly: true },
    );
    const taskRows = inboundDb.prepare("SELECT * FROM messages_in WHERE kind = 'task'").all() as Array<{
      id: string;
      seq: number;
      process_after: string | null;
      recurrence: string | null;
      platform_id: string | null;
      channel_type: string | null;
      content: string;
      series_id: string | null;
    }>;
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].seq % 2).toBe(0);
    expect(taskRows[0].series_id).toBe('task-recurring');
    expect(taskRows[0].process_after).toBe('2026-04-26T01:00:00.000Z');
    expect(taskRows[0].recurrence).toBe('0 * * * *');
    expect(taskRows[0].platform_id).toBe('stage-discord-chan');
    expect(taskRows[0].channel_type).toBe('discord');
    inboundDb.close();

    const secondApply = applyYenteMigration({
      stateRoot,
      configRoot,
      assistantName: 'Yente',
      target: 'staging',
      stagingChannelMapPath: stagingMapPath,
      dryRunReportPath: reportPath,
      reportPath: path.join(tempDir, 'apply-again.json'),
    });
    expect(secondApply.applied).toBe(true);
    const dbAgain = new Database(path.join(stateRoot, 'data', 'v2.db'));
    expect((dbAgain.prepare('SELECT COUNT(*) AS c FROM agent_groups').get() as { c: number }).c).toBe(3);
    dbAgain.close();
  });

  it('allows dry-run and apply reports to live inside the state root without changing source hash validation', () => {
    const report = createMigrationDryRun({
      stateRoot,
      configRoot,
      assistantName: 'Yente',
      target: 'staging',
      stagingChannelMapPath: stagingMapPath,
      checkedAt: '2026-04-26T00:00:00.000Z',
    });
    const reportPath = path.join(stateRoot, 'authoritative-migration-dry-run.json');
    writeMigrationReport(report, reportPath);

    expect(
      applyYenteMigration({
        stateRoot,
        configRoot,
        assistantName: 'Yente',
        target: 'staging',
        stagingChannelMapPath: stagingMapPath,
        dryRunReportPath: reportPath,
        reportPath: path.join(stateRoot, 'migration-apply-report.json'),
      }).applied,
    ).toBe(true);
  });

  it('quarantines unmapped due tasks in staging instead of leaving them active on production destinations', () => {
    fs.writeFileSync(
      stagingMapPath,
      JSON.stringify({
        channels: [
          {
            from: { channelType: 'whatsapp', platformId: '12015550100@s.whatsapp.net', threadId: null },
            to: { platformId: 'stage-whatsapp-dm', threadId: null },
          },
        ],
      }),
    );
    const reportPath = writeGoodDryRunReport('staging');
    const applyReport = applyYenteMigration({
      stateRoot,
      configRoot,
      assistantName: 'Yente',
      target: 'staging',
      stagingChannelMapPath: stagingMapPath,
      dryRunReportPath: reportPath,
      reportPath: path.join(tempDir, 'apply-quarantine.json'),
    });

    const quarantinedTask = applyReport.taskMappings.find((t) => t.oldTaskId === 'task-recurring');
    expect(quarantinedTask).toMatchObject({
      stagingQuarantined: true,
      activeDueAfterApply: false,
    });
  });

  it('requires explicit human approval before applying with unmigrated continuations', () => {
    fs.rmSync(path.join(stateRoot, 'data', 'sessions', 'chava', '.claude'), { recursive: true, force: true });
    const reportPath = writeGoodDryRunReport('staging');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as YenteMigrationReport;
    expect(report.continuations.find((c) => c.groupFolder === 'chava')?.requiresOperatorApproval).toBe(true);

    expect(() =>
      applyYenteMigration({
        stateRoot,
        configRoot,
        assistantName: 'Yente',
        target: 'staging',
        stagingChannelMapPath: stagingMapPath,
        dryRunReportPath: reportPath,
        reportPath: path.join(tempDir, 'apply-loss.json'),
      }),
    ).toThrow(/--allow-continuation-loss/);

    expect(
      applyYenteMigration({
        stateRoot,
        configRoot,
        assistantName: 'Yente',
        target: 'staging',
        stagingChannelMapPath: stagingMapPath,
        dryRunReportPath: reportPath,
        allowContinuationLoss: true,
        reportPath: path.join(tempDir, 'apply-loss-allowed.json'),
      }).applied,
    ).toBe(true);
  });
});

function writeGoodDryRunReport(target: 'staging' | 'prod'): string {
  const report = createMigrationDryRun({
    stateRoot,
    configRoot,
    assistantName: 'Yente',
    target,
    stagingChannelMapPath: target === 'staging' ? stagingMapPath : undefined,
    checkedAt: '2026-04-26T00:00:00.000Z',
  });
  const reportPath = path.join(tempDir, `${target}-dry-run.json`);
  writeMigrationReport(report, reportPath);
  return reportPath;
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createMigrationFixture(root: string, config: string): void {
  fs.mkdirSync(path.join(root, 'store'), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_SECRET=super-secret-token\n');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'env'), 'PROVIDER_TOKEN=provider-secret-token\n');
  fs.writeFileSync(path.join(root, 'data', 'remote-control.json'), JSON.stringify({ status: 'ended' }));
  fs.mkdirSync(path.join(root, 'groups', 'main', 'browser-auth', 'example'), { recursive: true });
  fs.writeFileSync(path.join(root, 'groups', 'main', 'browser-auth', 'example', 'state.json'), '{"cookies":["x"]}');
  fs.mkdirSync(path.join(root, 'store', 'auth', 'baileys'), { recursive: true });
  fs.writeFileSync(path.join(root, 'store', 'auth', 'baileys', 'creds.json'), '{"secret":"x"}');

  for (const [folder, sessionId] of [
    ['main', 'old-main-session'],
    ['chava', 'old-chava-session'],
  ] as const) {
    const projectDir = path.join(root, 'data', 'sessions', folder, '.claude', 'projects', '-workspace-group');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'data', 'sessions', folder, '.claude', 'settings.json'),
      JSON.stringify({ model: 'fixture-stale-provider-setting', env: { PROVIDER_TOKEN: 'provider-secret-token' } }),
    );
    fs.writeFileSync(path.join(root, 'data', 'sessions', folder, '.claude', '.credentials.json'), '{"token":"x"}');
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{"type":"summary"}\n');
  }

  fs.writeFileSync(
    stagingMapPath,
    JSON.stringify({
      channels: [
        {
          from: { channelType: 'discord', platformId: 'guild-1:chan-prod', threadId: null },
          to: { platformId: 'stage-discord-chan', threadId: null },
        },
        {
          from: { channelType: 'whatsapp', platformId: '12015550100@s.whatsapp.net', threadId: null },
          to: { platformId: 'stage-whatsapp-dm', threadId: null },
        },
      ],
    }),
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
