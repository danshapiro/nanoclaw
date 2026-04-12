import { describe, expect, it } from 'vitest';

import {
  extractTextControlCommand,
  getHelpText,
  toSessionSlashCommand,
} from './control-commands.js';

describe('extractTextControlCommand', () => {
  it('matches exact bare commands', () => {
    expect(extractTextControlCommand('help')).toBe('help');
    expect(extractTextControlCommand('status')).toBe('status');
    expect(extractTextControlCommand('new')).toBe('new');
    expect(extractTextControlCommand('clear')).toBe('clear');
    expect(extractTextControlCommand('compact')).toBe('compact');
  });

  it('trims and lowercases exact bare commands', () => {
    expect(extractTextControlCommand('  Status  ')).toBe('status');
  });

  it('rejects slash commands and extra text', () => {
    expect(extractTextControlCommand('/status')).toBeNull();
    expect(extractTextControlCommand('status please')).toBeNull();
  });
});

describe('toSessionSlashCommand', () => {
  it('maps action commands to slash commands', () => {
    expect(toSessionSlashCommand('new')).toBe('/new');
    expect(toSessionSlashCommand('clear')).toBe('/clear');
    expect(toSessionSlashCommand('compact')).toBe('/compact');
  });
});

describe('getHelpText', () => {
  it('mentions the five supported commands', () => {
    const help = getHelpText();
    expect(help).toContain('/help or help');
    expect(help).toContain('/status or status');
    expect(help).toContain('/new or new');
    expect(help).toContain('/clear or clear');
    expect(help).toContain('/compact or compact');
  });
});
