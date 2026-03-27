import { describe, expect, it } from 'vitest';

import { TRIGGER_PATTERN } from './config.js';
import { extractRemoteControlCommand } from './remote-control-command.js';

describe('extractRemoteControlCommand', () => {
  it('matches explicit slash commands', () => {
    expect(extractRemoteControlCommand('/remote-control', TRIGGER_PATTERN)).toBe(
      '/remote-control',
    );
    expect(
      extractRemoteControlCommand('/remote-control-end', TRIGGER_PATTERN),
    ).toBe('/remote-control-end');
  });

  it('matches slash commands after the trigger word', () => {
    expect(
      extractRemoteControlCommand('@Andy /remote-control', TRIGGER_PATTERN),
    ).toBe('/remote-control');
  });

  it('matches common natural-language requests for a remote control link', () => {
    expect(
      extractRemoteControlCommand(
        'give me a remote control link',
        TRIGGER_PATTERN,
      ),
    ).toBe('/remote-control');
    expect(
      extractRemoteControlCommand(
        '@Andy send me the remote control url',
        TRIGGER_PATTERN,
      ),
    ).toBe('/remote-control');
    expect(
      extractRemoteControlCommand('start remote control', TRIGGER_PATTERN),
    ).toBe('/remote-control');
  });

  it('matches common natural-language requests to end remote control', () => {
    expect(
      extractRemoteControlCommand('stop remote control', TRIGGER_PATTERN),
    ).toBe('/remote-control-end');
    expect(
      extractRemoteControlCommand(
        '@Andy disable remote control',
        TRIGGER_PATTERN,
      ),
    ).toBe('/remote-control-end');
  });

  it('ignores unrelated questions about remote control', () => {
    expect(
      extractRemoteControlCommand(
        'how does remote control work here?',
        TRIGGER_PATTERN,
      ),
    ).toBeNull();
    expect(
      extractRemoteControlCommand(
        'what is the remote control feature?',
        TRIGGER_PATTERN,
      ),
    ).toBeNull();
  });
});
