import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';

import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';

export interface DiscordAttachmentInput {
  id?: string | null;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  url?: string | null;
}

export interface DiscordAttachmentLimits {
  maxCount: number;
  maxBytesPerFile: number;
  maxBytesTotal: number;
  downloadTimeoutMs: number;
  messageDownloadBudgetMs: number;
  maxFilenameChars: number;
}

export interface MaterializeDiscordAttachmentsArgs {
  messageId: string;
  group: RegisteredGroup;
  attachments: DiscordAttachmentInput[];
  fetchImpl?: typeof fetch;
  groupDir?: string;
  limits?: Partial<DiscordAttachmentLimits>;
}

interface DownloadOneAttachmentArgs {
  attachment: DiscordAttachmentInput;
  index: number;
  displayName: string;
  groupDir: string;
  messageSegment: string;
  fetchAttachment: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
  maxFilenameChars: number;
}

interface DownloadResult {
  displayName: string;
  contentType: string;
  label: string;
  bytes: number;
  containerPath: string;
}

const DEFAULT_LIMITS: DiscordAttachmentLimits = {
  maxCount: 10,
  maxBytesPerFile: 25 * 1024 * 1024,
  maxBytesTotal: 50 * 1024 * 1024,
  downloadTimeoutMs: 30_000,
  messageDownloadBudgetMs: 60_000,
  maxFilenameChars: 120,
};

export async function materializeDiscordAttachments(
  args: MaterializeDiscordAttachmentsArgs,
): Promise<string[]> {
  const limits = { ...DEFAULT_LIMITS, ...args.limits };
  const fetchAttachment = args.fetchImpl ?? fetch;
  const groupDir = args.groupDir ?? resolveGroupFolderPath(args.group.folder);
  const messageSegment = sanitizePathSegment(args.messageId, 'message');
  const startedAt = Date.now();
  const lines: string[] = [];
  let totalBytes = 0;

  for (const [index, attachment] of args.attachments.entries()) {
    const displayName = sanitizeDisplayName(
      attachment.name,
      `attachment-${index + 1}`,
      limits.maxFilenameChars,
    );

    if (index >= limits.maxCount) {
      lines.push(
        formatAttachmentFailure(
          displayName,
          `message has more than ${limits.maxCount} attachments`,
        ),
      );
      continue;
    }

    let timeoutMs = limits.downloadTimeoutMs;
    try {
      const elapsedMs = Date.now() - startedAt;
      const remainingBudgetMs = limits.messageDownloadBudgetMs - elapsedMs;
      if (remainingBudgetMs <= 0) {
        throw new Error(
          `message attachment download budget exceeded after ${formatDuration(
            limits.messageDownloadBudgetMs,
          )}`,
        );
      }

      const remainingTotalBytes = limits.maxBytesTotal - totalBytes;
      if (remainingTotalBytes <= 0) {
        throw new Error(
          `message attachment byte budget exceeded after ${formatBytes(
            limits.maxBytesTotal,
          )}`,
        );
      }

      const maxBytes = Math.min(limits.maxBytesPerFile, remainingTotalBytes);
      if (
        attachment.size !== null &&
        attachment.size !== undefined &&
        attachment.size > maxBytes
      ) {
        throw new Error(
          `attachment size ${formatBytes(
            attachment.size,
          )} exceeds remaining limit ${formatBytes(maxBytes)}`,
        );
      }

      timeoutMs = Math.min(limits.downloadTimeoutMs, remainingBudgetMs);
      const result = await downloadOneAttachment({
        attachment,
        index,
        displayName,
        groupDir,
        messageSegment,
        fetchAttachment,
        timeoutMs,
        maxBytes,
        maxFilenameChars: limits.maxFilenameChars,
      });

      totalBytes += result.bytes;
      lines.push(formatAttachmentSuccess(result));
    } catch (error) {
      const reason = formatDownloadError(error, timeoutMs);
      logger.warn(
        { err: error, messageId: args.messageId, attachment: displayName },
        'Discord attachment materialization failed',
      );
      lines.push(formatAttachmentFailure(displayName, reason));
    }
  }

  return lines;
}

async function downloadOneAttachment(
  args: DownloadOneAttachmentArgs,
): Promise<DownloadResult> {
  const url = parseHttpsUrl(args.attachment.url);
  const response = await args.fetchAttachment(url, {
    signal: AbortSignal.timeout(args.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`download returned HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error('download response did not include a body');
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedContentLength = Number(contentLength);
    if (
      Number.isFinite(parsedContentLength) &&
      parsedContentLength > args.maxBytes
    ) {
      throw new Error(
        `download size ${formatBytes(
          parsedContentLength,
        )} exceeds remaining limit ${formatBytes(args.maxBytes)}`,
      );
    }
  }

  const messageDir = await ensureManagedDirectory(args.groupDir, [
    'attachments',
    'discord',
    args.messageSegment,
  ]);
  const safeAttachmentId = sanitizePathSegment(
    args.attachment.id,
    `attachment-${args.index + 1}`,
  );
  const safeFilename = sanitizePathFilename(
    args.attachment.name,
    `attachment-${args.index + 1}`,
    args.maxFilenameChars,
  );
  const finalFilename = `${safeAttachmentId}-${safeFilename}`;
  const tempFilename = `.${finalFilename}.${process.pid}.${Date.now()}.tmp`;
  const finalPath = path.join(messageDir, finalFilename);
  const tempPath = path.join(messageDir, tempFilename);
  let fileHandle: fsp.FileHandle | null = null;
  let shouldRemoveTemp = true;

  try {
    fileHandle = await fsp.open(
      tempPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    await assertSafeOpenedTempFile(tempPath, args.groupDir, fileHandle);

    let bytes = 0;
    const stream = Readable.fromWeb(response.body);
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > args.maxBytes) {
        throw new Error(
          `download exceeded remaining limit ${formatBytes(args.maxBytes)}`,
        );
      }
      await fileHandle.write(buffer);
    }

    await fileHandle.close();
    fileHandle = null;

    await assertSafeManagedDirectory(messageDir, args.groupDir, [
      'attachments',
      'discord',
      args.messageSegment,
    ]);
    await fsp.rename(tempPath, finalPath);
    shouldRemoveTemp = false;

    return {
      displayName: args.displayName,
      contentType: normalizeMimeType(args.attachment.contentType),
      label: labelForMimeType(args.attachment.contentType),
      bytes,
      containerPath: `/workspace/group/attachments/discord/${args.messageSegment}/${finalFilename}`,
    };
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => undefined);
    }
    if (shouldRemoveTemp) {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

function parseHttpsUrl(rawUrl: string | null | undefined): URL {
  if (!rawUrl) {
    throw new Error('attachment URL is missing');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    throw new Error('attachment URL is invalid', { cause: err });
  }

  if (url.protocol !== 'https:') {
    throw new Error('attachment URL must use https');
  }
  return url;
}

async function ensureManagedDirectory(
  groupDir: string,
  components: string[],
): Promise<string> {
  let current = groupDir;
  for (const component of components) {
    current = path.join(current, component);
    await ensureDirectoryComponent(
      current,
      groupDir,
      componentsFor(groupDir, current),
    );
  }
  return current;
}

async function ensureDirectoryComponent(
  componentPath: string,
  groupDir: string,
  relativeComponents: string[],
): Promise<void> {
  let stat = await lstatIfExists(componentPath);
  if (!stat) {
    try {
      await fsp.mkdir(componentPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    stat = await fsp.lstat(componentPath);
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Unsafe attachment storage path: ${relativeComponents.join('/')}`,
    );
  }
  await assertSafeManagedDirectory(componentPath, groupDir, relativeComponents);
}

async function lstatIfExists(
  componentPath: string,
): Promise<fs.Stats | undefined> {
  try {
    return await fsp.lstat(componentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertSafeManagedDirectory(
  dir: string,
  groupDir: string,
  relativeComponents?: string[],
): Promise<void> {
  const stat = await fsp.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Unsafe attachment storage path: ${
        relativeComponents?.join('/') ?? path.relative(groupDir, dir)
      }`,
    );
  }

  const groupReal = await fsp.realpath(groupDir);
  const dirReal = await fsp.realpath(dir);
  if (dirReal !== groupReal && !dirReal.startsWith(`${groupReal}${path.sep}`)) {
    throw new Error(
      `Unsafe attachment storage path: ${
        relativeComponents?.join('/') ?? path.relative(groupDir, dir)
      }`,
    );
  }
}

async function assertSafeOpenedTempFile(
  tempPath: string,
  groupDir: string,
  fileHandle: fsp.FileHandle,
): Promise<void> {
  const groupReal = await fsp.realpath(groupDir);
  const tempReal = await fsp.realpath(tempPath);
  if (
    tempReal !== groupReal &&
    !tempReal.startsWith(`${groupReal}${path.sep}`)
  ) {
    throw new Error('Unsafe attachment temp path escaped group folder');
  }

  const tempStat = await fileHandle.stat();
  if (!tempStat.isFile()) {
    throw new Error('Unsafe attachment temp path is not a regular file');
  }
}

function componentsFor(groupDir: string, componentPath: string): string[] {
  return path.relative(groupDir, componentPath).split(path.sep).filter(Boolean);
}

function formatAttachmentSuccess(result: DownloadResult): string {
  return `[${result.label}: ${result.displayName} type=${result.contentType} size=${formatBytes(result.bytes)} path=${result.containerPath}]`;
}

function formatAttachmentFailure(displayName: string, reason: string): string {
  return `[Attachment failed: ${sanitizeOneLine(displayName, 'attachment')} reason=${sanitizeOneLine(reason, 'unknown error')}]`;
}

function formatDownloadError(error: unknown, timeoutMs: number): string {
  if (isTimeoutError(error)) {
    return `download timed out after ${formatDuration(timeoutMs)}`;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'unknown attachment download failure';
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return (
    name.includes('abort') ||
    name.includes('timeout') ||
    message.includes('aborted') ||
    message.includes('timeout')
  );
}

function sanitizeDisplayName(
  rawName: string | null | undefined,
  fallback: string,
  maxChars: number,
): string {
  const base = path.basename((rawName || '').replaceAll('\\', '/')).trim();
  return sanitizeOneLine(base, fallback).slice(0, maxChars);
}

function sanitizeOneLine(rawValue: string, fallback: string): string {
  const safe = rawValue
    .replaceAll('[', ' ')
    .replaceAll(']', ' ')
    .replaceAll(/[^\S\r\n]+/g, ' ')
    .replaceAll(/\r|\n/g, ' ')
    .split('')
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return safe || fallback;
}

function normalizeMimeType(rawType: string | null | undefined): string {
  if (!rawType) return 'unknown';
  const type = rawType.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) {
    return 'unknown';
  }
  return type;
}

function labelForMimeType(rawType: string | null | undefined): string {
  const type = normalizeMimeType(rawType);
  if (type.startsWith('image/')) return 'Image';
  if (type.startsWith('video/')) return 'Video';
  if (type.startsWith('audio/')) return 'Audio';
  return 'File';
}

function sanitizePathFilename(
  rawName: string | null | undefined,
  fallback: string,
  maxChars: number,
): string {
  const displayName = sanitizeDisplayName(rawName, fallback, maxChars);
  let safe = displayName
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!safe || safe === '.' || safe === '..') {
    safe = fallback;
  }
  if (safe.startsWith('.')) {
    safe = `file${safe}`;
  }
  return truncateFilename(safe, maxChars);
}

function sanitizePathSegment(
  rawValue: string | null | undefined,
  fallback: string,
): string {
  const base = path.basename((rawValue || '').replaceAll('\\', '/')).trim();
  const safe = base
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!safe || safe === '.' || safe === '..') return fallback;
  return safe.slice(0, 80);
}

function truncateFilename(filename: string, maxChars: number): string {
  if (filename.length <= maxChars) return filename;

  const extension = path.extname(filename);
  if (extension && extension.length < Math.min(maxChars, 24)) {
    const stemLength = Math.max(1, maxChars - extension.length);
    return `${filename.slice(0, stemLength)}${extension}`;
  }
  return filename.slice(0, maxChars);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}
