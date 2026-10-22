import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../db/index.js';
import { log } from '../log.js';
import { inboundDbPath, resolveSession, writeSessionMessage } from '../session-manager.js';
import { logWhatsAppMediaDownloadFailure, shouldSkipWhatsAppMediaDownload, stageWhatsAppMedia } from './whatsapp.js';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-whatsapp-data',
    GROUPS_DIR: '/tmp/nanoclaw-test-whatsapp-groups',
  };
});

const TEST_DATA_DIR = '/tmp/nanoclaw-test-whatsapp-data';
const TEST_GROUPS_DIR = '/tmp/nanoclaw-test-whatsapp-groups';

describe('WhatsApp streamed media download', () => {
  it('skips media downloads for bot echoes and matching pending-question answers', () => {
    expect(shouldSkipWhatsAppMediaDownload({ fromMe: true, content: '', pendingOptionLabels: [] })).toBe(true);
    expect(
      shouldSkipWhatsAppMediaDownload({
        fromMe: false,
        content: '/approve',
        pendingOptionLabels: ['Approve', 'Reject'],
      }),
    ).toBe(true);
    expect(
      shouldSkipWhatsAppMediaDownload({
        fromMe: false,
        content: '/unrelated',
        pendingOptionLabels: ['Approve', 'Reject'],
      }),
    ).toBe(false);
  });

  it('requests a Baileys stream, stages its bytes, and enforces the byte limit', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'whatsapp-stream-'));
    const message = { key: { id: 'wa-stream-1' } } as never;
    const stream = vi.fn(async (_message: unknown, mode: string, _options: object) => {
      expect(mode).toBe('stream');
      return Readable.from([Buffer.from('document '), Buffer.from('bytes')]);
    });
    try {
      const result = await stageWhatsAppMedia(
        message,
        { fileLength: 14 },
        { download: stream as never, stagingDir: dir },
      );
      expect(stream).toHaveBeenCalledOnce();
      expect(result.sizeBytes).toBe(14);
      expect(await fs.promises.readFile(result.stagedHostPath, 'utf8')).toBe('document bytes');
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects over-limit streamed bytes and removes the partial staging file', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'whatsapp-stream-'));
    try {
      await expect(
        stageWhatsAppMedia(
          { key: { id: 'wa-stream-2' } } as never,
          { fileLength: 0 },
          {
            download: (async () => Readable.from([Buffer.from('123456'), Buffer.from('789')])) as never,
            stagingDir: dir,
            maxBytes: 8,
          },
        ),
      ).rejects.toThrow('Inbound attachment exceeds the 8-byte limit');
      expect(await fs.promises.readdir(dir)).toEqual([]);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('aborts a stalled Baileys stream after the fixed timeout and removes partial staging bytes', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'whatsapp-stream-'));
    let cancelled = false;
    let receivedSignal: AbortSignal | undefined;
    const stream = vi.fn(
      async (_message: unknown, _mode: string, { options }: { options: { signal: AbortSignal } }) => {
        const { signal } = options;
        receivedSignal = signal;
        signal.addEventListener('abort', () => {
          cancelled = true;
        });
        return Readable.from(
          (async function* () {
            yield Buffer.from('partial');
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 80);
              timer.unref?.();
            });
            if (!cancelled) yield Buffer.from('complete');
          })(),
        );
      },
    );
    const pending = stageWhatsAppMedia(
      { key: { id: 'wa-stream-timeout' } } as never,
      { fileLength: 0 },
      { download: stream as never, stagingDir: dir, timeoutMs: 20 },
    );
    const timeoutAssertion = expect(pending).rejects.toThrow(/timed out/i);
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await timeoutAssertion;
      expect(cancelled).toBe(true);
      expect(receivedSignal?.aborted).toBe(true);
      expect(await fs.promises.readdir(dir)).toEqual([]);
    } finally {
      cancelled = true;
      await pending.catch(() => undefined);
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('logs safe metadata and a sanitized error when a media download fails', () => {
    const signedUrl = 'https://cdn.whatsapp.example/private-file?token=secret';
    const warning = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      logWhatsAppMediaDownloadFailure({
        messageId: 'wa-failed-message',
        attachmentId: 'document-wa-failed-message',
        name: 'private.docx',
        type: 'document',
        error: new Error(`socket reset at ${signedUrl}`),
      });

      expect(warning).toHaveBeenCalledWith('Failed to download media', {
        channel: 'whatsapp',
        messageId: 'wa-failed-message',
        attachmentId: 'document-wa-failed-message',
        name: 'private.docx',
        type: 'document',
        error: 'WhatsApp attachment download failed',
      });
      expect(JSON.stringify(warning.mock.calls)).not.toContain(signedUrl);
    } finally {
      warning.mockRestore();
    }
  });
});

function now(): string {
  return new Date().toISOString();
}

describe('WhatsApp attachment contract', () => {
  beforeEach(() => {
    for (const dir of [TEST_DATA_DIR, TEST_GROUPS_DIR]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-whatsapp',
      name: 'WhatsApp Agent',
      folder: 'whatsapp-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-whatsapp',
      channel_type: 'whatsapp',
      platform_id: '15555550100@s.whatsapp.net',
      name: 'WhatsApp',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
    for (const dir of [TEST_DATA_DIR, TEST_GROUPS_DIR]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('materializes inbound media under the WhatsApp workspace path', () => {
    const { session } = resolveSession('ag-whatsapp', 'mg-whatsapp', null, 'shared');
    writeSessionMessage('ag-whatsapp', session.id, {
      id: 'wa-msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: '15555550100@s.whatsapp.net',
      channelType: 'whatsapp',
      threadId: null,
      content: JSON.stringify({
        text: 'file',
        attachments: [
          {
            id: 'document-wa-msg-1',
            name: 'invoice.pdf',
            mimeType: 'application/pdf',
            data: Buffer.from('whatsapp-file').toString('base64'),
          },
        ],
      }),
    });

    const hostPath = path.join(
      TEST_GROUPS_DIR,
      'whatsapp-agent',
      'attachments',
      'whatsapp',
      'wa-msg-1',
      'document-wa-msg-1-invoice.pdf',
    );
    expect(fs.readFileSync(hostPath, 'utf8')).toBe('whatsapp-file');

    const db = new Database(inboundDbPath('ag-whatsapp', session.id));
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('wa-msg-1') as { content: string };
    db.close();
    expect(JSON.parse(row.content).text).toContain(
      '/workspace/agent/attachments/whatsapp/wa-msg-1/document-wa-msg-1-invoice.pdf',
    );
  });
});
