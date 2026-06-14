import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(runnerRoot, rel), 'utf8');
}

describe('Yente inactivity relay hardening', () => {
  it('does not start a second provider query for inactivity status', () => {
    const pollLoop = read('src/poll-loop.ts');

    expect(pollLoop).not.toContain('function runInactivityRelay');
    expect(pollLoop).not.toContain('prompt: notice.agentMessage');
    expect(pollLoop).not.toContain('inactivity_relay');
    expect(pollLoop).not.toContain('relayMode: true');
  });

  it('does not package heartbeat text as an agent prompt', () => {
    const codexParity = read('src/providers/codex-parity.ts');
    const opencode = read('src/providers/opencode.ts');

    expect(codexParity).not.toContain('relayRecommended: true');
    expect(opencode).not.toContain('relayRecommended: true');
    expect(codexParity).not.toContain("I'm still working on this — it's taking a while");
    expect(opencode).not.toContain("I'm still working on this — it's taking a while");
  });
});
