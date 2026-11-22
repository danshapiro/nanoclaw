import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const script = path.resolve('scripts/reconcile-delivery.ts');
let root: string, session: string, inbound: Database.Database, outbound: Database.Database;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'delivery-progress-'));
  session = path.join(root, 'v2-sessions', 'group', 'session');
  mkdirSync(session, { recursive: true });
  inbound = new Database(path.join(session, 'inbound.db'));
  inbound.exec(`CREATE TABLE delivery_attempts(message_out_id TEXT PRIMARY KEY,state TEXT,attempts INTEGER,last_error TEXT);
    CREATE TABLE delivered(message_out_id TEXT PRIMARY KEY,platform_message_id TEXT,status TEXT,delivered_at TEXT);`);
  inbound.prepare('INSERT INTO delivery_attempts VALUES (?,?,?,?)').run('message', 'unknown', 1, 'NetworkError');
  outbound = new Database(path.join(session, 'outbound.db'));
  outbound.exec('CREATE TABLE messages_out(id TEXT PRIMARY KEY, kind TEXT, content TEXT, timestamp TEXT)');
  outbound
    .prepare('INSERT INTO messages_out VALUES (?,?,?,?)')
    .run('message', 'chat', JSON.stringify({ text: "I'm still working on your request." }), '2020-01-01 00:00:00');
});
afterEach(() => {
  inbound.close();
  outbound.close();
  rmSync(root, { recursive: true, force: true });
});
function run(flag = '--confirmed-obsolete-progress', target = script, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', target, path.join(session, 'inbound.db'), 'message', flag, ...extra],
    { encoding: 'utf8', env: { ...process.env, NODE_PATH: path.resolve('node_modules') } },
  );
}
function retained() {
  expect(inbound.prepare('SELECT state,last_error FROM delivery_attempts').get()).toEqual({
    state: 'unknown',
    last_error: 'NetworkError',
  });
  expect(inbound.prepare('SELECT * FROM delivered').all()).toEqual([]);
}
describe('operator progress-only retirement', () => {
  it('records dropped, preserves original and never claims delivery', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no send or delivery claim');
    expect(inbound.prepare('SELECT status FROM delivered').get()).toEqual({ status: 'dropped' });
    expect(inbound.prepare('SELECT state,last_error FROM delivery_attempts').get()).toEqual({
      state: 'unknown',
      last_error: 'NetworkError',
    });
    expect(outbound.prepare('SELECT count(*) AS n FROM messages_out').get()).toEqual({ n: 1 });
  });
  it.each([
    { text: 'important result' },
    { text: "I'm still working on your request.", files: ['x'] },
    { text: "I'm still working on your request.", operation: 'edit' },
    [],
    null,
    'bad',
  ])('rejects substantive/extra/invalid payload %j', (payload) => {
    outbound.prepare('UPDATE messages_out SET content=?').run(JSON.stringify(payload));
    expect(run().status).not.toBe(0);
    retained();
  });
  it.each(['2020-bad', '2099-01-01 00:00:00', new Date().toISOString().slice(0, 19).replace('T', ' ')])(
    'rejects unsafe timestamp %s',
    (stamp) => {
      outbound.prepare('UPDATE messages_out SET timestamp=?').run(stamp);
      expect(run().status).not.toBe(0);
      retained();
    },
  );
  it('rejects non-chat and malformed JSON', () => {
    outbound.prepare('UPDATE messages_out SET kind=?').run('file');
    expect(run().status).not.toBe(0);
    retained();
    outbound.prepare('UPDATE messages_out SET kind=?,content=?').run('chat', '{');
    expect(run().status).not.toBe(0);
    retained();
  });
  it('preserves any existing receipt atomically', () => {
    inbound.prepare('INSERT INTO delivered VALUES (?,NULL,?,?)').run('message', 'delivered', 'old');
    expect(run().status).not.toBe(0);
    expect(inbound.prepare('SELECT status FROM delivered').get()).toEqual({ status: 'delivered' });
    expect(inbound.prepare('SELECT state FROM delivery_attempts').get()).toEqual({ state: 'unknown' });
  });
  it('rejects active sends instead of racing the poller', () => {
    inbound.prepare('UPDATE delivery_attempts SET state=?').run('sending');
    expect(run().status).not.toBe(0);
    expect(inbound.prepare('SELECT state FROM delivery_attempts').get()).toEqual({ state: 'sending' });
  });
  it('retains failed receipt if validation fails', () => {
    inbound.prepare('INSERT INTO delivered VALUES (?,NULL,?,?)').run('message', 'failed', 'old');
    outbound.prepare('UPDATE messages_out SET content=?').run('{"text":"valuable"}');
    expect(run().status).not.toBe(0);
    expect(inbound.prepare('SELECT status FROM delivered').get()).toEqual({ status: 'failed' });
  });
  it('is idempotent by refusal without changing the dropped receipt', () => {
    expect(run().status).toBe(0);
    const row = inbound.prepare('SELECT * FROM delivered').get();
    expect(run().status).not.toBe(0);
    expect(inbound.prepare('SELECT * FROM delivered').get()).toEqual(row);
  });
  it('can execute as a pinned temporary operator script using installed dependencies', () => {
    const staged = path.join(root, 'operator.ts');
    copyFileSync(script, staged);
    const result = run('--confirmed-obsolete-progress', staged);
    expect(result.status, result.stderr).toBe(0);
  });
  it('rejects extra arguments before writing', () => {
    expect(run('--confirmed-obsolete-progress', script, ['unexpected']).status).toBe(2);
    retained();
  });
  it('inspection stays read-only and the delivered operation remains supported', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, path.join(session, 'inbound.db')], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    retained();
    expect(run('--confirmed-delivered').status).toBe(0);
    expect(inbound.prepare('SELECT status FROM delivered').get()).toEqual({ status: 'delivered' });
  });
});

it.each(['--confirmed-obsolete-progress', '--confirmed-delivered'])(
  'retains stale-poller refusal guard after %s',
  (flag) => {
    const deliveredSnapshot = new Set(
      inbound
        .prepare('SELECT message_out_id FROM delivered')
        .all()
        .map((r: any) => r.message_out_id),
    );
    expect(deliveredSnapshot.has('message')).toBe(false);
    expect(run(flag).status).toBe(0);
    const prior = inbound.prepare('SELECT state FROM delivery_attempts WHERE message_out_id=?').get('message') as any;
    expect(['unknown', 'failed']).toContain(prior.state); // actual active9010 poller refuses these states
    const inspect = spawnSync(process.execPath, ['--import', 'tsx', script, path.join(session, 'inbound.db')], {
      encoding: 'utf8',
    });
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(JSON.parse(inspect.stdout)).toEqual([]);
  },
);

it('executes precompiled operator artifact without live esbuild execution', () => {
  const require = createRequire(import.meta.url);
  const compiler = createRequire(require.resolve('tsx'))('esbuild');
  const compiled = path.join(root, 'operator.cjs');
  compiler.buildSync({ entryPoints: [script], platform: 'node', format: 'cjs', outfile: compiled });
  const result = spawnSync(
    process.execPath,
    [compiled, path.join(session, 'inbound.db'), 'message', '--confirmed-obsolete-progress'],
    { encoding: 'utf8', env: { ...process.env, NODE_PATH: path.resolve('node_modules') } },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(inbound.prepare('SELECT status FROM delivered').get()).toEqual({ status: 'dropped' });
  expect(inbound.prepare('SELECT state FROM delivery_attempts').get()).toEqual({ state: 'unknown' });
});

describe('operator exact obsolete CLI smoke retirement', () => {
  const platform = 'cli-smoke:group:1234567890123-fixture';
  const mg = 'mg-cli-smoke-fixture';
  let central: Database.Database;
  beforeEach(() => {
    central = new Database(path.join(root, 'v2.db'));
    central.exec(`CREATE TABLE sessions(id TEXT,agent_group_id TEXT,messaging_group_id TEXT,thread_id TEXT,container_status TEXT);
      CREATE TABLE messaging_groups(id TEXT,channel_type TEXT,platform_id TEXT,is_group INTEGER);
      CREATE TABLE scheduled_tasks(messaging_group_id TEXT,projected_session_id TEXT,created_by_session_id TEXT,updated_by_session_id TEXT);`);
    central.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run('session', 'group', mg, null, 'stopped');
    central.prepare('INSERT INTO messaging_groups VALUES (?,?,?,?)').run(mg, 'cli', platform, 0);
    outbound.exec(`ALTER TABLE messages_out ADD COLUMN channel_type TEXT;
      ALTER TABLE messages_out ADD COLUMN platform_id TEXT;
      ALTER TABLE messages_out ADD COLUMN messaging_group_id TEXT;
      ALTER TABLE messages_out ADD COLUMN thread_id TEXT;
      ALTER TABLE messages_out ADD COLUMN input_id TEXT;
      ALTER TABLE messages_out ADD COLUMN route_key TEXT;
      ALTER TABLE messages_out ADD COLUMN is_group INTEGER;`);
    outbound
      .prepare(
        'UPDATE messages_out SET content=?,channel_type=?,platform_id=?,messaging_group_id=?,route_key=?,is_group=0',
      )
      .run(
        JSON.stringify({ text: 'Historical harness result' }),
        'cli',
        platform,
        mg,
        `codex|cli|${platform}|dm:${mg}`,
      );
    inbound.prepare('UPDATE delivery_attempts SET state=?,last_error=?').run('failed', 'Unknown CLI destination');
    inbound.prepare('INSERT INTO delivered VALUES (?,NULL,?,?)').run('message', 'failed', 'old');
  });
  afterEach(() => central.close());
  function hash() {
    return createHash('sha256')
      .update((outbound.prepare('SELECT content FROM messages_out').get() as any).content)
      .digest('hex');
  }
  function smoke(sha = hash()) {
    return run('--confirmed-obsolete-cli-smoke', script, [sha]);
  }
  function refused() {
    expect(smoke().status).not.toBe(0);
    expect(inbound.prepare('SELECT state,last_error FROM delivery_attempts').get()).toEqual({
      state: 'failed',
      last_error: 'Unknown CLI destination',
    });
    expect(inbound.prepare('SELECT status FROM delivered').get()).toEqual({ status: 'failed' });
  }
  it('records dropped while retaining exact source/error/guard and never replaying', () => {
    const original = outbound.prepare('SELECT * FROM messages_out').get();
    const result = smoke();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no send or delivery claim');
    expect(inbound.prepare('SELECT status FROM delivered').get()).toEqual({ status: 'dropped' });
    expect(inbound.prepare('SELECT state,last_error FROM delivery_attempts').get()).toEqual({
      state: 'failed',
      last_error: 'Unknown CLI destination',
    });
    expect(outbound.prepare('SELECT * FROM messages_out').get()).toEqual(original);
    expect(smoke().status).not.toBe(0);
    expect(inbound.prepare('SELECT status FROM delivered').get()).toEqual({ status: 'dropped' });
  });
  it('requires an exact operator-selected payload digest', () => {
    expect(run('--confirmed-obsolete-cli-smoke').status).toBe(2);
    expect(smoke('not-a-digest').status).toBe(2);
    expect(smoke('0'.repeat(64)).status).not.toBe(0);
    expect(inbound.prepare('SELECT status FROM delivered').get()).toEqual({ status: 'failed' });
  });
  it.each([
    ['channel_type', 'discord'],
    ['platform_id', 'discord:real'],
    ['messaging_group_id', 'real'],
    ['thread_id', 'thread'],
    ['input_id', 'human-input'],
    ['route_key', 'codex|discord|real|dm:real'],
    ['is_group', 1],
    ['kind', 'file'],
    ['timestamp', '2099-01-01 00:00:00'],
    ['timestamp', 'invalid'],
    ['timestamp', new Date().toISOString().slice(0, 19).replace('T', ' ')],
    ['content', JSON.stringify({ text: 'text', files: ['a'] })],
    ['content', JSON.stringify({ text: 'text', operation: 'edit' })],
    ['content', 'null'],
    ['content', '[]'],
    ['content', '{'],
    ['content', JSON.stringify({ text: '' })],
  ])('refuses unsafe outbound %s=%s atomically', (column, value) => {
    outbound.prepare(`UPDATE messages_out SET ${column}=?`).run(value);
    refused();
  });
  it.each(['running', 'starting', 'unknown'])('refuses a %s worker', (status) => {
    central.prepare('UPDATE sessions SET container_status=?').run(status);
    refused();
  });
  it('refuses missing or rebound sessions and real central routes', () => {
    central.prepare('UPDATE sessions SET messaging_group_id=?').run('real');
    refused();
    central.prepare('DELETE FROM sessions').run();
    refused();
  });
  it.each(['channel_type', 'platform_id'])('refuses central %s drift', (column) => {
    central.prepare(`UPDATE messaging_groups SET ${column}=?`).run('discord');
    refused();
  });
  it.each(['messaging_group_id', 'projected_session_id', 'created_by_session_id', 'updated_by_session_id'])(
    'protects scheduled work through %s',
    (column) => {
      central
        .prepare(`INSERT INTO scheduled_tasks (${column}) VALUES (?)`)
        .run(column === 'messaging_group_id' ? mg : 'session');
      refused();
    },
  );
  it('refuses active attempts and preserves a delivered receipt', () => {
    inbound.prepare('UPDATE delivery_attempts SET state=?').run('sending');
    expect(smoke().status).not.toBe(0);
    inbound.prepare('UPDATE delivery_attempts SET state=?').run('failed');
    inbound.prepare('UPDATE delivered SET status=?').run('delivered');
    expect(smoke().status).not.toBe(0);
    expect(inbound.prepare('SELECT status FROM delivered').get()).toEqual({ status: 'delivered' });
  });
});
