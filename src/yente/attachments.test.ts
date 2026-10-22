import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  attachmentStagingDir,
  cleanupAttachmentStaging,
  formatAttachmentErrorPromptMetadata,
  formatAttachmentPromptMetadata,
  materializeAttachmentFile,
  materializeAttachmentData,
  materializedAttachmentDir,
  stageInboundAttachment,
  stageInboundAttachmentBuffer,
  safeAttachmentName,
} from './attachments.js';

const tmpRoots: string[] = [];

function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-attachments-'));
  tmpRoots.push(root);
  return root;
}

describe('Yente attachment materialization', () => {
  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes safe attachment names and rejects traversal', () => {
    expect(safeAttachmentName('My File (final).png')).toBe('My-File-final.png');
    expect(safeAttachmentName('  ...report!.pdf  ')).toBe('report.pdf');
    expect(() => safeAttachmentName('../secret.txt')).toThrow('Attachment filename must not contain path separators');
    expect(() => safeAttachmentName('..\\secret.txt')).toThrow('Attachment filename must not contain path separators');
  });

  it('builds the per-group Discord attachment directory under GROUPS_DIR', () => {
    const groupsDir = makeTmpRoot();

    expect(
      materializedAttachmentDir({
        groupsDir,
        groupFolder: 'main',
        channel: 'discord',
        messageId: 'message-1',
      }),
    ).toBe(path.join(groupsDir, 'main', 'attachments', 'discord', 'message-1'));
  });

  it('writes Discord files atomically to durable group storage', () => {
    const groupsDir = makeTmpRoot();
    const result = materializeAttachmentData({
      groupsDir,
      groupFolder: 'main',
      channel: 'discord',
      messageId: 'message-1',
      attachmentId: 'attachment-1',
      originalName: 'screen shot.png',
      contentType: 'image/png',
      data: Buffer.from('png-bytes'),
    });

    expect(result).toEqual({
      workspacePath: '/workspace/agent/attachments/discord/message-1/attachment-1-screen-shot.png',
      hostPath: path.join(groupsDir, 'main', 'attachments', 'discord', 'message-1', 'attachment-1-screen-shot.png'),
      originalName: 'screen shot.png',
      safeName: 'screen-shot.png',
      contentType: 'image/png',
      sizeBytes: 9,
      platformMessageId: 'message-1',
    });
    expect(fs.readFileSync(result.hostPath, 'utf8')).toBe('png-bytes');
  });

  it('writes WhatsApp files to the same workspace contract', () => {
    const groupsDir = makeTmpRoot();
    const result = materializeAttachmentData({
      groupsDir,
      groupFolder: 'family',
      channel: 'whatsapp',
      messageId: 'wa-msg-1',
      attachmentId: 'doc-1',
      originalName: 'invoice.pdf',
      contentType: 'application/pdf',
      data: Buffer.from('pdf'),
    });

    expect(result.workspacePath).toBe('/workspace/agent/attachments/whatsapp/wa-msg-1/doc-1-invoice.pdf');
    expect(result.hostPath).toBe(
      path.join(groupsDir, 'family', 'attachments', 'whatsapp', 'wa-msg-1', 'doc-1-invoice.pdf'),
    );
    expect(fs.readFileSync(result.hostPath, 'utf8')).toBe('pdf');
  });

  it('materializes AgentMail attachments under the mounted group workspace', () => {
    const groupsDir = makeTmpRoot();
    expect(
      materializedAttachmentDir({
        groupsDir,
        groupFolder: 'main',
        channel: 'agentmail',
        messageId: 'agentmail:yente-threads@agentmail.to:m1',
      }),
    ).toBe(path.join(groupsDir, 'main', 'attachments', 'agentmail', 'agentmail-yente-threads-agentmail.to-m1'));

    const result = materializeAttachmentData({
      groupsDir,
      groupFolder: 'main',
      channel: 'agentmail',
      messageId: 'agentmail:yente-threads@agentmail.to:m1',
      attachmentId: 'a1',
      originalName: 'report.txt',
      contentType: 'text/plain',
      data: Buffer.from('report'),
    });
    expect(result.hostPath).toBe(
      path.join(
        groupsDir,
        'main',
        'attachments',
        'agentmail',
        'agentmail-yente-threads-agentmail.to-m1',
        'a1-report.txt',
      ),
    );
    expect(result.workspacePath).toBe(
      '/workspace/agent/attachments/agentmail/agentmail-yente-threads-agentmail.to-m1/a1-report.txt',
    );
  });

  it('formats prompt metadata without leaking host paths', () => {
    expect(
      formatAttachmentPromptMetadata({
        workspacePath: '/workspace/agent/attachments/discord/message-1/attachment-1-screen-shot.png',
        hostPath: '/srv/nanoclaw/shared/groups/main/attachments/discord/message-1/attachment-1-screen-shot.png',
        originalName: 'screen shot.png',
        safeName: 'screen-shot.png',
        contentType: 'image/png',
        sizeBytes: 9,
        platformMessageId: 'message-1',
      }),
    ).toBe(
      [
        'Attachment: screen shot.png',
        'Path: /workspace/agent/attachments/discord/message-1/attachment-1-screen-shot.png',
        'Content-Type: image/png',
        'Size: 9 bytes',
        'Platform message ID: message-1',
      ].join('\n'),
    );
  });

  it('formats attachment-specific download errors for the routed prompt', () => {
    expect(
      formatAttachmentErrorPromptMetadata({
        originalName: 'photo.jpg',
        platformMessageId: 'message-2',
        error: 'download failed',
      }),
    ).toBe('Attachment error for photo.jpg on platform message message-2: download failed');
  });

  it('cleans leftovers from the dedicated staging directory', async () => {
    const dataDir = makeTmpRoot();
    const stagingDir = attachmentStagingDir(dataDir);
    expect(path.basename(stagingDir)).toBe('inbound-attachment-staging');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'partial.attachment'), 'incomplete');
    fs.writeFileSync(path.join(stagingDir, 'interrupted.attachment.tmp'), 'unfinished');

    await expect(cleanupAttachmentStaging(stagingDir)).resolves.toBe(2);
    expect(fs.readdirSync(stagingDir)).toEqual([]);
  });

  it('materializes an asynchronously staged file atomically and preserves its source for fan-out', async () => {
    const groupsDir = makeTmpRoot();
    const stagingDir = path.join(makeTmpRoot(), 'staging');
    const { stagedHostPath, sizeBytes } = await stageInboundAttachmentBuffer(Buffer.from('document payload'), {
      stagingDir,
    });
    const expected = fs.readFileSync(stagedHostPath);
    expect(sizeBytes).toBe(expected.byteLength);

    const first = await materializeAttachmentFile({
      groupsDir,
      groupFolder: 'first-agent',
      channel: 'discord',
      messageId: 'message-1',
      attachmentId: 'file-1',
      originalName: 'report.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sourceHostPath: stagedHostPath,
    });
    const second = await materializeAttachmentFile({
      groupsDir,
      groupFolder: 'second-agent',
      channel: 'discord',
      messageId: 'message-1',
      attachmentId: 'file-1',
      originalName: 'report.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sourceHostPath: stagedHostPath,
    });

    expect(fs.readFileSync(first.hostPath)).toEqual(expected);
    expect(fs.readFileSync(second.hostPath)).toEqual(expected);
    expect(fs.readFileSync(stagedHostPath)).toEqual(expected);
    expect(fs.statSync(first.hostPath).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(path.dirname(first.hostPath))).toEqual(['file-1-report.docx']);
    expect(first.workspacePath).toBe('/workspace/agent/attachments/discord/message-1/file-1-report.docx');
  });

  it('removes a temporary sibling when file materialization fails', async () => {
    const groupsDir = makeTmpRoot();
    await expect(
      materializeAttachmentFile({
        groupsDir,
        groupFolder: 'main',
        channel: 'whatsapp',
        messageId: 'message-2',
        attachmentId: 'file-2',
        originalName: 'missing.docx',
        contentType: null,
        sourceHostPath: path.join(groupsDir, 'missing-source'),
      }),
    ).rejects.toThrow();
    expect(fs.readdirSync(path.join(groupsDir, 'main', 'attachments', 'whatsapp', 'message-2'))).toEqual([]);
  });

  it('keeps the event loop responsive while copying a large staged file', async () => {
    const groupsDir = makeTmpRoot();
    const stagingDir = path.join(makeTmpRoot(), 'staging');
    const { stagedHostPath } = await stageInboundAttachment(
      (async function* () {
        yield Buffer.alloc(32 * 1024 * 1024, 0x61);
      })(),
      { stagingDir },
    );
    let eventLoopRanBeforeCopySettled = false;
    let copySettled = false;
    const copy = materializeAttachmentFile({
      groupsDir,
      groupFolder: 'main',
      channel: 'discord',
      messageId: 'responsive-copy',
      attachmentId: 'large-file',
      originalName: 'large.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sourceHostPath: stagedHostPath,
    }).then((result) => {
      copySettled = true;
      return result;
    });
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        eventLoopRanBeforeCopySettled = !copySettled;
        resolve();
      }),
    );
    await copy;
    expect(eventLoopRanBeforeCopySettled).toBe(true);
  });
});
