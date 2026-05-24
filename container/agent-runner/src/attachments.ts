import fs from 'fs/promises';
import path from 'path';

import type { MessageInRow } from './db/messages-in.js';
import type { QueryAttachment } from './providers/types.js';

export const DEFAULT_INBOUND_ATTACHMENT_ROOTS = ['/workspace/agent/attachments/'];
export const DEFAULT_EXPLICIT_PATH_ROOTS = ['/workspace/agent/tmp/', '/workspace/outbox/'];

const DENIED_SUBPATHS = [
  '/workspace/agent/browser-auth/',
  '/workspace/agent/container.json',
  '/workspace/agent/.env',
  '/workspace/agent/env',
  '/workspace/agent/secrets/',
  '/workspace/agent/config/',
  '/workspace/agent/.config/',
  '/workspace/agent/.ssh/',
  '/srv/',
  '/etc/',
];

const IMAGE_MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_ATTACHMENTS = 6;

export type AttachmentSourceKind = 'inbound' | 'explicit_path';

export interface InspectedFile {
  path: string;
  realPath: string;
  filename: string;
  mime: string | null;
  sizeBytes: number;
  isRegularFile: boolean;
  isSymlink?: boolean;
}

export interface AttachmentLogEvent {
  severity: 'debug' | 'info' | 'warn';
  event: 'attachment_accepted' | 'attachment_skipped';
  source: AttachmentSourceKind;
  reason?: string;
  basename?: string;
  pathHash?: string;
  mime?: string | null;
  sizeBytes?: number;
}

export interface CollectQueryAttachmentsInput {
  messages: MessageInRow[];
  pathReferenceMessages: MessageInRow[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxAttachments?: number;
  inspectFile?: (filePath: string) => Promise<InspectedFile | null>;
  log?: (event: AttachmentLogEvent) => void;
}

interface Candidate {
  source: AttachmentSourceKind;
  path: string;
  filename?: string;
  declaredMime?: string | null;
  declaredSize?: number | null;
}

export async function collectQueryAttachments(input: CollectQueryAttachmentsInput): Promise<QueryAttachment[]> {
  const inspectFile = input.inspectFile ?? defaultInspectFile;
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = input.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxAttachments = input.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;
  const log = input.log ?? (() => undefined);

  const candidates = [
    ...collectInboundCandidates(input.messages),
    ...collectExplicitPathCandidates(input.pathReferenceMessages),
  ];

  const out: QueryAttachment[] = [];
  const seenRealPaths = new Set<string>();
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (out.length >= maxAttachments) {
      logSkip(log, candidate, 'max_attachments');
      continue;
    }

    const rootCheck = candidate.source === 'inbound' ? DEFAULT_INBOUND_ATTACHMENT_ROOTS : DEFAULT_EXPLICIT_PATH_ROOTS;
    if (isDeniedPath(candidate.path)) {
      logSkip(log, candidate, 'denied_path');
      continue;
    }
    if (!isUnderAnyRoot(candidate.path, rootCheck)) {
      logSkip(log, candidate, 'outside_allowed_roots');
      continue;
    }

    const inspected = await inspectFile(candidate.path);
    if (!inspected) {
      logSkip(log, candidate, 'inspect_failed');
      continue;
    }
    if (inspected.isSymlink || !inspected.isRegularFile) {
      logSkip(log, candidate, inspected.isSymlink ? 'symlink' : 'not_regular_file', inspected);
      continue;
    }
    if (!isUnderAnyRoot(inspected.realPath, rootCheck)) {
      logSkip(log, candidate, 'realpath_outside_allowed_roots', inspected);
      continue;
    }
    if (seenRealPaths.has(inspected.realPath)) {
      logSkip(log, candidate, 'duplicate', inspected);
      continue;
    }
    if (inspected.sizeBytes <= 0) {
      logSkip(log, candidate, 'empty_file', inspected);
      continue;
    }
    if (inspected.sizeBytes > maxFileBytes) {
      logSkip(log, candidate, 'file_too_large', inspected);
      continue;
    }
    if (totalBytes + inspected.sizeBytes > maxTotalBytes) {
      logSkip(log, candidate, 'total_too_large', inspected);
      continue;
    }

    const normalized = normalizeAcceptedMime(candidate, inspected);
    if (!normalized.ok) {
      logSkip(log, candidate, normalized.reason, inspected);
      continue;
    }

    const attachment = {
      path: inspected.path,
      filename: candidate.filename || inspected.filename || path.basename(candidate.path),
      mime: normalized.mime,
      sizeBytes: inspected.sizeBytes,
    };
    out.push(attachment);
    seenRealPaths.add(inspected.realPath);
    totalBytes += inspected.sizeBytes;
    log({
      severity: 'info',
      event: 'attachment_accepted',
      source: candidate.source,
      basename: path.basename(candidate.path),
      pathHash: hashPathForLog(candidate.path),
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
    });
  }

  return out;
}

function collectInboundCandidates(messages: MessageInRow[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const msg of messages) {
    const content = parseContent(msg.content);
    const attachments = Array.isArray(content.attachments) ? content.attachments : [];
    for (const raw of attachments) {
      if (!raw || typeof raw !== 'object') continue;
      const att = raw as Record<string, unknown>;
      if (typeof att.workspacePath !== 'string') continue;
      candidates.push({
        source: 'inbound',
        path: att.workspacePath,
        filename:
          (typeof att.originalName === 'string' && att.originalName) ||
          (typeof att.name === 'string' && att.name) ||
          (typeof att.safeName === 'string' && att.safeName) ||
          path.basename(att.workspacePath),
        declaredMime:
          (typeof att.contentType === 'string' && att.contentType) ||
          (typeof att.mimeType === 'string' && att.mimeType) ||
          (typeof att.type === 'string' && att.type) ||
          null,
        declaredSize: typeof att.sizeBytes === 'number' ? att.sizeBytes : typeof att.size === 'number' ? att.size : null,
      });
    }
  }
  return candidates;
}

function collectExplicitPathCandidates(messages: MessageInRow[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const msg of messages) {
    if ((msg.kind !== 'chat' && msg.kind !== 'chat-sdk') || msg.trigger !== 1) continue;
    const content = parseContent(msg.content);
    const text = typeof content.text === 'string' ? content.text : '';
    for (const filePath of extractExplicitPaths(text)) {
      candidates.push({
        source: 'explicit_path',
        path: filePath,
        filename: path.basename(filePath),
      });
    }
  }
  return candidates;
}

export function extractExplicitPaths(text: string): string[] {
  let scanText = text
    .split('\n')
    .filter((line) => !/^\s*Path:\s+\/workspace\//.test(line))
    .join('\n');
  const paths: string[] = [];

  for (const re of [/`(\/workspace\/[^`\n]+)`/g, /"(\/workspace\/[^"\n]+)"/g, /'(\/workspace\/[^'\n]+)'/g]) {
    for (const match of scanText.matchAll(re)) {
      paths.push(cleanPath(match[1]));
    }
    scanText = scanText.replace(re, ' ');
  }

  for (const match of scanText.matchAll(/\battach:\s*(\/workspace\/[^\n]+)/gi)) {
    paths.push(cleanPath(match[1]));
  }
  scanText = scanText.replace(/\battach:\s*(\/workspace\/[^\n]+)/gi, ' ');

  for (const match of scanText.matchAll(/(\/workspace\/(?:agent\/tmp|outbox)\/[^\s<>"'`]+)/g)) {
    paths.push(cleanPath(match[1]));
  }

  return [...new Set(paths.filter(Boolean))];
}

async function defaultInspectFile(filePath: string): Promise<InspectedFile | null> {
  try {
    const lst = await fs.lstat(filePath);
    if (lst.isSymbolicLink()) {
      return {
        path: filePath,
        realPath: filePath,
        filename: path.basename(filePath),
        mime: mimeFromExtension(filePath),
        sizeBytes: 0,
        isRegularFile: false,
        isSymlink: true,
      };
    }
    const realPath = await fs.realpath(filePath);
    const st = await fs.stat(realPath);
    const header = st.isFile() ? await readHeader(realPath) : Buffer.alloc(0);
    return {
      path: filePath,
      realPath,
      filename: path.basename(filePath),
      mime: sniffImageMime(header) ?? mimeFromExtension(filePath),
      sizeBytes: st.size,
      isRegularFile: st.isFile(),
      isSymlink: false,
    };
  } catch {
    return null;
  }
}

async function readHeader(filePath: string): Promise<Buffer> {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    const read = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, read.bytesRead);
  } finally {
    await fh.close();
  }
}

export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function normalizeAcceptedMime(
  candidate: Candidate,
  inspected: InspectedFile,
): { ok: true; mime: string } | { ok: false; reason: string } {
  const declared = normalizeMime(candidate.declaredMime);
  const inspectedMime = normalizeMime(inspected.mime);
  const extMime = mimeFromExtension(candidate.path);
  const mime = inspectedMime ?? extMime ?? declared;

  if (!mime || !ALLOWED_IMAGE_MIMES.has(mime)) {
    return { ok: false, reason: 'unsupported_mime' };
  }
  if (inspectedMime && extMime && inspectedMime !== extMime) {
    return { ok: false, reason: 'mime_mismatch' };
  }
  if (declared && declared !== mime) {
    return { ok: false, reason: 'mime_mismatch' };
  }
  if (candidate.declaredSize != null && candidate.declaredSize > 0 && candidate.declaredSize !== inspected.sizeBytes) {
    return { ok: false, reason: 'size_mismatch' };
  }
  return { ok: true, mime };
}

function normalizeMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  return mime.split(';', 1)[0].trim().toLowerCase() || null;
}

function mimeFromExtension(filePath: string): string | null {
  return IMAGE_MIME_BY_EXT.get(path.extname(filePath).toLowerCase()) ?? null;
}

function isUnderAnyRoot(filePath: string, roots: string[]): boolean {
  return roots.some((root) => filePath === root.slice(0, -1) || filePath.startsWith(root));
}

function isDeniedPath(filePath: string): boolean {
  return DENIED_SUBPATHS.some((denied) => filePath === denied || filePath.startsWith(denied));
}

function cleanPath(raw: string): string {
  let out = raw.trim();
  out = out.replace(/[.,;:!?]+$/g, '');
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1);
  }
  return out;
}

function logSkip(
  log: (event: AttachmentLogEvent) => void,
  candidate: Candidate,
  reason: string,
  inspected?: InspectedFile,
): void {
  log({
    severity: reason === 'duplicate' ? 'debug' : 'warn',
    event: 'attachment_skipped',
    source: candidate.source,
    reason,
    basename: path.basename(candidate.path),
    pathHash: hashPathForLog(candidate.path),
    mime: inspected?.mime ?? candidate.declaredMime ?? null,
    sizeBytes: inspected?.sizeBytes ?? candidate.declaredSize ?? undefined,
  });
}

function hashPathForLog(filePath: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < filePath.length; i++) {
    hash ^= filePath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseContent(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { text: json };
  }
}
