import fs from 'fs';
import path from 'path';
import net, { type Server, type Socket } from 'net';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { DATA_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { openInboundDb, openOutboundDb } from './db/session-db.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import { hostCorrelationPath, inboundDbPath, outboundDbPath } from './session-manager.js';

const AUTH_PROTOCOL = 'nanoclaw-gws-correlation-v2';
const MAX_FRAME_BYTES = 64 * 1024;
const HANDSHAKE_DEADLINE_MS = 2_000;
const SOCKET_BACKLOG = 4;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GwsCorrelationLaunchControl {
  schemaVersion: 1;
  agentGroupId: string;
  sessionId: string;
  providerName: string;
  leaseId: string;
  issuedAt: string;
  /** Base64url launch secret, delivered once over runner stdin only. */
  secret: string;
  /** Filename inside the fixed read-only /run/nanoclaw-gws-control mount. */
  socketName: string;
}

/**
 * Host-only lifecycle capability. The revoker is deliberately non-enumerable,
 * so the serialized launch control delivered to the container contains only
 * data. Production code receives revocation authority only from registration
 * and invokes it after confirmed container termination.
 */
export interface RegisteredGwsCorrelationLaunchControl extends GwsCorrelationLaunchControl {
  revokeAfterConfirmedStop(): boolean;
}

interface ProviderAcceptanceProof {
  event: 'input-accepted';
  scope: 'initial' | 'followup';
  acceptedAt: string;
}

export interface AuthenticatedGwsCorrelationBindRequest {
  schemaVersion: 2;
  action: 'bind';
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
  mac: string;
}

export interface AuthenticatedGwsCorrelationReleaseRequest {
  schemaVersion: 2;
  action: 'release';
  requestId: string;
  agentGroupId: string;
  sessionId: string;
  providerName: string;
  leaseId: string;
  claimToken: string;
  sequence: number;
  providerAcceptance: ProviderAcceptanceProof;
  originalAcceptedAt: string;
  releasedAt: string;
  inputId: string;
  routeKey: string;
  messageIds: string[];
  mac: string;
}

export type AuthenticatedGwsCorrelationRequest =
  | AuthenticatedGwsCorrelationBindRequest
  | AuthenticatedGwsCorrelationReleaseRequest;

interface AcceptedLeaseInput {
  originalAcceptedAt: string;
  routeKey: string;
  messageIds: string[];
  lastClaimToken: string;
  lastProviderAcceptance: ProviderAcceptanceProof;
}

interface GwsCorrelationLeaseState {
  secret: Buffer;
  providerName: string;
  leaseId: string;
  issuedAt: string;
  containerName?: string;
  nextSequence: number;
  acceptedInputs: Map<string, AcceptedLeaseInput>;
  server?: Server;
  socket?: Socket;
  socketPath?: string;
  mutationTail: Promise<void>;
}

const launchLeases = new Map<string, GwsCorrelationLeaseState>();

function launchLeaseKey(agentGroupId: string, sessionId: string): string {
  return `${agentGroupId}\0${sessionId}`;
}

export function hostGwsCorrelationIpcDir(agentGroupId: string, sessionId: string): string {
  const install = createHash('sha256').update(DATA_DIR).digest('hex').slice(0, 12);
  const session = createHash('sha256').update(`${agentGroupId}\0${sessionId}`).digest('hex').slice(0, 16);
  return path.join('/tmp', `ncgws-${install}`, session);
}

function activeLeasePath(agentGroupId: string, sessionId: string): string {
  return path.join(path.dirname(hostCorrelationPath(agentGroupId, sessionId)), 'active-lease.json');
}

interface AcceptedRow {
  id: string;
  seq: number | null;
  status: string;
  trigger: number;
  host_input_id: string | null;
  host_route_key: string | null;
  host_accepted_input_id: string | null;
  host_accepted_route_key: string | null;
  host_accepted_at: string | null;
}

export interface BindAcceptedGwsCorrelationOptions {
  dbPath: string;
  correlationPath: string;
  sessionId: string;
  inputId: string;
  routeKey: string;
  messageIds: string[];
  acceptedAt?: string;
  requestId?: string;
  claimToken?: string;
  leaseId?: string;
  sequence?: number;
}

export function canonicalGwsCorrelationAuthPayload(request: AuthenticatedGwsCorrelationRequest): string {
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

function unlinkIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.lease.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } finally {
    unlinkIfPresent(tmp);
  }
}

function expireAcceptedRows(
  agentGroupId: string,
  sessionId: string,
  leaseId?: string,
  endedAt = new Date().toISOString(),
): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;
  const db = openInboundDb(dbPath);
  try {
    if (leaseId) {
      db.prepare(
        `UPDATE messages_in SET host_acceptance_ended_at = ?
          WHERE host_acceptance_ended_at IS NULL AND host_acceptance_lease_id = ?`,
      ).run(endedAt, leaseId);
    } else {
      db.prepare(`UPDATE messages_in SET host_acceptance_ended_at = ? WHERE host_acceptance_ended_at IS NULL`).run(
        endedAt,
      );
    }
  } finally {
    db.close();
  }
}

function invalidateCorrelationPointers(agentGroupId: string, sessionId: string): void {
  unlinkIfPresent(activeLeasePath(agentGroupId, sessionId));
  unlinkIfPresent(hostCorrelationPath(agentGroupId, sessionId));
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length > MAX_FRAME_BYTES) throw new Error('GWS correlation IPC frame exceeds size limit');
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

function helloPayload(control: Pick<GwsCorrelationLaunchControl, 'agentGroupId' | 'sessionId' | 'leaseId'>): string {
  return JSON.stringify([AUTH_PROTOCOL, 'hello', control.agentGroupId, control.sessionId, control.leaseId]);
}

function closeLeaseTransport(state: GwsCorrelationLeaseState): void {
  state.socket?.destroy();
  try {
    state.server?.close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') throw err;
  }
  if (state.socketPath) unlinkIfPresent(state.socketPath);
  state.socket = undefined;
  state.server = undefined;
  state.socketPath = undefined;
}

function startLeaseSocket(control: GwsCorrelationLaunchControl, state: GwsCorrelationLeaseState): void {
  const socketDir = hostGwsCorrelationIpcDir(control.agentGroupId, control.sessionId);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(socketDir, 0o755);
  const socketPath = path.join(socketDir, control.socketName);
  if (Buffer.byteLength(socketPath) >= 104)
    throw new Error(`GWS control socket path is too long (${socketPath.length})`);
  unlinkIfPresent(socketPath);
  state.socketPath = socketPath;
  const server = net.createServer((socket) => {
    if (state.socket) {
      socket.destroy();
      return;
    }
    let buffer = Buffer.alloc(0);
    let authenticated = false;
    const deadline = setTimeout(
      () => socket.destroy(new Error('GWS control handshake deadline exceeded')),
      HANDSHAKE_DEADLINE_MS,
    );
    let frameDeadline: NodeJS.Timeout | null = null;
    deadline.unref();

    const send = (value: unknown): void => {
      if (!socket.destroyed) socket.write(frame(value));
    };
    socket.on('data', (chunk) => {
      if (authenticated && !frameDeadline) {
        frameDeadline = setTimeout(
          () => socket.destroy(new Error('GWS control frame read deadline exceeded')),
          HANDSHAKE_DEADLINE_MS,
        );
        frameDeadline.unref();
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES + 4) {
        socket.destroy(new Error('GWS control frame exceeds size limit'));
        return;
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length < 2 || length > MAX_FRAME_BYTES) {
          socket.destroy(new Error('invalid GWS control frame length'));
          return;
        }
        if (buffer.length < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let value: any;
        try {
          value = JSON.parse(payload.toString('utf8'));
        } catch {
          socket.destroy(new Error('invalid GWS control JSON'));
          return;
        }
        if (!authenticated) {
          const supplied = typeof value?.mac === 'string' ? Buffer.from(value.mac, 'base64url') : Buffer.alloc(0);
          const expected = createHmac('sha256', state.secret).update(helloPayload(control)).digest();
          if (
            value?.schemaVersion !== 1 ||
            value?.action !== 'hello' ||
            value?.agentGroupId !== control.agentGroupId ||
            value?.sessionId !== control.sessionId ||
            value?.leaseId !== control.leaseId ||
            supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected)
          ) {
            socket.destroy(new Error('GWS control handshake authentication failed'));
            return;
          }
          authenticated = true;
          clearTimeout(deadline);
          state.socket = socket;
          server.close();
          unlinkIfPresent(socketPath);
          send({ schemaVersion: 1, ok: true, action: 'hello' });
          continue;
        }
        state.mutationTail = state.mutationTail.then(async () => {
          try {
            processGwsCorrelationRequest(control.agentGroupId, control.sessionId, value);
            send({ schemaVersion: 1, ok: true, requestId: value?.requestId });
          } catch (err) {
            send({
              schemaVersion: 1,
              ok: false,
              requestId: value?.requestId,
              error: (err instanceof Error ? err.message : String(err)).slice(0, 512),
            });
          }
        });
      }
      if (authenticated && buffer.length === 0 && frameDeadline) {
        clearTimeout(frameDeadline);
        frameDeadline = null;
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(deadline);
      if (frameDeadline) clearTimeout(frameDeadline);
      if (state.socket === socket) {
        // Losing the control fd prevents future binds, but is not proof that
        // the container or an already-admitted tool stopped. Keep the active
        // interval/pointer open until the container lifecycle confirms stop.
        state.socket = undefined;
      }
    });
  });
  server.maxConnections = SOCKET_BACKLOG;
  server.on('error', (err) => log.error('GWS correlation socket error', { err }));
  server.listen({ path: socketPath, backlog: SOCKET_BACKLOG }, () => {
    try {
      fs.chmodSync(socketPath, 0o666);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  });
  state.server = server;
}

export function registerGwsCorrelationLaunchLease(opts: {
  agentGroupId: string;
  sessionId: string;
  providerName: string;
  containerName?: string;
  issuedAt?: string;
  secret?: Buffer;
  leaseId?: string;
}): RegisteredGwsCorrelationLaunchControl {
  const agentGroupId = canonicalCorrelation(opts.agentGroupId, 'agentGroupId');
  const sessionId = canonicalCorrelation(opts.sessionId, 'sessionId');
  const providerName = canonicalCorrelation(opts.providerName, 'providerName');
  const issuedAt = canonicalTimestamp(opts.issuedAt ?? new Date().toISOString(), 'issuedAt');
  const secret = Buffer.from(opts.secret ?? randomBytes(32));
  if (secret.length !== 32) throw new Error('GWS correlation launch secret must be 32 bytes');
  const leaseId = canonicalCorrelation(opts.leaseId ?? randomBytes(24).toString('base64url'), 'leaseId');
  const key = launchLeaseKey(agentGroupId, sessionId);
  if (launchLeases.has(key)) {
    throw new Error(
      `GWS correlation lease for ${agentGroupId}/${sessionId} is still active; confirm container stop first`,
    );
  }
  const socketName = `${createHash('sha256').update(leaseId).digest('hex').slice(0, 16)}.sock`;
  const state: GwsCorrelationLeaseState = {
    secret,
    providerName,
    leaseId,
    issuedAt,
    containerName: opts.containerName,
    nextSequence: 1,
    acceptedInputs: new Map(),
    mutationTail: Promise.resolve(),
  };
  const control = {
    schemaVersion: 1,
    agentGroupId,
    sessionId,
    providerName,
    leaseId,
    issuedAt,
    secret: secret.toString('base64url'),
    socketName,
  } as RegisteredGwsCorrelationLaunchControl;
  Object.defineProperty(control, 'revokeAfterConfirmedStop', {
    enumerable: false,
    value: () => revokeGwsCorrelationLaunchLease(agentGroupId, sessionId, leaseId),
  });
  launchLeases.set(key, state);
  writeJsonAtomic(activeLeasePath(agentGroupId, sessionId), {
    schemaVersion: 1,
    agentGroupId,
    sessionId,
    leaseId,
    issuedAt,
  });
  startLeaseSocket(control, state);
  return control;
}

function revokeGwsCorrelationLaunchLease(agentGroupId: string, sessionId: string, expectedLeaseId?: string): boolean {
  const key = launchLeaseKey(agentGroupId, sessionId);
  const prior = launchLeases.get(key);
  if (expectedLeaseId && prior?.leaseId !== expectedLeaseId) return false;
  // Fail closed before ending rows: no old pointer or transport remains usable.
  launchLeases.delete(key);
  invalidateCorrelationPointers(agentGroupId, sessionId);
  if (prior) expireAcceptedRows(agentGroupId, sessionId, prior.leaseId);
  if (prior) closeLeaseTransport(prior);
  prior?.secret.fill(0);
  return true;
}

function canonicalCorrelation(value: string, name: string): string {
  if (!value || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(`${name} must be nonempty canonical printable ASCII`);
  }
  return value;
}

function canonicalTimestamp(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function readCurrent(correlationPath: string): { inputId?: unknown; leaseId?: unknown } | null {
  try {
    return JSON.parse(fs.readFileSync(correlationPath, 'utf8')) as { inputId?: unknown; leaseId?: unknown };
  } catch {
    return null;
  }
}

function writeCurrentAtomic(
  correlationPath: string,
  value: {
    sessionId: string;
    inputId: string;
    routeKey: string;
    acceptedAt: string;
    messageIds: string[];
    requestId?: string;
    leaseId?: string;
  },
): void {
  const dir = path.dirname(correlationPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.current.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, ...value })}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, correlationPath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Renamed or never created.
    }
  }
}

function writeRequestReceiptAtomic(
  correlationPath: string,
  value: { requestId: string; action: 'release'; inputId: string },
): void {
  const receiptPath = path.join(path.dirname(correlationPath), 'last-request.json');
  const tmp = `${receiptPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, ...value })}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, receiptPath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Renamed or never created.
    }
  }
}

/**
 * Host-authoritative acceptance boundary. The untrusted request can only name
 * an exact host-owned inbound batch; the host chooses the canonical input and
 * route from those rows, stamps all rows in one transaction, then publishes
 * the read-only current pointer. Publishing after commit makes every visible
 * pointer backed by durable host-owned acceptance columns.
 */
export function bindAcceptedGwsCorrelation(opts: BindAcceptedGwsCorrelationOptions): void {
  const inputId = canonicalCorrelation(opts.inputId, 'inputId');
  const routeKey = canonicalCorrelation(opts.routeKey, 'routeKey');
  const acceptedAt = canonicalTimestamp(opts.acceptedAt ?? new Date().toISOString(), 'acceptedAt');
  const messageIds = [...new Set(opts.messageIds)];
  if (messageIds.length === 0 || messageIds.some((id) => !id)) throw new Error('messageIds must name an exact batch');

  const priorCurrent = readCurrent(opts.correlationPath);
  // Pointer absence is the only fail-closed state available across the DB/file
  // boundary. Invalidate before ending the old interval or stamping the new one.
  unlinkIfPresent(opts.correlationPath);
  const db = openInboundDb(opts.dbPath);
  try {
    db.transaction(() => {
      const currentInput = priorCurrent?.inputId;
      if (typeof currentInput === 'string' && currentInput !== inputId) {
        db.prepare(
          `UPDATE messages_in
             SET host_acceptance_ended_at = ?
           WHERE host_accepted_input_id = ? AND host_acceptance_ended_at IS NULL`,
        ).run(acceptedAt, currentInput);
      }

      const lookup = db.prepare(
        `SELECT id, seq, status, trigger, host_input_id, host_route_key,
                host_accepted_input_id, host_accepted_route_key, host_accepted_at
           FROM messages_in WHERE id = ?`,
      );
      const rows = messageIds.map((id) => lookup.get(id) as AcceptedRow | undefined);
      if (rows.some((row) => !row)) throw new Error('accepted batch contains an unknown host inbound row');
      const exactRows = rows as AcceptedRow[];
      if (
        exactRows.some(
          (row) => row.status !== 'pending' && row.status !== 'processing' && row.host_accepted_input_id !== inputId,
        )
      ) {
        throw new Error('accepted batch contains a terminal host inbound row');
      }
      if (exactRows.some((row) => row.host_route_key !== routeKey)) {
        throw new Error('accepted batch does not match the exact host route');
      }
      if (
        exactRows.some(
          (row) =>
            row.host_accepted_input_id !== null &&
            (row.host_accepted_input_id !== inputId ||
              row.host_accepted_route_key !== routeKey ||
              row.host_accepted_at !== acceptedAt),
        )
      ) {
        throw new Error('accepted batch conflicts with immutable original acceptance');
      }
      const triggerRows = exactRows
        .filter((row) => row.trigger === 1 && row.host_input_id)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const exactTopLevel = triggerRows.at(-1)?.host_input_id;
      const extendsExistingInput = exactRows.some((row) => row.host_accepted_input_id === inputId);
      if (!extendsExistingInput && exactTopLevel !== inputId) {
        throw new Error('accepted input does not match the exact host input');
      }

      const update = db.prepare(
        `UPDATE messages_in
            SET host_accepted_input_id = ?, host_accepted_route_key = ?,
                host_accepted_at = ?, host_acceptance_ended_at = NULL,
                host_acceptance_claim_token = ?, host_acceptance_lease_id = ?,
                host_acceptance_sequence = ?
          WHERE id = ? AND host_accepted_at IS NULL`,
      );
      for (const row of exactRows) {
        if (row.host_accepted_at === null) {
          update.run(
            inputId,
            routeKey,
            acceptedAt,
            opts.claimToken ?? null,
            opts.leaseId ?? null,
            opts.sequence ?? null,
            row.id,
          );
        }
      }
    })();
  } finally {
    db.close();
  }

  writeCurrentAtomic(opts.correlationPath, {
    sessionId: opts.sessionId,
    inputId,
    routeKey,
    acceptedAt,
    messageIds: [...messageIds].sort(),
    requestId: opts.requestId,
    leaseId: opts.leaseId,
  });
}

export function releaseAcceptedGwsCorrelation(opts: {
  dbPath: string;
  correlationPath: string;
  inputId: string;
  endedAt?: string;
  requestId?: string;
}): void {
  const inputId = canonicalCorrelation(opts.inputId, 'inputId');
  const endedAt = canonicalTimestamp(opts.endedAt ?? new Date().toISOString(), 'endedAt');
  if (readCurrent(opts.correlationPath)?.inputId === inputId) unlinkIfPresent(opts.correlationPath);
  const db = openInboundDb(opts.dbPath);
  try {
    db.prepare(
      `UPDATE messages_in SET host_acceptance_ended_at = ?
        WHERE host_accepted_input_id = ? AND host_acceptance_ended_at IS NULL`,
    ).run(endedAt, inputId);
  } finally {
    db.close();
  }
  if (opts.requestId) {
    writeRequestReceiptAtomic(opts.correlationPath, { requestId: opts.requestId, action: 'release', inputId });
  }
}

function authenticatedRequest(value: unknown): AuthenticatedGwsCorrelationRequest {
  if (!value || typeof value !== 'object') throw new Error('invalid authenticated GWS correlation request');
  const request = value as Partial<AuthenticatedGwsCorrelationRequest> & Record<string, unknown>;
  if (
    request.schemaVersion !== 2 ||
    (request.action !== 'bind' && request.action !== 'release') ||
    typeof request.requestId !== 'string' ||
    !REQUEST_ID_RE.test(request.requestId) ||
    typeof request.agentGroupId !== 'string' ||
    typeof request.sessionId !== 'string' ||
    typeof request.providerName !== 'string' ||
    typeof request.leaseId !== 'string' ||
    typeof request.claimToken !== 'string' ||
    !Number.isSafeInteger(request.sequence) ||
    (request.sequence as number) < 1 ||
    typeof request.originalAcceptedAt !== 'string' ||
    typeof request.inputId !== 'string' ||
    typeof request.routeKey !== 'string' ||
    !Array.isArray(request.messageIds) ||
    request.messageIds.some((id) => typeof id !== 'string') ||
    typeof request.mac !== 'string'
  ) {
    throw new Error('invalid authenticated GWS correlation request');
  }
  const commonKeys = [
    'schemaVersion',
    'action',
    'requestId',
    'agentGroupId',
    'sessionId',
    'providerName',
    'leaseId',
    'claimToken',
    'sequence',
    'providerAcceptance',
    'originalAcceptedAt',
    'inputId',
    'routeKey',
    'messageIds',
    'mac',
  ];
  const allowedKeys = new Set(request.action === 'release' ? [...commonKeys, 'releasedAt'] : commonKeys);
  if (Object.keys(request).some((key) => !allowedKeys.has(key))) {
    throw new Error('authenticated GWS correlation request contains unknown fields');
  }
  canonicalCorrelation(request.agentGroupId, 'agentGroupId');
  canonicalCorrelation(request.sessionId, 'sessionId');
  canonicalCorrelation(request.providerName, 'providerName');
  canonicalCorrelation(request.leaseId, 'leaseId');
  canonicalCorrelation(request.claimToken, 'claimToken');
  canonicalCorrelation(request.inputId, 'inputId');
  canonicalCorrelation(request.routeKey, 'routeKey');
  const sortedIds = [...new Set(request.messageIds as string[])].sort();
  if (sortedIds.length === 0 || JSON.stringify(sortedIds) !== JSON.stringify(request.messageIds)) {
    throw new Error('authenticated GWS correlation messageIds must be unique and sorted');
  }
  const proof = request.providerAcceptance as Partial<ProviderAcceptanceProof> | undefined;
  if (
    !proof ||
    proof.event !== 'input-accepted' ||
    (proof.scope !== 'initial' && proof.scope !== 'followup') ||
    typeof proof.acceptedAt !== 'string'
  ) {
    throw new Error('authenticated GWS correlation requires provider acceptance proof');
  }
  if (canonicalTimestamp(proof.acceptedAt, 'providerAcceptedAt') !== proof.acceptedAt) {
    throw new Error('providerAcceptedAt must be a canonical ISO timestamp');
  }
  if (canonicalTimestamp(request.originalAcceptedAt, 'originalAcceptedAt') !== request.originalAcceptedAt) {
    throw new Error('originalAcceptedAt must be a canonical ISO timestamp');
  }
  if (request.action === 'release') {
    if (typeof (request as Partial<AuthenticatedGwsCorrelationReleaseRequest>).releasedAt !== 'string') {
      throw new Error('authenticated GWS correlation release requires releasedAt');
    }
    const releasedAt = (request as AuthenticatedGwsCorrelationReleaseRequest).releasedAt;
    if (canonicalTimestamp(releasedAt, 'releasedAt') !== releasedAt) {
      throw new Error('releasedAt must be a canonical ISO timestamp');
    }
  }
  return request as AuthenticatedGwsCorrelationRequest;
}

function verifyRequestMac(state: GwsCorrelationLeaseState, request: AuthenticatedGwsCorrelationRequest): void {
  const supplied = Buffer.from(request.mac, 'base64url');
  const expected = createHmac('sha256', state.secret).update(canonicalGwsCorrelationAuthPayload(request)).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error('GWS correlation request MAC authentication failed');
  }
}

function exactProcessingClaim(outDbPath: string, claimToken: string, messageIds: string[]): void {
  const outDb = openOutboundDb(outDbPath);
  try {
    const rows = outDb
      .prepare(
        "SELECT message_id FROM processing_ack WHERE status = 'processing' AND claim_token = ? ORDER BY message_id",
      )
      .all(claimToken) as Array<{ message_id: string }>;
    if (JSON.stringify(rows.map((row) => row.message_id)) !== JSON.stringify(messageIds)) {
      throw new Error('GWS correlation request does not match the exact processing claim token batch');
    }
  } finally {
    outDb.close();
  }
}

export function processAuthenticatedGwsCorrelationRequest(opts: {
  agentGroupId: string;
  mountedSessionId: string;
  dbPath: string;
  outDbPath: string;
  correlationPath: string;
  request: unknown;
  now?: string;
}): void {
  const request = authenticatedRequest(opts.request);
  const state = launchLeases.get(launchLeaseKey(opts.agentGroupId, opts.mountedSessionId));
  if (
    !state ||
    request.agentGroupId !== opts.agentGroupId ||
    request.sessionId !== opts.mountedSessionId ||
    request.providerName !== state.providerName ||
    request.leaseId !== state.leaseId
  ) {
    throw new Error('GWS correlation request has no matching active host lease');
  }
  let activeMarker: { leaseId?: unknown } | null = null;
  try {
    activeMarker = JSON.parse(fs.readFileSync(activeLeasePath(opts.agentGroupId, opts.mountedSessionId), 'utf8')) as {
      leaseId?: unknown;
    };
  } catch (err) {
    throw new Error('GWS correlation request has no active host lease marker', { cause: err });
  }
  if (activeMarker.leaseId !== state.leaseId) {
    throw new Error('GWS correlation request lease marker does not match the active host lease');
  }
  verifyRequestMac(state, request);
  if (request.sequence !== state.nextSequence) {
    throw new Error('GWS correlation request sequence was replayed, consumed, or out of order');
  }
  const nowMs = Date.parse(canonicalTimestamp(opts.now ?? new Date().toISOString(), 'now'));
  const issuedMs = Date.parse(state.issuedAt);
  const providerAcceptedMs = Date.parse(request.providerAcceptance.acceptedAt);
  const originalAcceptedMs = Date.parse(request.originalAcceptedAt);
  if (providerAcceptedMs < issuedMs || providerAcceptedMs > nowMs + 5_000 || originalAcceptedMs > providerAcceptedMs) {
    throw new Error('GWS correlation provider acceptance time is outside the active lease');
  }

  const existing = state.acceptedInputs.get(request.inputId);
  if (request.action === 'bind') {
    if (existing) {
      if (existing.originalAcceptedAt !== request.originalAcceptedAt || existing.routeKey !== request.routeKey) {
        throw new Error('GWS correlation bind conflicts with immutable original acceptance');
      }
    } else if (request.originalAcceptedAt !== request.providerAcceptance.acceptedAt) {
      throw new Error('new GWS correlation bind must preserve its original provider acceptance time');
    }
    exactProcessingClaim(opts.outDbPath, request.claimToken, request.messageIds);
    const combinedMessageIds = [...new Set([...(existing?.messageIds ?? []), ...request.messageIds])].sort();
    bindAcceptedGwsCorrelation({
      dbPath: opts.dbPath,
      correlationPath: opts.correlationPath,
      sessionId: request.sessionId,
      inputId: request.inputId,
      routeKey: request.routeKey,
      messageIds: combinedMessageIds,
      acceptedAt: request.originalAcceptedAt,
      requestId: request.requestId,
      claimToken: request.claimToken,
      leaseId: request.leaseId,
      sequence: request.sequence,
    });
    state.acceptedInputs.set(request.inputId, {
      originalAcceptedAt: request.originalAcceptedAt,
      routeKey: request.routeKey,
      messageIds: combinedMessageIds,
      lastClaimToken: request.claimToken,
      lastProviderAcceptance: request.providerAcceptance,
    });
  } else {
    if (
      !existing ||
      existing.originalAcceptedAt !== request.originalAcceptedAt ||
      existing.routeKey !== request.routeKey ||
      existing.lastClaimToken !== request.claimToken ||
      JSON.stringify(existing.messageIds) !== JSON.stringify(request.messageIds) ||
      JSON.stringify(existing.lastProviderAcceptance) !== JSON.stringify(request.providerAcceptance)
    ) {
      throw new Error('GWS correlation release does not match the exact accepted claim');
    }
    const releasedMs = Date.parse(request.releasedAt);
    if (releasedMs < Date.parse(existing.lastProviderAcceptance.acceptedAt) || releasedMs > nowMs + 5_000) {
      throw new Error('GWS correlation release time is outside the accepted interval');
    }
    releaseAcceptedGwsCorrelation({
      dbPath: opts.dbPath,
      correlationPath: opts.correlationPath,
      inputId: request.inputId,
      endedAt: request.releasedAt,
      requestId: request.requestId,
    });
    state.acceptedInputs.delete(request.inputId);
  }
  state.nextSequence++;
}

export function processGwsCorrelationRequest(agentGroupId: string, mountedSessionId: string, request: unknown): void {
  const group = getAgentGroup(agentGroupId);
  const session = getSession(mountedSessionId);
  if (!group || !session || session.agent_group_id !== group.id || session.status !== 'active') {
    throw new Error('GWS correlation request does not belong to its isolated active-session mount');
  }
  processAuthenticatedGwsCorrelationRequest({
    agentGroupId: group.id,
    mountedSessionId: session.id,
    dbPath: inboundDbPath(group.id, session.id),
    outDbPath: outboundDbPath(group.id, session.id),
    correlationPath: hostCorrelationPath(group.id, session.id),
    request,
  });
}

export function startGwsCorrelationIpcWatcher(): void {
  log.info('GWS correlation bounded socket control ready');
}

export function stopGwsCorrelationIpcWatcher(): void {
  // Transport shutdown is not lease revocation. At normal shutdown all
  // containers have already drained and their lifecycle capabilities revoked;
  // if drain verification failed, pointers/intervals intentionally remain for
  // startup's verified orphan-stop barrier to expire on the next process.
  for (const state of launchLeases.values()) closeLeaseTransport(state);
}

/**
 * Startup barrier: call only after orphan containers are confirmed stopped.
 * It expires every stale interval (including legacy/null lease rows) and
 * removes every pointer/marker before any channel can wake a session.
 */
export function expireAllStaleGwsCorrelations(endedAt = new Date().toISOString()): void {
  const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
  if (fs.existsSync(sessionsRoot)) {
    for (const group of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupDir = path.join(sessionsRoot, group.name);
      for (const session of fs.readdirSync(groupDir, { withFileTypes: true })) {
        if (!session.isDirectory()) continue;
        invalidateCorrelationPointers(group.name, session.name);
        expireAcceptedRows(group.name, session.name, undefined, endedAt);
      }
    }
  }
  const socketInstallRoot = path.dirname(hostGwsCorrelationIpcDir('_', '_'));
  fs.rmSync(socketInstallRoot, { recursive: true, force: true });
}
