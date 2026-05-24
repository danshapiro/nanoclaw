import { beforeEach, describe, expect, it, mock } from 'bun:test';

const writes: Array<{ id: string; kind: string; content: string }> = [];

mock.module('../db/messages-out.js', () => ({
  writeMessageOut: (msg: { id: string; kind: string; content: string }) => {
    writes.push(msg);
    return writes.length * 2 - 1;
  },
}));

mock.module('./server.js', () => ({
  registerTools: () => {},
}));

const { installPackages } = await import('./self-mod.js');

beforeEach(() => {
  writes.splice(0);
});

describe('install_packages policy', () => {
  it('rejects package installs for Flight Goat before writing an outbound request', async () => {
    const result = await installPackages.handler({
      apt: ['golang-go'],
      reason: 'Install Go to use flight-goat CLI for Wisconsin flights',
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('installed skill dependencies');
    expect(writes).toHaveLength(0);
  });

  it('rejects variant Flight Goat wording before writing an outbound request', async () => {
    const result = await installPackages.handler({
      apt: ['golang-go'],
      reason: 'install Go so pp-flight-goat can run',
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('installed skill dependencies');
    expect(writes).toHaveLength(0);
  });

  it('rejects explicit deployed skill dependency purpose before writing an outbound request', async () => {
    const result = await installPackages.handler({
      apt: ['golang-go'],
      reason: 'needed',
      purpose: 'deployed_skill_dependency',
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('installed skill dependencies');
    expect(writes).toHaveLength(0);
  });

  it('allows user-requested general capability installs', async () => {
    const result = await installPackages.handler({
      apt: ['golang-go'],
      reason: 'User asked me to add Go for compiling a personal project CLI',
      purpose: 'general_capability',
    });

    expect(result.isError).toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].content)).toMatchObject({
      action: 'install_packages',
      apt: ['golang-go'],
      purpose: 'general_capability',
    });
  });
});
