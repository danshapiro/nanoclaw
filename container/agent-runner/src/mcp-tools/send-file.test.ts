import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';

// Captured BEFORE the mock registration, so this binding is the real fs.
const realFs = fs;

// Only the /workspace/outbox prefix is virtual (that directory cannot exist
// on a workstation); every other caller in the test process keeps real fs
// behavior, including existsSync, which is not mocked at all.
const fsMock = {
  ...realFs,
  mkdirSync: (p: string, ...rest: Parameters<typeof realFs.mkdirSync>) =>
    typeof p === 'string' && p.startsWith('/workspace/outbox') ? undefined : realFs.mkdirSync(p, ...rest),
  copyFileSync: (src: string, dst: string, ...rest: Parameters<typeof realFs.copyFileSync>) =>
    typeof dst === 'string' && dst.startsWith('/workspace/outbox') ? undefined : realFs.copyFileSync(src, dst, ...rest),
};
mock.module('fs', () => ({ ...fsMock, default: fsMock }));

// Imported after the fs mock is registered.
const { sendFile } = await import('./core.js');

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-current', 'Discord Current', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_file', () => {
  it('unwraps whole-body CDATA text in the accompanying message', async () => {
    const sourceDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sendfile-'));
    const sourcePath = path.join(sourceDir, 'report.pptx');
    realFs.writeFileSync(sourcePath, 'real bytes');

    const result = await sendFile.handler({
      to: 'discord-current',
      path: sourcePath,
      filename: 'report.pptx',
      text: '<![CDATA[Found the originals — unchanged.]]>',
    });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content.text).toBe('Found the originals — unchanged.');
    expect(content.files).toEqual(['report.pptx']);

    realFs.rmSync(sourceDir, { recursive: true, force: true });
  });
});
