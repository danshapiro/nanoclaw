import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { openInboundDb } from './db/session-db.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import { hostCorrelationPath, inboundDbPath } from './session-manager.js';

const IPC_POLL_INTERVAL_MS = 50;

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
        `SELECT id, seq, status, trigger, host_input_id, host_route_key
           FROM messages_in WHERE id = ?`,
      );
      const rows = messageIds.map((id) => lookup.get(id) as AcceptedRow | undefined);
      if (rows.some((row) => !row)) throw new Error('accepted batch contains an unknown host inbound row');
      const exactRows = rows as AcceptedRow[];
      if (exactRows.some((row) => row.status !== 'pending' && row.status !== 'processing')) {
        throw new Error('accepted batch contains a terminal host inbound row');
      }
      if (exactRows.some((row) => row.host_route_key !== routeKey)) {
        throw new Error('accepted batch does not match the exact host route');
      }
      const triggerRows = exactRows
        .filter((row) => row.trigger === 1 && row.host_input_id)
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      const exactTopLevel = triggerRows.at(-1)?.host_input_id;
      if (exactTopLevel !== inputId) throw new Error('accepted input does not match the exact host input');

      const update = db.prepare(
        `UPDATE messages_in
            SET host_accepted_input_id = ?, host_accepted_route_key = ?,
                host_accepted_at = ?, host_acceptance_ended_at = NULL
          WHERE id = ?`,
      );
      for (const row of exactRows) update.run(inputId, routeKey, acceptedAt, row.id);
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

type CorrelationRequest =
  | {
      action: 'bind';
      requestId: string;
      sessionId: string;
      inputId: string;
      routeKey: string;
      messageIds: string[];
    }
  | { action: 'release'; requestId: string; sessionId: string; inputId: string };

function readRequestNoFollow(requestPath: string): CorrelationRequest {
  const fd = fs.openSync(requestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) {
      throw new Error('GWS correlation request must be a small single-link regular file');
    }
    return JSON.parse(fs.readFileSync(fd, 'utf8')) as CorrelationRequest;
  } finally {
    fs.closeSync(fd);
  }
}

export function processGwsCorrelationRequest(
  agentGroupId: string,
  mountedSessionId: string,
  request: CorrelationRequest,
): void {
  const group = getAgentGroup(agentGroupId);
  const session = getSession(mountedSessionId);
  if (
    !group ||
    !session ||
    request.sessionId !== mountedSessionId ||
    session.agent_group_id !== group.id ||
    session.status !== 'active'
  ) {
    throw new Error('GWS correlation request does not belong to its isolated active-session mount');
  }
  const common = {
    dbPath: inboundDbPath(group.id, session.id),
    correlationPath: hostCorrelationPath(group.id, session.id),
  };
  if (request.action === 'bind') {
    bindAcceptedGwsCorrelation({
      ...common,
      sessionId: session.id,
      inputId: request.inputId,
      routeKey: request.routeKey,
      messageIds: request.messageIds,
      requestId: request.requestId,
    });
  } else {
    releaseAcceptedGwsCorrelation({ ...common, inputId: request.inputId });
  }
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
        .filter((name) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(name),
        )) {
        const requestPath = path.join(requestDir, file);
        try {
          const request = readRequestNoFollow(requestPath);
          if (!request.requestId || (request.action !== 'bind' && request.action !== 'release')) {
            throw new Error('invalid GWS correlation request');
          }
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
