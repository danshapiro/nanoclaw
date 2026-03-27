import { describe, expect, it } from 'vitest';

import { extractRemoteControlCommand } from './remote-control-command.js';

const TEST_TRIGGER_PATTERN = /^@TestBot\b/i;

function extractNaturalLanguageCommand(content: string) {
  return extractRemoteControlCommand(content, TEST_TRIGGER_PATTERN, {
    allowNaturalLanguage: true,
  });
}

describe('extractRemoteControlCommand', () => {
  it('matches explicit slash commands', () => {
    expect(
      extractRemoteControlCommand('/remote-control', TEST_TRIGGER_PATTERN),
    ).toBe('/remote-control');
    expect(
      extractRemoteControlCommand('/remote-control-end', TEST_TRIGGER_PATTERN),
    ).toBe('/remote-control-end');
  });

  it('matches slash commands after the trigger word', () => {
    expect(
      extractRemoteControlCommand(
        '@TestBot /remote-control',
        TEST_TRIGGER_PATTERN,
      ),
    ).toBe('/remote-control');
    expect(
      extractRemoteControlCommand(
        '@TestBot /remote-control-end',
        TEST_TRIGGER_PATTERN,
      ),
    ).toBe('/remote-control-end');
  });

  it('matches common natural-language requests for a remote control link', () => {
    expect(extractNaturalLanguageCommand('give me a remote control link')).toBe(
      '/remote-control',
    );
    expect(
      extractNaturalLanguageCommand('@TestBot send me the remote control url'),
    ).toBe('/remote-control');
    expect(
      extractNaturalLanguageCommand('can I have the remote control link?'),
    ).toBe('/remote-control');
    expect(extractNaturalLanguageCommand('start remote control')).toBe(
      '/remote-control',
    );
    expect(
      extractNaturalLanguageCommand('start a new remote control session'),
    ).toBe('/remote-control');
  });

  it('matches common natural-language requests to end remote control', () => {
    expect(extractNaturalLanguageCommand('stop remote control')).toBe(
      '/remote-control-end',
    );
    expect(extractNaturalLanguageCommand('end remote control')).toBe(
      '/remote-control-end',
    );
    expect(
      extractNaturalLanguageCommand('stop the remote control session'),
    ).toBe('/remote-control-end');
    expect(
      extractNaturalLanguageCommand('@TestBot disable remote control'),
    ).toBe('/remote-control-end');
  });

  it('does not treat remote-control references as stop commands', () => {
    expect(
      extractNaturalLanguageCommand('end-to-end remote control link'),
    ).toBeNull();
    expect(
      extractNaturalLanguageCommand('close and reopen remote control'),
    ).toBeNull();
    expect(
      extractNaturalLanguageCommand('can I open files via remote control?'),
    ).toBeNull();
  });

  it('can disable natural-language interception while keeping slash commands', () => {
    expect(
      extractRemoteControlCommand(
        'give me a remote control link',
        TEST_TRIGGER_PATTERN,
        { allowNaturalLanguage: false },
      ),
    ).toBeNull();
    expect(
      extractRemoteControlCommand('/remote-control', TEST_TRIGGER_PATTERN, {
        allowNaturalLanguage: false,
      }),
    ).toBe('/remote-control');
  });

  it('ignores unrelated questions about remote control', () => {
    expect(
      extractNaturalLanguageCommand('how does remote control work here?'),
    ).toBeNull();
    expect(
      extractNaturalLanguageCommand('what is the remote control feature?'),
    ).toBeNull();
    expect(
      extractNaturalLanguageCommand('is the remote control link expired?'),
    ).toBeNull();
    expect(
      extractNaturalLanguageCommand('I want to share the remote control link'),
    ).toBeNull();
  });
});
