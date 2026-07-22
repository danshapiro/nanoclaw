import { createHmac, randomUUID } from 'crypto';
import fs from 'fs';
import net, { type Socket } from 'net';

const AUTH_PROTOCOL = 'nanoclaw-gws-correlation-v2'; // gitleaks:allow -- public protocol label, never a credential
const DEFAULT_IPC_ROOT = '/run/nanoclaw-gws-control';
const DEFAULT_CURRENT = '/workspace/.host-correlation/current.json';
const TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_CONTROL_BYTES = 4096;

/**
 * The host durably committed an acceptance mutation, but the authenticated
 * response was lost before the runner could prove completion. Retrying or
 * returning the claim to pending would risk duplicate provider/tool work, so
 * this is a fatal container-lifecycle fault owned by host recovery.
 */
export class GwsCorrelationLifecycleFault extends Error {
  readonly hostCommitMayHaveSucceeded = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GwsCorrelationLifecycleFault';
  }
}

export interface GwsCorrelationLaunchControl {
  schemaVersion: 1;
  agentGroupId: string;
  sessionId: string;
  providerName: string;
  leaseId: string;
  issuedAt: string;
  secret: string;
  socketName: string;
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
  socketName: string;
  socket: Socket | null;
  requestTail: Promise<void>;
  responseWaiters: Map<string, { resolve: (value: ControlResponse) => void; reject: (reason: unknown) => void }>;
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
  leaseId?: unknown;
}

interface ControlResponse {
  schemaVersion?: unknown;
  ok?: unknown;
  action?: unknown;
  requestId?: unknown;
  error?: unknown;
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
    socketName: canonicalString(control.socketName, 'socketName'),
    socket: null,
    requestTail: Promise.resolve(),
    responseWaiters: new Map(),
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

function readCurrent(): CurrentCorrelation | null {
  try {
    return JSON.parse(fs.readFileSync(currentPath(), 'utf8')) as CurrentCorrelation;
  } catch {
    return null;
  }
}

function currentMatchesAcceptedBind(
  current: CurrentCorrelation | null,
  request: AuthenticatedRequest,
  expectedMessageIds: string[],
): boolean {
  const currentIds = Array.isArray(current?.messageIds) ? [...current.messageIds].sort() : [];
  return (
    current?.schemaVersion === 1 &&
    current.requestId === request.requestId &&
    current.sessionId === request.sessionId &&
    current.inputId === request.inputId &&
    current.routeKey === request.routeKey &&
    current.acceptedAt === request.originalAcceptedAt &&
    current.leaseId === request.leaseId &&
    JSON.stringify(currentIds) === JSON.stringify(expectedMessageIds)
  );
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length > MAX_FRAME_BYTES) throw new Error('GWS control frame exceeds size limit');
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

function installResponseReader(lease: RuntimeLease, socket: Socket): void {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BYTES + 4) {
      socket.destroy(new Error('GWS control response exceeds size limit'));
      return;
    }
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length < 2 || length > MAX_FRAME_BYTES) {
        socket.destroy(new Error('invalid GWS control response length'));
        return;
      }
      if (buffer.length < length + 4) return;
      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let response: ControlResponse;
      try {
        response = JSON.parse(payload.toString('utf8')) as ControlResponse;
      } catch {
        socket.destroy(new Error('invalid GWS control response JSON'));
        return;
      }
      const key = response.action === 'hello' ? 'hello' : String(response.requestId ?? '');
      const waiter = lease.responseWaiters.get(key);
      if (waiter) {
        lease.responseWaiters.delete(key);
        waiter.resolve(response);
      }
    }
  });
  const rejectAll = (reason: unknown): void => {
    for (const waiter of lease.responseWaiters.values()) waiter.reject(reason);
    lease.responseWaiters.clear();
    if (lease.socket === socket) lease.socket = null;
  };
  socket.on('error', rejectAll);
  socket.on('close', () => rejectAll(new Error('GWS control socket closed')));
}

async function sendControlFrame(lease: RuntimeLease, key: string, value: unknown): Promise<ControlResponse> {
  const socket = lease.socket;
  if (!socket || socket.destroyed) throw new Error('trusted host GWS control socket is unavailable');
  const response = new Promise<ControlResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      lease.responseWaiters.delete(key);
      lease.socket?.destroy(new Error('trusted host GWS control response deadline exceeded'));
      reject(new Error('trusted host GWS control response deadline exceeded'));
    }, TIMEOUT_MS);
    timer.unref();
    const originalResolve = resolve;
    lease.responseWaiters.set(key, {
      resolve: (value) => {
        clearTimeout(timer);
        originalResolve(value);
      },
      reject: (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    });
  });
  socket.write(encodeFrame(value));
  const result = await response;
  if (result.schemaVersion !== 1 || result.ok !== true) {
    throw new Error(typeof result.error === 'string' ? result.error : 'host rejected GWS correlation request');
  }
  return result;
}

/** Authenticate the single persistent host control channel before providers load. */
export async function connectGwsCorrelationControlSocket(): Promise<void> {
  const lease = runtimeLease;
  if (!lease) throw new Error('GWS correlation launch control was not initialized');
  const socketPath = `${process.env.NANOCLAW_GWS_CORRELATION_IPC_ROOT || DEFAULT_IPC_ROOT}/${lease.socketName}`;
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const socket = net.createConnection(socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      lease.socket = socket;
      installResponseReader(lease, socket);
      const hello = {
        schemaVersion: 1,
        action: 'hello',
        agentGroupId: lease.agentGroupId,
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
        mac: createHmac('sha256', lease.secret)
          .update(JSON.stringify([AUTH_PROTOCOL, 'hello', lease.agentGroupId, lease.sessionId, lease.leaseId]))
          .digest('base64url'),
      };
      await sendControlFrame(lease, 'hello', hello);
      return;
    } catch (err) {
      lastError = err;
      socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error('could not authenticate trusted host GWS control socket', { cause: lastError });
}

function sign(request: AuthenticatedRequest, lease: RuntimeLease): AuthenticatedRequest {
  request.mac = createHmac('sha256', lease.secret)
    .update(canonicalGwsCorrelationAuthPayload(request))
    .digest('base64url');
  return request;
}

/** Bind an exact provider-accepted processing claim before any subsequent tool event can run. */
export async function bindHostGwsCorrelation(
  inputId: string,
  routeKey: string,
  messageIds: string[],
  claimToken: string,
  scope: 'initial' | 'followup',
): Promise<void> {
  const lease = runtimeLease;
  if (!lease) throw new Error('trusted host GWS launch lease is unavailable');
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
  const combinedIds = [...new Set([...(existing?.messageIds ?? []), ...expectedIds])].sort();
  const operation = lease.requestTail.then(async () => {
    try {
      await sendControlFrame(lease, request.requestId, request);
    } catch (err) {
      // The authenticated response can be lost after the host transaction and
      // pointer publication have committed. Exact pointer evidence proves that
      // this claim crossed the acceptance boundary, but not that the provider
      // observed the response. Record it locally and force recovery ownership;
      // retrying the bind/input could duplicate tool work.
      if (!currentMatchesAcceptedBind(readCurrent(), request, combinedIds)) throw err;
      lease.acceptedInputs.set(inputId, {
        originalAcceptedAt: request.originalAcceptedAt,
        routeKey,
        messageIds: combinedIds,
        lastClaimToken: claimToken,
        lastProviderAcceptance: proof,
      });
      lease.nextSequence++;
      throw new GwsCorrelationLifecycleFault(
        `trusted host committed GWS correlation for input ${inputId}, but its response was lost`,
        { cause: err },
      );
    }

    if (!currentMatchesAcceptedBind(readCurrent(), request, combinedIds)) {
      // An authenticated success response is itself host-commit evidence. If
      // the exact pointer cannot be observed, the lifecycle is ambiguous; do
      // not revoke or retry from inside the still-running container.
      throw new GwsCorrelationLifecycleFault(
        `trusted host accepted GWS correlation for input ${inputId}, but exact publication could not be verified`,
      );
    }
    lease.acceptedInputs.set(inputId, {
      originalAcceptedAt: request.originalAcceptedAt,
      routeKey,
      messageIds: combinedIds,
      lastClaimToken: claimToken,
      lastProviderAcceptance: proof,
    });
    lease.nextSequence++;
  });
  lease.requestTail = operation.catch(() => undefined);
  return operation;
}

/** End an accepted input and wait until its exact host-owned pointer is gone/replaced. */
export async function releaseHostGwsCorrelation(inputId: string): Promise<void> {
  const lease = runtimeLease;
  const accepted = lease?.acceptedInputs.get(inputId);
  if (!lease || !accepted) return;
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
  const operation = lease.requestTail.then(async () => {
    await sendControlFrame(lease, request.requestId, request);
    const current = readCurrent();
    if (current?.inputId === inputId && current.leaseId === lease.leaseId) {
      const err = new Error(`host did not invalidate GWS correlation for input ${inputId}`);
      lease.socket?.destroy(err);
      throw err;
    }
    lease.acceptedInputs.delete(inputId);
    lease.nextSequence++;
  });
  lease.requestTail = operation.catch(() => undefined);
  return operation;
}
