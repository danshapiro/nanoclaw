import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { installPackages } from './self-mod.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('install_packages policy', () => {
  it('rejects package installs for Flight Goat before writing an outbound request', async () => {
    const result = await installPackages.handler({
      apt: ['golang-go'],
      reason: 'Install Go to use flight-goat CLI for Wisconsin flights',
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('installed skill dependencies');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects variant Flight Goat wording before writing an outbound request', async () => {
    const result = await installPackages.handler({
      apt: ['golang-go'],
      reason: 'install Go so pp-flight-goat can run',
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('installed skill dependencies');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects explicit deployed skill dependency purpose before writing an outbound request', async () => {
    const result = await installPackages.handler({
      apt: ['golang-go'],
      reason: 'needed',
      purpose: 'deployed_skill_dependency',
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('installed skill dependencies');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('allows user-requested general capability installs', async () => {
    const result = await installPackages.handler({
      apt: ['golang-go'],
      reason: 'User asked me to add Go for compiling a personal project CLI',
      purpose: 'general_capability',
    });

    expect(result.isError).toBeUndefined();
    const writes = getUndeliveredMessages();
    expect(writes).toHaveLength(1);
    expect(writes[0].kind).toBe('system');
    expect(JSON.parse(writes[0].content)).toMatchObject({
      action: 'install_packages',
      apt: ['golang-go'],
      purpose: 'general_capability',
    });
  });
});
