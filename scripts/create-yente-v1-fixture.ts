import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface CreateYenteV1FixtureOptions {
  stateRoot: string;
  configRoot: string;
  profile?: 'full';
}

const FIXTURE_NOW = '2026-04-26T00:00:00.000Z';
const FIXTURE_MTIME = new Date(FIXTURE_NOW);

export function createYenteV1Fixture(options: CreateYenteV1FixtureOptions): void {
  const stateRoot = path.resolve(options.stateRoot);
  const configRoot = path.resolve(options.configRoot);
  const profile = options.profile ?? 'full';

  if (profile !== 'full') {
    throw new Error(`Unsupported fixture profile: ${profile}`);
  }
  assertFixturePath(stateRoot, 'state root');
  assertFixturePath(configRoot, 'config root');

  fs.mkdirSync(path.join(stateRoot, 'store'), { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  writeFile(path.join(stateRoot, '.env'), 'NANOCLAW_SECRET=super-secret-token\nPUBLIC_SHAPE=present\n');
  fs.mkdirSync(path.join(stateRoot, 'data'), { recursive: true });
  writeFile(path.join(stateRoot, 'data', 'env'), 'PROVIDER_TOKEN=provider-secret-token\n');
  writeFile(path.join(stateRoot, 'data', 'remote-control.json'), JSON.stringify({ status: 'ended' }));
  fs.mkdirSync(path.join(stateRoot, 'store', 'auth', 'baileys'), { recursive: true });
  writeFile(path.join(stateRoot, 'store', 'auth', 'baileys', 'creds.json'), '{"noiseKey":"secret"}');
  fs.mkdirSync(path.join(stateRoot, 'groups', 'main', 'browser-auth', 'example'), { recursive: true });
  writeFile(
    path.join(stateRoot, 'groups', 'main', 'browser-auth', 'example', 'state.json'),
    '{"cookies":["browser-secret-cookie"]}',
  );
  fs.mkdirSync(path.join(stateRoot, 'groups', 'main', 'inbox'), { recursive: true });
  writeFile(path.join(stateRoot, 'groups', 'main', 'inbox', 'attachment.txt'), 'non-secret attachment');

  for (const [folder, sessionId] of [
    ['main', 'old-main-session'],
    ['chava', 'old-chava-session'],
  ] as const) {
    const claudeDir = path.join(stateRoot, 'data', 'sessions', folder, '.claude');
    const projectDir = path.join(claudeDir, 'projects', '-workspace-group');
    fs.mkdirSync(projectDir, { recursive: true });
    writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ model: 'fixture-stale-provider-setting', env: { PROVIDER_TOKEN: 'provider-secret-token' } }),
    );
    writeFile(path.join(claudeDir, '.credentials.json'), '{"token":"x"}');
    writeFile(path.join(projectDir, `${sessionId}.jsonl`), '{"type":"summary"}\n');
  }

  writeFile(
    path.join(configRoot, 'staging-channel-map.json'),
    JSON.stringify(
      {
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
      },
      null,
      2,
    ) + '\n',
  );

  createMessagesDb(path.join(stateRoot, 'store', 'messages.db'));
  normalizeTreeMetadata(stateRoot);
  normalizeTreeMetadata(configRoot);
}

function createMessagesDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
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

    db.prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?)').run(
      'dc:guild-1:chan-prod',
      'Guild General',
      FIXTURE_NOW,
      'discord',
      1,
    );
    db.prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?)').run(
      'dc:dm:admin-user',
      'Admin DM',
      FIXTURE_NOW,
      'discord',
      0,
    );
    db.prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?)').run(
      '12015550100@s.whatsapp.net',
      'WhatsApp DM',
      FIXTURE_NOW,
      'whatsapp',
      0,
    );
    db.prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?)').run('cli:smoke', 'CLI Smoke', FIXTURE_NOW, 'cli', 0);
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'm1',
      'dc:guild-1:chan-prod',
      'known-user',
      'Known User',
      'hello',
      FIXTURE_NOW,
      0,
      0,
    );
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'm2',
      'dc:guild-1:chan-prod',
      'admin-user',
      'Admin User',
      '/remote-control',
      FIXTURE_NOW,
      0,
      0,
    );
    db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'm3',
      '12015550100@s.whatsapp.net',
      '12015550100@s.whatsapp.net',
      'Phone Sender',
      'hello',
      FIXTURE_NOW,
      0,
      0,
    );
    db.prepare('INSERT INTO registered_groups VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'dc:guild-1:chan-prod',
      'Yente Main',
      'main',
      '@Yente',
      FIXTURE_NOW,
      '{"packages":["ripgrep"]}',
      1,
      1,
    );
    db.prepare('INSERT INTO registered_groups VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      '12015550100@s.whatsapp.net',
      'Yente Chava',
      'chava',
      '@Yente',
      FIXTURE_NOW,
      null,
      0,
      0,
    );
    db.prepare('INSERT INTO registered_groups VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'cli:smoke',
      'CLI Smoke',
      'cli-smoke',
      '.',
      FIXTURE_NOW,
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
      FIXTURE_NOW,
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
      FIXTURE_NOW,
    );
    db.prepare(
      'INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('task-recurring', FIXTURE_NOW, 100, 'ok', 'done', null);
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
  } finally {
    db.close();
  }
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function assertFixturePath(candidate: string, label: string): void {
  if (candidate === path.parse(candidate).root) {
    throw new Error(`Refusing to write fixture ${label} at filesystem root`);
  }

  const denied = ['/srv/nanoclaw', '/srv/nanoclaw-staging', '/var/lib/nanoclaw', '/var/lib/nanoclaw-staging'];
  if (denied.some((root) => candidate === root || candidate.startsWith(`${root}/`))) {
    throw new Error(`Refusing to write fixture ${label} under live NanoClaw path: ${candidate}`);
  }
}

function normalizeTreeMetadata(root: string): void {
  const entries: string[] = [];
  collect(root, entries);
  for (const entry of entries.sort((a, b) => b.length - a.length)) {
    const stat = fs.lstatSync(entry);
    if (stat.isDirectory()) {
      fs.chmodSync(entry, 0o755);
    } else {
      fs.chmodSync(entry, 0o644);
    }
    fs.utimesSync(entry, FIXTURE_MTIME, FIXTURE_MTIME);
  }
}

function collect(entry: string, acc: string[]): void {
  acc.push(entry);
  if (!fs.lstatSync(entry).isDirectory()) return;
  for (const child of fs.readdirSync(entry)) {
    collect(path.join(entry, child), acc);
  }
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function stringArg(args: Record<string, string | boolean>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function requireString(args: Record<string, string | boolean>, key: string): string {
  const value = stringArg(args, key);
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  createYenteV1Fixture({
    stateRoot: requireString(args, 'state-root'),
    configRoot: requireString(args, 'config-root'),
    profile: (stringArg(args, 'profile') as 'full' | undefined) ?? 'full',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
