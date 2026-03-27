import { describe, expect, it } from 'vitest';

import { extractInboundRemoteControlCommand } from './remote-control-routing.js';
import { NewMessage, RegisteredGroup } from './types.js';

const TEST_TRIGGER_PATTERN = /^@TestBot\b/i;
const TEST_ASSISTANT_NAME = 'TestBot';
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@TestBot',
  added_at: '2026-03-27T00:00:00.000Z',
  isMain: true,
};
const SIDE_GROUP: RegisteredGroup = {
  name: 'Side',
  folder: 'side',
  trigger: '@TestBot',
  added_at: '2026-03-27T00:00:00.000Z',
  isMain: false,
};

function makeMessage(overrides: Partial<NewMessage>): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'chat-1',
    sender: 'user-1',
    sender_name: 'User',
    content: '',
    timestamp: '2026-03-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('extractInboundRemoteControlCommand', () => {
  it('accepts natural-language remote control requests from the main self-chat', () => {
    expect(
      extractInboundRemoteControlCommand(
        makeMessage({
          content: 'give me a remote control link',
          is_from_me: true,
        }),
        TEST_TRIGGER_PATTERN,
        TEST_ASSISTANT_NAME,
        MAIN_GROUP,
      ),
    ).toBe('/remote-control');
  });

  it('does not treat informational link mentions as remote control commands', () => {
    expect(
      extractInboundRemoteControlCommand(
        makeMessage({
          content: 'is the remote control link expired?',
          is_from_me: true,
        }),
        TEST_TRIGGER_PATTERN,
        TEST_ASSISTANT_NAME,
        MAIN_GROUP,
      ),
    ).toBeNull();
    expect(
      extractInboundRemoteControlCommand(
        makeMessage({
          content: 'how does the remote control url work?',
          is_from_me: true,
        }),
        TEST_TRIGGER_PATTERN,
        TEST_ASSISTANT_NAME,
        MAIN_GROUP,
      ),
    ).toBeNull();
  });

  it('ignores assistant-formatted self echoes before command interception', () => {
    expect(
      extractInboundRemoteControlCommand(
        makeMessage({
          content: 'TestBot: use the remote control link from earlier',
          is_from_me: true,
        }),
        TEST_TRIGGER_PATTERN,
        TEST_ASSISTANT_NAME,
        MAIN_GROUP,
      ),
    ).toBeNull();
  });

  it('ignores bot-flagged messages before command interception', () => {
    expect(
      extractInboundRemoteControlCommand(
        makeMessage({
          content: 'give me a remote control link',
          is_bot_message: true,
        }),
        TEST_TRIGGER_PATTERN,
        TEST_ASSISTANT_NAME,
        MAIN_GROUP,
      ),
    ).toBeNull();
  });

  it('still allows explicit slash commands outside the main group', () => {
    expect(
      extractInboundRemoteControlCommand(
        makeMessage({
          content: '/remote-control',
          is_from_me: true,
        }),
        TEST_TRIGGER_PATTERN,
        TEST_ASSISTANT_NAME,
        SIDE_GROUP,
      ),
    ).toBe('/remote-control');
  });
});
