import fs from 'fs';
import path from 'path';

export interface MaterializedAttachment {
  workspacePath: string;
  hostPath: string;
  originalName: string;
  safeName: string;
  contentType: string | null;
  sizeBytes: number;
  platformMessageId: string;
}

export function safeAttachmentName(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new Error('Attachment filename must not contain path separators');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('Attachment filename must not contain traversal segments');
  }

  const normalized = trimmed
    .replace(/^\.+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/-\./g, '.')
    .replace(/^-+|-+$/g, '');
  if (!normalized) return 'attachment';
  return normalized;
}

export function materializedAttachmentDir(args: {
  groupsDir: string;
  groupFolder: string;
  channel: 'discord' | 'whatsapp';
  messageId: string;
}): string {
  const groupsRoot = path.resolve(args.groupsDir);
  const safeMessageId = safeAttachmentName(args.messageId);
  const dir = path.resolve(groupsRoot, args.groupFolder, 'attachments', args.channel, safeMessageId);
  const relative = path.relative(groupsRoot, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Attachment path must remain under GROUPS_DIR');
  }
  return dir;
}

export function materializeAttachmentData(args: {
  groupsDir: string;
  groupFolder: string;
  channel: 'discord' | 'whatsapp';
  messageId: string;
  attachmentId: string;
  originalName: string;
  contentType: string | null;
  data: Buffer;
}): MaterializedAttachment {
  const dir = materializedAttachmentDir(args);
  fs.mkdirSync(dir, { recursive: true });

  const safeName = safeAttachmentName(args.originalName);
  const safeAttachmentId = safeAttachmentName(args.attachmentId);
  const safeMessageId = safeAttachmentName(args.messageId);
  const filename = `${safeAttachmentId}-${safeName}`;
  const hostPath = path.join(dir, filename);
  const tmpPath = path.join(dir, `.${filename}.${process.pid}.${Date.now()}.tmp`);

  fs.writeFileSync(tmpPath, args.data);
  fs.renameSync(tmpPath, hostPath);

  return {
    workspacePath: `/workspace/agent/attachments/${args.channel}/${safeMessageId}/${filename}`,
    hostPath,
    originalName: args.originalName,
    safeName,
    contentType: args.contentType,
    sizeBytes: args.data.byteLength,
    platformMessageId: args.messageId,
  };
}

export function formatAttachmentPromptMetadata(att: MaterializedAttachment): string {
  return [
    `Attachment: ${att.originalName}`,
    `Path: ${att.workspacePath}`,
    `Content-Type: ${att.contentType ?? 'unknown'}`,
    `Size: ${att.sizeBytes} bytes`,
    `Platform message ID: ${att.platformMessageId}`,
  ].join('\n');
}

export function formatAttachmentErrorPromptMetadata(args: {
  originalName: string;
  platformMessageId: string;
  error: string;
}): string {
  return `Attachment error for ${args.originalName} on platform message ${args.platformMessageId}: ${args.error}`;
}
