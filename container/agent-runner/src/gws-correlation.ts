import { createHmac, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const AUTH_PROTOCOL = 'nanoclaw-gws-correlation-v2';
const DEFAULT_IPC_ROOT = '/workspace/.gws-correlation-ipc';
const DEFAULT_CURRENT = '/workspace/.host-correlation/current.json';
const WAIT_MS = 25;
const TIMEOUT_MS = 10_000;
const MAX_CONTROL_BYTES = 4096;
const waitCell = new Int32Array(new SharedArrayBuffer(4));

export interface GwsCorrelationLaunchControl {
  schemaVersion: 1;
  agentGroupId: string;
  sessionId: string;
  providerName: string;
  leaseId: string;
  issuedAt: string;
  secret: string;
}

interface ProviderAcceptanceProof {
  event: 'input-accepted';
  scope: 'initial' | 'followup';
  acceptedAt: string;
}

interface AuthenticatedRequest {
  schemaVersion: 2;
  action: 'bind' | 'release';
  requestId: string;
  agentGroupId: string;
  sessionId: string;
  providerName: string;
  leaseId: string;
  claimToken: string;
  sequence: number;
  providerAcceptance: ProviderAcceptanceProof;
  originalAcceptedAt: string;
  inputId: string;
  routeKey: string;
  messageIds: string[];
  releasedAt?: string;
  mac: string;
}

interface AcceptedInput {
  originalAcceptedAt: string;
  routeKey: string;
  messageIds: string[];
  lastClaimToken: string;
  lastProviderAcceptance: ProviderAcceptanceProof;
}

interface RuntimeLease {
  agentGroupId: string;
  sessionId: string;
  providerName: string;
  leaseId: string;
  issuedAt: string;
  secret: Buffer;
  nextSequence: number;
  acceptedInputs: Map<string, AcceptedInput>;
}

let runtimeLease: RuntimeLease | null = null;

interface CurrentCorrelation {
  schemaVersion?: unknown;
  requestId?: unknown;
  sessionId?: unknown;
  inputId?: unknown;
  routeKey?: unknown;
  acceptedAt?: unknown;
  messageIds?: unknown;
}

function canonicalString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(`${name} must be nonempty canonical printable ASCII`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error(`${name} must be an ISO timestamp`);
  const canonical = new Date(Date.parse(value)).toISOString();
  if (canonical !== value) throw new Error(`${name} must be a canonical ISO timestamp`);
  return value;
}

export function canonicalGwsCorrelationAuthPayload(request: AuthenticatedRequest): string {
  const common = [
    AUTH_PROTOCOL,
    request.action,
    request.requestId,
    request.agentGroupId,
    request.sessionId,
    request.providerName,
    request.leaseId,
    request.claimToken,
    request.sequence,
    request.inputId,
    request.routeKey,
    [...request.messageIds].sort(),
    request.originalAcceptedAt,
  ];
  return JSON.stringify(
    request.action === 'bind'
      ? [
          ...common,
          request.providerAcceptance.event,
          request.providerAcceptance.scope,
          request.providerAcceptance.acceptedAt,
        ]
      : [
          ...common,
          request.providerAcceptance.event,
          request.providerAcceptance.scope,
          request.providerAcceptance.acceptedAt,
          request.releasedAt,
        ],
  );
}

export function initializeGwsCorrelationLaunchControl(control: GwsCorrelationLaunchControl): void {
  if (control.schemaVersion !== 1) throw new Error('unsupported GWS correlation launch-control schema');
  const secret = Buffer.from(control.secret, 'base64url');
  if (secret.length !== 32) throw new Error('GWS correlation launch secret must be 32 bytes');
  runtimeLease?.secret.fill(0);
  runtimeLease = {
    agentGroupId: canonicalString(control.agentGroupId, 'agentGroupId'),
    sessionId: canonicalString(control.sessionId, 'sessionId'),
    providerName: canonicalString(control.providerName, 'providerName'),
    leaseId: canonicalString(control.leaseId, 'leaseId'),
    issuedAt: canonicalTimestamp(control.issuedAt, 'issuedAt'),
    secret,
    nextSequence: 1,
    acceptedInputs: new Map(),
  };
}

/** Read the one-shot host launch lease from fd 0, close it, and retain only lexical process memory. */
export function consumeGwsCorrelationLaunchControlFromStdin(): void {
  const chunks: Buffer[] = [];
  let size = 0;
  const chunk = Buffer.alloc(512);
  try {
    for (;;) {
      const read = fs.readSync(0, chunk, 0, chunk.length, null);
      if (read === 0) break;
      size += read;
      if (size > MAX_CONTROL_BYTES) throw new Error('GWS correlation launch control exceeds size limit');
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
  } finally {
    chunk.fill(0);
    try {
      fs.closeSync(0);
    } catch {
      // fd 0 may already be closed by a constrained launcher.
    }
  }
  const serialized = Buffer.concat(chunks, size);
  try {
    initializeGwsCorrelationLaunchControl(JSON.parse(serialized.toString('utf8')) as GwsCorrelationLaunchControl);
  } finally {
    serialized.fill(0);
    for (const value of chunks) value.fill(0);
  }
}

function currentPath(): string {
  return process.env.NANOCLAW_HOST_CORRELATION_FILE || DEFAULT_CURRENT;
}

function receiptPath(): string {
  return path.join(path.dirname(currentPath()), 'last-request.json');
}

function requestDir(): string {
  return path.join(process.env.NANOCLAW_GWS_CORRELATION_IPC_ROOT || DEFAULT_IPC_ROOT, 'requests');
}

function writeRequest(value: AuthenticatedRequest): string {
  const dir = requestDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${value.requestId}.json`);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
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

function readReceipt(): { schemaVersion?: unknown; requestId?: unknown; action?: unknown; inputId?: unknown } | null {
  try {
    return JSON.parse(fs.readFileSync(receiptPath(), 'utf8')) as {
      schemaVersion?: unknown;
      requestId?: unknown;
      action?: unknown;
      inputId?: unknown;
    };
  } catch {
    return null;
  }
}

function pause(): void {
  Atomics.wait(waitCell, 0, 0, WAIT_MS);
}

function sign(request: AuthenticatedRequest, lease: RuntimeLease): AuthenticatedRequest {
  request.mac = createHmac('sha256', lease.secret)
    .update(canonicalGwsCorrelationAuthPayload(request))
    .digest('base64url');
  return request;
}

/** Bind an exact provider-accepted processing claim before any subsequent tool event can run. */
export function bindHostGwsCorrelation(
  inputId: string,
  routeKey: string,
  messageIds: string[],
  claimToken: string,
  scope: 'initial' | 'followup',
): boolean {
  const lease = runtimeLease;
  if (!lease) return false;
  const expectedIds = [...new Set(messageIds)].sort();
  const existing = lease.acceptedInputs.get(inputId);
  const acceptedAt = new Date().toISOString();
  const proof: ProviderAcceptanceProof = { event: 'input-accepted', scope, acceptedAt };
  const request = sign(
    {
      schemaVersion: 2,
      action: 'bind',
      requestId: randomUUID(),
      agentGroupId: lease.agentGroupId,
      sessionId: lease.sessionId,
      providerName: lease.providerName,
      leaseId: lease.leaseId,
      claimToken,
      sequence: lease.nextSequence,
      providerAcceptance: proof,
      originalAcceptedAt: existing?.originalAcceptedAt ?? acceptedAt,
      inputId,
      routeKey,
      messageIds: expectedIds,
      mac: '',
    },
    lease,
  );
  const requestPath = writeRequest(request);
  const combinedIds = [...new Set([...(existing?.messageIds ?? []), ...expectedIds])].sort();
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = readCurrent();
    const currentIds = Array.isArray(current?.messageIds) ? [...current.messageIds].sort() : [];
    if (
      current?.schemaVersion === 1 &&
      current.requestId === request.requestId &&
      current.sessionId === lease.sessionId &&
      current.inputId === inputId &&
      current.routeKey === routeKey &&
      current.acceptedAt === request.originalAcceptedAt &&
      JSON.stringify(currentIds) === JSON.stringify(combinedIds)
    ) {
      lease.acceptedInputs.set(inputId, {
        originalAcceptedAt: request.originalAcceptedAt,
        routeKey,
        messageIds: combinedIds,
        lastClaimToken: claimToken,
        lastProviderAcceptance: proof,
      });
      lease.nextSequence++;
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

/** End an accepted input and wait until its exact host-owned pointer is gone/replaced. */
export function releaseHostGwsCorrelation(inputId: string): boolean {
  const lease = runtimeLease;
  const accepted = lease?.acceptedInputs.get(inputId);
  if (!lease || !accepted) return false;
  const request = sign(
    {
      schemaVersion: 2,
      action: 'release',
      requestId: randomUUID(),
      agentGroupId: lease.agentGroupId,
      sessionId: lease.sessionId,
      providerName: lease.providerName,
      leaseId: lease.leaseId,
      claimToken: accepted.lastClaimToken,
      sequence: lease.nextSequence,
      providerAcceptance: accepted.lastProviderAcceptance,
      originalAcceptedAt: accepted.originalAcceptedAt,
      releasedAt: new Date().toISOString(),
      inputId,
      routeKey: accepted.routeKey,
      messageIds: accepted.messageIds,
      mac: '',
    },
    lease,
  );
  const requestPath = writeRequest(request);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = readReceipt();
    if (
      receipt?.schemaVersion === 1 &&
      receipt.requestId === request.requestId &&
      receipt.action === 'release' &&
      receipt.inputId === inputId
    ) {
      lease.acceptedInputs.delete(inputId);
      lease.nextSequence++;
      return true;
    }
    pause();
  }
  try {
    fs.unlinkSync(requestPath);
  } catch {
    // Host may already have consumed it.
  }
  throw new Error(`host did not release GWS correlation for input ${inputId}`);
}
