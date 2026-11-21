import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../../db/index.js';
import { inboundDbPath, initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { notifyAgent } from './primitive.js';

const fixture = vi.hoisted(() => ({
  dataDir: `${process.cwd()}/.test-tmp/browse-notification`,
  wake: vi.fn(async () => {}),
}));
vi.mock('../../container-runner.js', () => ({ wakeContainer: fixture.wake }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: fixture.dataDir,
  GROUPS_DIR: `${fixture.dataDir}/groups`,
}));

let session: Session;
beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-baila',
    name: 'Baila',
    folder: 'baila',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  session = {
    id: 'sess-baila',
    agent_group_id: 'ag-baila',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  createSession(session);
  fs.mkdirSync(`${fixture.dataDir}/groups/baila`, { recursive: true });
  fs.writeFileSync(`${fixture.dataDir}/groups/baila/container.json`, JSON.stringify({ provider: 'codex' }));
  initSessionFolder(session.agent_group_id, session.id);
  fixture.wake.mockClear();
});
afterEach(() => {
  closeDb();
  fs.rmSync(fixture.dataDir, { recursive: true, force: true });
});

it.each([null, 'discord:g:qa:thread'])('keeps approval notifications on the requesting route (%s)', (threadId) => {
  const origin = {
    channelType: 'discord',
    platformId: 'qa',
    threadId,
    messagingGroupId: 'mg-origin',
    isGroup: 1 as const,
  };
  writeSessionMessage(session.agent_group_id, session.id, {
    ...origin,
    id: 'human-request',
    kind: 'chat-sdk',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({ text: 'Use OCB', senderId: 'dan' }),
  });
  notifyAgent(session, 'Browse session approved. Continue the task.', origin);
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    const rows = db.prepare('SELECT * FROM messages_in ORDER BY seq').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: 'task',
      channel_type: 'discord',
      platform_id: 'qa',
      thread_id: threadId,
      messaging_group_id: 'mg-origin',
      is_group: 1,
      host_route_key: rows[0].host_route_key,
      status: 'pending',
      trigger: 1,
    });
    expect(JSON.parse(String(rows[1].content))).toEqual({ prompt: 'Browse session approved. Continue the task.' });
    expect(rows[1].host_input_id).not.toBe(rows[0].host_input_id);
    expect(fixture.wake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: session.id }));
    if (process.env.BROWSE_NOTIFICATION_REPLAY_FIXTURE) {
      fs.mkdirSync(path.dirname(process.env.BROWSE_NOTIFICATION_REPLAY_FIXTURE), { recursive: true });
      fs.writeFileSync(process.env.BROWSE_NOTIFICATION_REPLAY_FIXTURE, JSON.stringify(rows));
    }
  } finally {
    db.close();
  }
});
