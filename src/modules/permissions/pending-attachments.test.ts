import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';
import {
  cleanupOrphanedPendingApprovalAttachments,
  removePendingApprovalAttachmentSpool,
  spoolPendingApprovalAttachments,
} from './pending-attachments.js';

describe('pending approval attachment spool', () => {
  it('removes only the exact pending approval spool when ids share a prefix', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'approval-spool-id-'));
    const sources = path.join(root, 'sources');
    const spoolDir = path.join(root, 'spool');
    await fs.mkdir(sources);
    const firstSource = path.join(sources, 'first.attachment');
    const secondSource = path.join(sources, 'second.attachment');
    await fs.writeFile(firstSource, 'first');
    await fs.writeFile(secondSource, 'second');

    try {
      const first = await spoolPendingApprovalAttachments(eventFor(firstSource), 'pending', { spoolDir });
      const second = await spoolPendingApprovalAttachments(eventFor(secondSource), 'pending-1', { spoolDir });
      const firstPath = attachmentSpoolPath(first);
      const secondPath = attachmentSpoolPath(second);

      await removePendingApprovalAttachmentSpool(JSON.stringify(first), { pendingId: 'pending', spoolDir });

      await expect(fs.stat(firstPath)).rejects.toThrow();
      await expect(fs.stat(secondPath)).resolves.toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reconciles true orphan files while preserving copies referenced by pending rows', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'approval-spool-orphans-'));
    const spoolDir = path.join(root, 'spool');
    const source = path.join(root, 'source.attachment');
    await fs.writeFile(source, 'pending bytes');
    try {
      const pending = await spoolPendingApprovalAttachments(eventFor(source), 'live-pending', { spoolDir });
      const livePath = attachmentSpoolPath(pending);
      const orphanDir = path.join(spoolDir, 'a'.repeat(64));
      await fs.mkdir(orphanDir, { recursive: true });
      const orphanPath = path.join(orphanDir, '2-123e4567-e89b-12d3-a456-426614174000.attachment');
      await fs.writeFile(orphanPath, 'orphan bytes');

      await expect(cleanupOrphanedPendingApprovalAttachments([JSON.stringify(pending)], { spoolDir })).resolves.toBe(1);

      await expect(fs.stat(livePath)).resolves.toBeDefined();
      await expect(fs.stat(orphanPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function eventFor(stagedHostPath: string): InboundEvent {
  return {
    channelType: 'discord',
    platformId: 'channel',
    threadId: null,
    message: {
      id: 'message-1',
      kind: 'chat',
      content: JSON.stringify({ attachments: [{ id: 'file-1', stagedHostPath }] }),
      timestamp: '2026-10-22T00:00:00.000Z',
    },
  };
}

function attachmentSpoolPath(event: InboundEvent): string {
  const content = JSON.parse(event.message.content) as { attachments: Array<{ approvalSpoolPath: string }> };
  return content.attachments[0]!.approvalSpoolPath;
}
