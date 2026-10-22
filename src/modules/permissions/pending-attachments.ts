import { createHash, randomUUID } from 'crypto';
import { copyFile, mkdir, readdir, rename, rm, rmdir } from 'fs/promises';
import path from 'path';

import type { InboundEvent } from '../../channels/adapter.js';
import { approvalAttachmentSpoolDir } from '../../yente/attachments.js';

/** Store host-staged files under approval-owned paths before the route drops its source files. */
export async function spoolPendingApprovalAttachments(
  event: InboundEvent,
  pendingId: string,
  options: { spoolDir?: string } = {},
): Promise<InboundEvent> {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return event;
  }
  if (!Array.isArray(content.attachments)) return event;

  const spoolDir = options.spoolDir ?? approvalAttachmentSpoolDir();
  await mkdir(spoolDir, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  try {
    for (const [index, rawAttachment] of content.attachments.entries()) {
      if (!rawAttachment || typeof rawAttachment !== 'object') continue;
      const attachment = rawAttachment as Record<string, unknown>;
      const sourcePath = attachment.stagedHostPath;
      if (typeof sourcePath !== 'string') continue;

      const pendingDir = path.join(spoolDir, pendingIdDirectory(pendingId));
      await mkdir(pendingDir, { recursive: true, mode: 0o700 });
      const spoolPath = path.join(pendingDir, `${index + 1}-${randomUUID()}.attachment`);
      const temporaryPath = `${spoolPath}.tmp`;
      try {
        await copyFile(sourcePath, temporaryPath);
        await rename(temporaryPath, spoolPath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      copied.push(spoolPath);
      attachment.approvalSpoolPath = spoolPath;
      delete attachment.stagedHostPath;
    }
    return { ...event, message: { ...event.message, content: JSON.stringify(content) } };
  } catch (error) {
    await Promise.all(copied.map((filePath) => rm(filePath, { force: true })));
    throw error;
  }
}

/** Re-expose pending copies as temporary sources for the normal router path. */
export function restorePendingApprovalAttachments(event: InboundEvent): InboundEvent {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return event;
  }
  if (!Array.isArray(content.attachments)) return event;
  let changed = false;
  for (const rawAttachment of content.attachments) {
    if (!rawAttachment || typeof rawAttachment !== 'object') continue;
    const attachment = rawAttachment as Record<string, unknown>;
    if (typeof attachment.approvalSpoolPath !== 'string') continue;
    attachment.stagedHostPath = attachment.approvalSpoolPath;
    delete attachment.approvalSpoolPath;
    changed = true;
  }
  return changed ? { ...event, message: { ...event.message, content: JSON.stringify(content) } } : event;
}

/** Remove every approval-owned copy referenced by a pending event. */
export async function removePendingApprovalAttachmentSpool(
  eventOrJson: InboundEvent | string,
  options: { spoolDir?: string; pendingId?: string } = {},
): Promise<void> {
  const spoolDir = path.resolve(options.spoolDir ?? approvalAttachmentSpoolDir());
  const paths = new Set<string>();
  let event: InboundEvent | undefined;
  try {
    event = typeof eventOrJson === 'string' ? (JSON.parse(eventOrJson) as InboundEvent) : eventOrJson;
  } catch {
    event = undefined;
  }

  if (event) {
    try {
      const content = JSON.parse(event.message.content) as Record<string, unknown>;
      if (Array.isArray(content.attachments)) {
        for (const rawAttachment of content.attachments) {
          if (!rawAttachment || typeof rawAttachment !== 'object') continue;
          const spoolPath = (rawAttachment as Record<string, unknown>).approvalSpoolPath;
          if (typeof spoolPath === 'string') paths.add(spoolPath);
        }
      }
    } catch {
      // The pending id below still lets us remove the copies after a corrupt payload.
    }
  }

  const removals = [...paths].map(async (spoolPath) => {
    const resolved = path.resolve(spoolPath);
    if (isWithinRoot(spoolDir, resolved)) await rm(resolved, { force: true });
  });
  if (options.pendingId) {
    removals.push(rm(path.join(spoolDir, pendingIdDirectory(options.pendingId)), { recursive: true, force: true }));
  }
  await Promise.all(removals);
}

/** Delete unreferenced files owned by the approval spool after a process crash. */
export async function cleanupOrphanedPendingApprovalAttachments(
  pendingEvents: string[],
  options: { spoolDir?: string } = {},
): Promise<number> {
  const spoolDir = path.resolve(options.spoolDir ?? approvalAttachmentSpoolDir());
  const referenced = new Set<string>();
  for (const eventJson of pendingEvents) {
    for (const sourcePath of approvalSpoolPaths(eventJson)) {
      const resolved = path.resolve(sourcePath);
      if (isWithinRoot(spoolDir, resolved)) referenced.add(resolved);
    }
  }

  let removed = 0;
  const emptyDirs: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        emptyDirs.push(entryPath);
        continue;
      }
      if (!entry.isFile() || referenced.has(path.resolve(entryPath)) || !isManagedSpoolFile(spoolDir, entryPath))
        continue;
      await rm(entryPath, { force: true });
      removed += 1;
    }
  }

  await visit(spoolDir);
  for (const dir of emptyDirs.reverse()) {
    const entries = await readdir(dir).catch(() => ['occupied']);
    if (entries.length === 0) await rmdir(dir).catch(() => undefined);
  }
  return removed;
}

function approvalSpoolPaths(eventOrJson: InboundEvent | string): string[] {
  let event: InboundEvent;
  try {
    event = typeof eventOrJson === 'string' ? (JSON.parse(eventOrJson) as InboundEvent) : eventOrJson;
  } catch {
    return [];
  }
  try {
    const content = JSON.parse(event.message.content) as Record<string, unknown>;
    if (!Array.isArray(content.attachments)) return [];
    return content.attachments.flatMap((rawAttachment) => {
      if (!rawAttachment || typeof rawAttachment !== 'object') return [];
      const sourcePath = (rawAttachment as Record<string, unknown>).approvalSpoolPath;
      return typeof sourcePath === 'string' ? [sourcePath] : [];
    });
  } catch {
    return [];
  }
}

function isManagedSpoolFile(spoolDir: string, filePath: string): boolean {
  const relative = path.relative(spoolDir, filePath);
  const segments = relative.split(path.sep);
  if (segments.length === 2 && /^[a-f0-9]{64}$/.test(segments[0]!)) {
    return /^\d+-[a-f0-9-]{36}\.attachment(?:\.tmp)?$/.test(segments[1]!);
  }
  if (segments.length === 1) {
    return /^[A-Za-z0-9._-]+-\d+-[a-f0-9-]{36}\.attachment(?:\.tmp)?$/.test(segments[0]!);
  }
  return false;
}

function pendingIdDirectory(pendingId: string): string {
  return createHash('sha256').update(pendingId).digest('hex');
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
