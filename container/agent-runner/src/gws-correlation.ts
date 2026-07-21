import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const DEFAULT_IPC_ROOT = '/workspace/.gws-correlation-ipc';
const DEFAULT_CURRENT = '/workspace/.host-correlation/current.json';
const WAIT_MS = 25;
const TIMEOUT_MS = 10_000;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

interface CurrentCorrelation {
  schemaVersion?: unknown;
  requestId?: unknown;
  sessionId?: unknown;
  inputId?: unknown;
  routeKey?: unknown;
  acceptedAt?: unknown;
  messageIds?: unknown;
}

function runtimeIdentity(): { sessionId: string } | null {
  const sessionId = process.env.NANOCLAW_SESSION_ID?.trim();
  return sessionId ? { sessionId } : null;
}

function currentPath(): string {
  return process.env.NANOCLAW_HOST_CORRELATION_FILE || DEFAULT_CURRENT;
}

function requestDir(): string {
  return path.join(process.env.NANOCLAW_GWS_CORRELATION_IPC_ROOT || DEFAULT_IPC_ROOT, 'requests');
}

function writeRequest(value: object): string {
  const dir = requestDir();
  fs.mkdirSync(dir, { recursive: true });
  const requestId = (value as { requestId: string }).requestId;
  const dest = path.join(dir, `${requestId}.json`);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  fs.renameSync(tmp, dest);
  return dest;
}

function readCurrent(): CurrentCorrelation | null {
  try {
    return JSON.parse(fs.readFileSync(currentPath(), 'utf8')) as CurrentCorrelation;
  } catch {
    return null;
  }
}

function pause(): void {
  Atomics.wait(waitCell, 0, 0, WAIT_MS);
}

/** Bind the exact provider-accepted input before any subsequent tool event can run. */
export function bindHostGwsCorrelation(inputId: string, routeKey: string, messageIds: string[]): boolean {
  const identity = runtimeIdentity();
  if (!identity) return false;
  const requestId = randomUUID();
  const requestPath = writeRequest({
    action: 'bind',
    requestId,
    sessionId: identity.sessionId,
    inputId,
    routeKey,
    messageIds,
  });
  const expectedIds = [...new Set(messageIds)].sort();
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = readCurrent();
    const currentIds = Array.isArray(current?.messageIds) ? [...current.messageIds].sort() : [];
    if (
      current?.schemaVersion === 1 &&
      current.requestId === requestId &&
      current.sessionId === identity.sessionId &&
      current.inputId === inputId &&
      current.routeKey === routeKey &&
      typeof current.acceptedAt === 'string' &&
      Number.isFinite(Date.parse(current.acceptedAt)) &&
      JSON.stringify(currentIds) === JSON.stringify(expectedIds)
    ) {
      return true;
    }
    pause();
  }
  try {
    fs.unlinkSync(requestPath);
  } catch {
    // Host may already have consumed it.
  }
  throw new Error(`host did not bind exact GWS correlation for input ${inputId}`);
}

/** End an accepted input and wait until its host-owned pointer is gone/replaced. */
export function releaseHostGwsCorrelation(inputId: string): boolean {
  const identity = runtimeIdentity();
  if (!identity) return false;
  const requestId = randomUUID();
  const requestPath = writeRequest({ action: 'release', requestId, sessionId: identity.sessionId, inputId });
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = readCurrent();
    if (!current || current.inputId !== inputId) return true;
    pause();
  }
  try {
    fs.unlinkSync(requestPath);
  } catch {
    // Host may already have consumed it.
  }
  throw new Error(`host did not release GWS correlation for input ${inputId}`);
}
