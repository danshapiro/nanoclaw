import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import {
  applyStoredDiscordTypingActivity,
  setTypingAdapter,
  setTypingContainerOwner,
  startTypingRefresh,
  stopTypingRefresh,
} from './modules/typing/index.js';

afterEach(() => {
  stopTypingRefresh('carrier');
  vi.useRealTimers();
});

it('transfers Bun activity to Node, rejects another owner, and recovers from a locked write', async () => {
  const bunOnPath = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  const bun =
    bunOnPath.status === 0
      ? 'bun'
      : path.join(os.homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  const root = path.join(process.cwd(), '.test-tmp');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'typing-carrier-'));
  const dbPath = path.join(dir, 'outbound.db');
  const db = new Database(dbPath);
  db.exec(
    'PRAGMA journal_mode=DELETE; CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)',
  );
  const writer = path.join(process.cwd(), 'container/agent-runner/src/typing-activity.test-writer.ts');
  const publish = (lease: string, destinations: unknown[], ids: string[] = []) =>
    spawnSync(bun, [writer, dbPath, lease, JSON.stringify(destinations), String(Date.now()), JSON.stringify(ids)], {
      encoding: 'utf8',
      timeout: 3000,
    });
  const read = () =>
    (db.prepare("SELECT value FROM session_state WHERE key = 'discord_typing_activity'").get() as { value: string })
      .value;
  const target = { platformId: 'channel', threadId: 'thread' };
  try {
    expect(publish('old', [target]).status).toBe(0);
    vi.useFakeTimers();
    const setTyping = vi.fn().mockResolvedValue(undefined);
    setTypingAdapter({ setTyping });
    setTypingContainerOwner('carrier', 'new');
    applyStoredDiscordTypingActivity('carrier', 'agent', read());
    expect(setTyping).not.toHaveBeenCalled();
    expect(publish('new', [target]).status).toBe(0);
    applyStoredDiscordTypingActivity('carrier', 'agent', read());
    expect(setTyping).toHaveBeenCalledWith('discord', 'channel', 'thread');
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      expect(publish('new', [target]).status).toBe(0);
      applyStoredDiscordTypingActivity('carrier', 'agent', read());
    }
    expect(setTyping.mock.calls.length).toBeGreaterThanOrEqual(11);
    db.exec('BEGIN; SELECT * FROM session_state');
    const blocked = publish('new', []);
    expect(blocked.status).not.toBe(0);
    expect(blocked.error).toBeUndefined();
    db.exec('ROLLBACK');
    startTypingRefresh('carrier', 'agent', 'discord', 'channel', 'thread', 'message-2');
    expect(publish('new', [], ['message-2']).status).toBe(0);
    applyStoredDiscordTypingActivity('carrier', 'agent', read());
    const calls = setTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8000);
    expect(setTyping).toHaveBeenCalledTimes(calls);
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
