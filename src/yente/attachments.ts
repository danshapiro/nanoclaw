import fs from 'fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

import { DATA_DIR } from '../config.js';

export const MAX_INBOUND_ATTACHMENT_BYTES = 1024 ** 3;
export const INBOUND_ATTACHMENT_TIMEOUT_MS = 10 * 60 * 1000;

export type StagedAttachmentFile = {
  stagedHostPath: string;
  sizeBytes: number;
};

type AttachmentByteSource = AsyncIterable<Uint8Array | Buffer | string> | ReadableStream<Uint8Array>;

export function attachmentStagingDir(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'inbound-attachment-staging');
}

export function approvalAttachmentSpoolDir(dataDir = DATA_DIR): string {
  return path.join(dataDir, 'approval-attachment-spool');
}

/** Stream provider bytes to a private temporary file, enforcing the byte limit while reading. */
export async function stageInboundAttachment(
  source: AttachmentByteSource,
  options: { stagingDir?: string; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<StagedAttachmentFile> {
  const stagingDir = options.stagingDir ?? attachmentStagingDir();
  const maxBytes = options.maxBytes ?? MAX_INBOUND_ATTACHMENT_BYTES;
  const stagedHostPath = path.join(stagingDir, `${randomUUID()}.attachment`);
  const tmpPath = `${stagedHostPath}.tmp`;
  let sizeBytes = 0;
  const input = toAttachmentReadable(source);
  let inputError: unknown;
  const captureInputError = (error: Error): void => {
    inputError = error;
  };
  input.on('error', captureInputError);
  const limit = new Transform({
    transform(chunk: Buffer | Uint8Array | string, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.byteLength;
      if (sizeBytes > maxBytes) {
        callback(new Error(`Attachment exceeds the ${maxBytes}-byte limit`));
        return;
      }
      callback(null, bytes);
    },
  });

  try {
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    if (inputError) throw inputError;
    const output = fs.createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 });
    if (options.signal) await pipeline(input, limit, output, { signal: options.signal });
    else await pipeline(input, limit, output);
    await rename(tmpPath, stagedHostPath);
    return { stagedHostPath, sizeBytes };
  } catch (error) {
    input.destroy();
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    input.removeListener('error', captureInputError);
  }
}

function toAttachmentReadable(source: AttachmentByteSource): Readable {
  if (source instanceof Readable) return source;
  if ('getReader' in source && typeof source.getReader === 'function') {
    return Readable.fromWeb(source as ReadableStream<Uint8Array>);
  }
  return Readable.from(source as AsyncIterable<Uint8Array | Buffer | string>);
}

export function stageInboundAttachmentBuffer(
  data: Buffer | Uint8Array,
  options: { stagingDir?: string; maxBytes?: number } = {},
): Promise<StagedAttachmentFile> {
  return stageInboundAttachment(Readable.from([data]), options);
}

export async function cleanupAttachmentStaging(stagingDir = attachmentStagingDir()): Promise<number> {
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const entries = await readdir(stagingDir, { withFileTypes: true });
  await Promise.all(entries.map((entry) => rm(path.join(stagingDir, entry.name), { recursive: true, force: true })));
  return entries.length;
}

export async function removeInboundAttachmentSource(filePath: string, dataDir = DATA_DIR): Promise<void> {
  const resolved = path.resolve(filePath);
  if (!isInboundAttachmentSource(resolved, dataDir)) return;
  await rm(resolved, { force: true });
}

export function isInboundAttachmentSource(filePath: string, dataDir = DATA_DIR): boolean {
  const resolved = path.resolve(filePath);
  return [attachmentStagingDir(dataDir), approvalAttachmentSpoolDir(dataDir)].some((root) =>
    isWithinRoot(root, resolved),
  );
}

export async function cleanupInboundAttachmentSources(contentStr: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr) as Record<string, unknown>;
  } catch {
    return;
  }
  const attachments = parsed.attachments;
  if (!Array.isArray(attachments)) return;
  await Promise.all(
    attachments.map(async (attachment) => {
      if (!attachment || typeof attachment !== 'object') return;
      const sourcePath = (attachment as Record<string, unknown>).stagedHostPath;
      if (typeof sourcePath === 'string') await removeInboundAttachmentSource(sourcePath);
    }),
  );
}

export async function materializeAttachmentFile(args: {
  groupsDir: string;
  groupFolder: string;
  channel: 'discord' | 'whatsapp' | 'agentmail';
  messageId: string;
  attachmentId: string;
  originalName: string;
  contentType: string | null;
  sourceHostPath: string;
}): Promise<MaterializedAttachment> {
  const dir = materializedAttachmentDir(args);
  await mkdir(dir, { recursive: true });

  const safeName = safeAttachmentName(args.originalName);
  const safeAttachmentId = safeAttachmentName(args.attachmentId);
  const safeMessageId = safeAttachmentName(args.messageId);
  const extension = path.extname(safeName);
  const nameWithoutExtension = extension ? safeName.slice(0, -extension.length) : safeName;
  const filename = `${safeAttachmentId}-${nameWithoutExtension}-${randomUUID()}${extension}`;
  const hostPath = path.join(dir, filename);
  const tmpPath = path.join(dir, `.${filename}.${process.pid}.${randomUUID()}.tmp`);

  try {
    await copyFile(args.sourceHostPath, tmpPath);
    await fs.promises.chmod(tmpPath, 0o644);
    const sizeBytes = (await stat(tmpPath)).size;
    await rename(tmpPath, hostPath);
    return {
      workspacePath: `/workspace/agent/attachments/${args.channel}/${safeMessageId}/${filename}`,
      hostPath,
      originalName: args.originalName,
      safeName,
      contentType: args.contentType,
      sizeBytes,
      platformMessageId: args.messageId,
    };
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

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
  channel: 'discord' | 'whatsapp' | 'agentmail';
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
  channel: 'discord' | 'whatsapp' | 'agentmail';
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
