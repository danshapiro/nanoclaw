import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('register Discord channel', () => {
  it('uses the bare parent channel id and creates a distinct session for each Discord thread', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-register-'));
    const wakeContainer = vi.fn().mockResolvedValue(undefined);
    try {
      process.chdir(root);
      fs.mkdirSync(path.join(root, 'container'));
      fs.writeFileSync(path.join(root, 'container', 'CLAUDE.md'), '# Andy\nGlobal instructions\n');
      vi.resetModules();
      vi.doMock('../src/container-runner.js', () => ({ wakeContainer }));

      const { run } = await import('./register.js');
      const db = await import('../src/db/index.js');
      const { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters } =
        await import('../src/channels/channel-registry.js');
      const { routeInbound } = await import('../src/router.js');
      const { getMessagingGroupByPlatform } = await import('../src/db/messaging-groups.js');
      const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
      const { getSessionsByAgentGroup } = await import('../src/db/sessions.js');

      await run([
        '--platform-id',
        'parent-channel',
        '--name',
        'Yente Dev channel',
        '--group-name',
        'Yente Dev',
        '--folder',
        'discord_yente-dev',
        '--channel',
        'discord',
        '--session-mode',
        'per-thread',
        '--trigger',
        '.',
      ]);

      const group = getAgentGroupByFolder('discord_yente-dev');
      expect(group?.name).toBe('Yente Dev');
      expect(getMessagingGroupByPlatform('discord', 'parent-channel')?.platform_id).toBe('parent-channel');
      expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
      expect(process.env.ASSISTANT_NAME).not.toBe('Yente Dev');
      expect(fs.readFileSync(path.join(root, 'container', 'CLAUDE.md'), 'utf8')).toBe('# Andy\nGlobal instructions\n');

      registerChannelAdapter('discord', {
        factory: () => ({
          name: 'test-discord',
          channelType: 'discord',
          supportsThreads: true,
          setup: async () => {},
          teardown: async () => {},
          isConnected: () => true,
          deliver: async () => undefined,
        }),
      });
      await initChannelAdapters(() => ({}), { firstAttemptWaitMs: 0 });

      for (const threadId of ['thread-one', 'thread-two']) {
        await routeInbound({
          channelType: 'discord',
          platformId: 'parent-channel',
          threadId,
          message: {
            id: `message-${threadId}`,
            kind: 'chat-sdk',
            timestamp: new Date().toISOString(),
            content: JSON.stringify({ text: 'start work' }),
            isGroup: true,
          },
        });
      }

      expect(
        getSessionsByAgentGroup(group!.id)
          .map((session) => session.thread_id)
          .filter((threadId): threadId is string => threadId !== null)
          .sort(),
      ).toEqual(['thread-one', 'thread-two']);
      expect(wakeContainer).toHaveBeenCalledTimes(2);
      await teardownChannelAdapters();
      db.closeDb();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
