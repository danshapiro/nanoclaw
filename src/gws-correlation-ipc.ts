import fs from 'fs';
import path from 'path';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { DATA_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { openInboundDb, openOutboundDb } from './db/session-db.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import { hostCorrelationPath, inboundDbPath, outboundDbPath } from './session-manager.js';

const IPC_POLL_INTERVAL_MS = 50;
const AUTH_PROTOCOL = 'nanoclaw-gws-correlation-v2';
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
}

const launchLeases = new Map<string, GwsCorrelationLeaseState>();

function launchLeaseKey(agentGroupId: string, sessionId: string): string {
  return `${agentGroupId}\0${sessionId}`;
}

export function hostGwsCorrelationIpcDir(agentGroupId: string, sessionId: string): string {
  return path.join(DATA_DIR, 'v2-gws-correlation-ipc', agentGroupId, sessionId);
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

export function registerGwsCorrelationLaunchLease(opts: {
  agentGroupId: string;
  sessionId: string;
  providerName: string;
  containerName?: string;
  issuedAt?: string;
  secret?: Buffer;
  leaseId?: string;
}): GwsCorrelationLaunchControl {
  const agentGroupId = canonicalCorrelation(opts.agentGroupId, 'agentGroupId');
  const sessionId = canonicalCorrelation(opts.sessionId, 'sessionId');
  const providerName = canonicalCorrelation(opts.providerName, 'providerName');
  const issuedAt = canonicalTimestamp(opts.issuedAt ?? new Date().toISOString(), 'issuedAt');
  const secret = Buffer.from(opts.secret ?? randomBytes(32));
  if (secret.length !== 32) throw new Error('GWS correlation launch secret must be 32 bytes');
  const leaseId = canonicalCorrelation(opts.leaseId ?? randomBytes(24).toString('base64url'), 'leaseId');
  unregisterGwsCorrelationLaunchLease(agentGroupId, sessionId);
  launchLeases.set(launchLeaseKey(agentGroupId, sessionId), {
    secret,
    providerName,
    leaseId,
    issuedAt,
    containerName: opts.containerName,
    nextSequence: 1,
    acceptedInputs: new Map(),
  });
  return {
    schemaVersion: 1,
    agentGroupId,
    sessionId,
    providerName,
    leaseId,
    issuedAt,
    secret: secret.toString('base64url'),
  };
}

export function unregisterGwsCorrelationLaunchLease(agentGroupId: string, sessionId: string): void {
  const key = launchLeaseKey(agentGroupId, sessionId);
  const prior = launchLeases.get(key);
  prior?.secret.fill(0);
  launchLeases.delete(key);
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

function readCurrent(correlationPath: string): { inputId?: unknown } | null {
  try {
    return JSON.parse(fs.readFileSync(correlationPath, 'utf8')) as { inputId?: unknown };
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

  const db = openInboundDb(opts.dbPath);
  try {
    db.transaction(() => {
      const currentInput = readCurrent(opts.correlationPath)?.inputId;
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
  const db = openInboundDb(opts.dbPath);
  try {
    db.prepare(
      `UPDATE messages_in SET host_acceptance_ended_at = ?
        WHERE host_accepted_input_id = ? AND host_acceptance_ended_at IS NULL`,
    ).run(endedAt, inputId);
  } finally {
    db.close();
  }
  if (readCurrent(opts.correlationPath)?.inputId === inputId) {
    try {
      fs.unlinkSync(opts.correlationPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  if (opts.requestId) {
    writeRequestReceiptAtomic(opts.correlationPath, { requestId: opts.requestId, action: 'release', inputId });
  }
}

export function clearAcceptedGwsCorrelation(
  agentGroupId: string,
  sessionId: string,
  endedAt = new Date().toISOString(),
): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;
  const currentPath = hostCorrelationPath(agentGroupId, sessionId);
  const current = readCurrent(currentPath);
  if (typeof current?.inputId === 'string') {
    releaseAcceptedGwsCorrelation({ dbPath, correlationPath: currentPath, inputId: current.inputId, endedAt });
  }
}

function readRequestNoFollow(requestPath: string): unknown {
  const fd = fs.openSync(requestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) {
      throw new Error('GWS correlation request must be a small single-link regular file');
    }
    return JSON.parse(fs.readFileSync(fd, 'utf8')) as unknown;
  } finally {
    fs.closeSync(fd);
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

let watcherRunning = false;
let timer: NodeJS.Timeout | null = null;

function scanRequests(): void {
  const ipcBase = path.join(DATA_DIR, 'v2-gws-correlation-ipc');
  fs.mkdirSync(ipcBase, { recursive: true });
  for (const groupEntry of fs.readdirSync(ipcBase, { withFileTypes: true })) {
    if (!groupEntry.isDirectory()) continue;
    const groupDir = path.join(ipcBase, groupEntry.name);
    for (const sessionEntry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionIpcDir = hostGwsCorrelationIpcDir(groupEntry.name, sessionEntry.name);
      const requestDir = path.join(sessionIpcDir, 'requests');
      if (!fs.existsSync(requestDir)) continue;
      for (const file of fs
        .readdirSync(requestDir)
        .filter((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(name))
        .slice(0, 256)) {
        const requestPath = path.join(requestDir, file);
        try {
          const request = authenticatedRequest(readRequestNoFollow(requestPath));
          if (`${request.requestId}.json` !== file) throw new Error('GWS correlation request filename mismatch');
          processGwsCorrelationRequest(groupEntry.name, sessionEntry.name, request);
          fs.unlinkSync(requestPath);
        } catch (err) {
          log.error('GWS correlation IPC request rejected', {
            agentGroupId: groupEntry.name,
            sessionId: sessionEntry.name,
            file,
            err,
          });
          const errorDir = path.join(sessionIpcDir, 'errors');
          fs.mkdirSync(errorDir, { recursive: true });
          try {
            fs.renameSync(requestPath, path.join(errorDir, `${Date.now()}-${path.basename(file)}`));
          } catch {
            // Another tick/process handled it.
          }
        }
      }
    }
  }
}

function scheduleNext(): void {
  if (!watcherRunning) return;
  timer = setTimeout(() => {
    try {
      scanRequests();
    } catch (err) {
      log.error('GWS correlation IPC watcher error', { err });
    } finally {
      scheduleNext();
    }
  }, IPC_POLL_INTERVAL_MS);
  timer.unref();
}

export function startGwsCorrelationIpcWatcher(): void {
  if (watcherRunning) return;
  watcherRunning = true;
  scanRequests();
  scheduleNext();
  log.info('GWS correlation IPC watcher started');
}

export function stopGwsCorrelationIpcWatcher(): void {
  watcherRunning = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
