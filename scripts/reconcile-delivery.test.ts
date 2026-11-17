import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

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
