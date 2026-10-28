import { describe, expect, it } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import { prepareMessageDelivery } from './message-delivery.js';

function message(text: string, kind = 'chat', channel_type: string | null = 'discord'): MessageInRow {
  return {
    id: 'm-1',
    kind,
    channel_type,
    content: JSON.stringify({ text, sender: 'User', attachments: ['kept'] }),
  } as MessageInRow;
}

describe('human message queue marker', () => {
  it.each([
    ['*yes', 'queue', 'yes'],
    ['**yes*', 'queue', '*yes*'],
    ['*no*', 'steer', '*no*'],
    ['This is *no', 'steer', 'This is *no'],
    ['**bold**', 'steer', '**bold**'],
    ['***bold italic***', 'steer', '***bold italic***'],
    ['*hello* followed by unmatched *', 'steer', '*hello* followed by unmatched *'],
    ['*hello \\*', 'queue', 'hello \\*'],
    ['\\*hello', 'steer', '\\*hello'],
    ['*hello `*`', 'queue', 'hello `*`'],
    ['*note `*``', 'steer', '*note `*``'],
    ['*note ``*`', 'steer', '*note ``*`'],
    ['*[foo*](https://example.com)', 'queue', '[foo*](https://example.com)'],
    ['*[foo](https://example.com)*', 'steer', '*[foo](https://example.com)*'],
    ['*<https://example.com/*>', 'queue', '<https://example.com/*>'],
    ['*<span title="*">foo', 'queue', '<span title="*">foo'],
    ['*heading*\n---', 'steer', '*heading*\n---'],
    ['* list item', 'queue', ' list item'],
    ['***', 'queue', '**'],
    ['*hello **bold**', 'queue', 'hello **bold**'],
    ['*hello **bold** end*', 'steer', '*hello **bold** end*'],
    ['*foo**bar**', 'queue', 'foo**bar**'],
    ['**foo*bar*', 'queue', '*foo*bar*'],
    ['*foo**bar*', 'steer', '*foo**bar*'],
    ['**foo*bar**', 'steer', '**foo*bar**'],
    ['***yes****please use blue', 'steer', '***yes****please use blue'],
    ['***bold**italic**please', 'steer', '***bold**italic**please'],
    ['*', 'queue', ''],
    [' *later', 'steer', ' *later'],
  ])('classifies %j as %s and preserves the original row', (text, mode, expectedText) => {
    const original = message(text);
    const result = prepareMessageDelivery(original);
    expect(result.mode).toBe(mode);
    expect(JSON.parse(result.message.content)).toEqual({ text: expectedText, sender: 'User', attachments: ['kept'] });
    expect(JSON.parse(original.content).text).toBe(text);
  });

  it.each([
    ['chat', 'agent'],
    ['task', 'discord'],
    ['webhook', 'discord'],
    ['system', 'discord'],
  ])('does not treat %s/%s inputs as human queue syntax', (kind, channel) => {
    const original = message('*keep this literal', kind, channel);
    expect(prepareMessageDelivery(original)).toEqual({ message: original, mode: 'queue' });
  });
});
