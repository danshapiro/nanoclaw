import { expect, it } from 'bun:test';
import type { MessageInRow } from './db/messages-in.js';
import { TypingActivity } from './typing-activity.js';

it('retains selected message identities in the empty completion snapshot', () => {
  const snapshots: Array<{ targets: unknown[]; ids: string[] }> = [];
  const activity = new TypingActivity((targets, ids) => snapshots.push({ targets, ids }));
  activity.select('provider-input', [
    {
      id: 'message',
      kind: 'chat-sdk',
      trigger: 1,
      channel_type: 'discord',
      platform_id: 'channel',
      thread_id: 'thread',
    } as MessageInRow,
  ]);
  activity.resolve(['provider-input']);
  expect(snapshots.at(-1)).toEqual({ targets: [], ids: ['message'] });
});

it('retries a failed final empty update without disrupting work', async () => {
  const published: unknown[][] = [];
  let failEmpty = true;
  const activity = new TypingActivity((targets) => {
    if (targets.length === 0 && failEmpty) {
      failEmpty = false;
      throw new Error('database busy');
    }
    published.push(targets);
  });
  activity.select('input', [
    {
      kind: 'chat-sdk',
      trigger: 1,
      channel_type: 'discord',
      platform_id: 'channel',
      thread_id: 'thread',
    } as MessageInRow,
  ]);
  activity.resolve(['input']);
  expect(published).toEqual([[{ platformId: 'channel', threadId: 'thread' }]]);
  await new Promise((resolve) => setTimeout(resolve, 5300));
  expect(published.at(-1)).toEqual([]);
}, 8000);
