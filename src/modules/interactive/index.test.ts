import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup, createMessagingGroup, initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { archiveSession, createPendingQuestion } from '../../db/sessions.js';
import { getResponseHandlers } from '../../response-registry.js';
import { inboundDbPath, resolveSession } from '../../session-manager.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-interactive' };
});

const TEST_DIR = '/tmp/nanoclaw-test-interactive';

function now(): string {
  return new Date().toISOString();
}

function inboundMessages(
  agentGroupId: string,
  sessionId: string,
): Array<{ id: string; kind: string; content: string }> {
  const db = new Database(inboundDbPath(agentGroupId, sessionId));
  try {
    return db.prepare('SELECT id, kind, content FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      kind: string;
      content: string;
    }>;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  await import('./index.js');

  createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('interactive question responses', () => {
  it('drops stale responses for archived sessions without waking the container', async () => {
    const { wakeContainer } = await import('../../container-runner.js');
    const wakeContainerMock = vi.mocked(wakeContainer);
    wakeContainerMock.mockClear();

    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    createPendingQuestion({
      question_id: 'question-1',
      session_id: session.id,
      message_out_id: 'out-question-1',
      platform_id: 'telegram:123',
      channel_type: 'telegram',
      thread_id: null,
      title: 'Choose',
      options: [{ label: 'Yes', value: 'yes' }],
      created_at: now(),
    });
    archiveSession(session.id);

    let claimed = false;
    for (const handler of getResponseHandlers()) {
      claimed = await handler({
        questionId: 'question-1',
        value: 'yes',
        userId: 'user-1',
        channelType: 'telegram',
        platformId: 'telegram:123',
        threadId: null,
      });
      if (claimed) break;
    }

    expect(claimed).toBe(true);
    expect(inboundMessages('ag-1', session.id)).toEqual([]);
    expect(wakeContainerMock).not.toHaveBeenCalled();

    let claimedAgain = false;
    for (const handler of getResponseHandlers()) {
      claimedAgain = await handler({
        questionId: 'question-1',
        value: 'yes',
        userId: 'user-1',
        channelType: 'telegram',
        platformId: 'telegram:123',
        threadId: null,
      });
      if (claimedAgain) break;
    }
    expect(claimedAgain).toBe(false);
  });
});
