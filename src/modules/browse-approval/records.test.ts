import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BrowseRecordStore } from './records.js';
import type { Session } from '../../types.js';

it('invalidates indexed permit files before a failed control reset can resume any agent', () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp-browse-records-'));
  const session = { id: 's', agent_group_id: 'ag' } as Session;
  try {
    const store = new BrowseRecordStore(directory);
    store.write(session, {
      status: 'approved',
      requestId: 'r',
      purpose: 'Read updates',
      url: 'https://example.com',
      browser: 'chrome-dandesktop',
      token: 'private-permit',
    });
    const fresh = new BrowseRecordStore(directory);
    expect(fresh.invalidateAfterRestart()).toBe(1);
    const readback = JSON.parse(fs.readFileSync(fresh.file('ag', 's'), 'utf8'));
    expect(readback.status).toBe('ended');
    expect(readback).not.toHaveProperty('token');
    expect(fs.readFileSync(path.join(directory, 'browse-session-access.json'), 'utf8')).not.toContain('private-permit');
    expect(fresh.invalidateAfterRestart()).toBe(0);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
it('does not silently clear an unreadable access index', () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp-browse-records-'));
  try {
    fs.writeFileSync(path.join(directory, 'browse-session-access.json'), '{broken');
    expect(() => new BrowseRecordStore(directory).invalidateAfterRestart()).toThrow(/unreadable/);
    expect(fs.readFileSync(path.join(directory, 'browse-session-access.json'), 'utf8')).toBe('{broken');
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
