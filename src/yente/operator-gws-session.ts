import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assertHostGwsSideEffectsReconciled,
  readGwsReconciliationRecords,
  discoverGwsCrashWindowDrafts,
  ensureSchema,
  importHostSideEffects,
  insertMessage,
  openInboundDb,
  openOutboundDb,
  type ImportSideEffectsResult,
} from '../db/session-db.js';
import { bindAcceptedGwsCorrelation, releaseAcceptedGwsCorrelation } from '../gws-correlation-ipc.js';

const CANONICAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface OperatorGwsSession {
  schemaVersion: 1;
  root: string;
  operatorId: string;
  sessionId: string;
  agentGroupId: string;
  groupFolder: string;
  leaseId: string;
  inputId: string;
  routeKey: string;
  acceptedAt: string;
  messageId: string;
  inboundDbPath: string;
  outboundDbPath: string;
  ledgerPath: string;
  correlationDir: string;
  correlationPath: string;
  activeLeasePath: string;
  reconciliationReceiptPath: string;
}

export interface StartOperatorGwsSessionOptions {
  root: string;
  agentGroupId: string;
  groupFolder: string;
  operatorId?: string;
  containerUid: number;
  containerGid: number;
  acceptedAt?: string;
  leaseId?: string;
}

function canonicalId(value: string, name: string): string {
  if (!CANONICAL_ID_RE.test(value)) throw new Error(`${name} must be a canonical identifier`);
  return value;
}

function canonicalTimestamp(value: string, name: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(millis).toISOString();
}

function writeJsonAtomic(filePath: string, value: unknown, mode = 0o600): void {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { flag: 'wx', mode });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function unlinkIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Create a durable, host-authorized correlation interval for an interactive
 * operator container. This deliberately uses the same accepted-row binding
 * and side-effect importer as ordinary NanoClaw turns, but owns independent
 * files so releasing the source turn cannot revoke the operator.
 */
export function startOperatorGwsSession(opts: StartOperatorGwsSessionOptions): OperatorGwsSession {
  const root = path.resolve(opts.root);
  const operatorId = canonicalId(opts.operatorId ?? `operator-${randomUUID()}`, 'operatorId');
  const agentGroupId = canonicalId(opts.agentGroupId, 'agentGroupId');
  const groupFolder = canonicalId(opts.groupFolder, 'groupFolder');
  const leaseId = canonicalId(opts.leaseId ?? `lease-${randomUUID()}`, 'leaseId');
  const acceptedAt = canonicalTimestamp(opts.acceptedAt ?? new Date().toISOString(), 'acceptedAt');
  if (!Number.isSafeInteger(opts.containerUid) || opts.containerUid < 0) throw new Error('containerUid is invalid');
  if (!Number.isSafeInteger(opts.containerGid) || opts.containerGid < 0) throw new Error('containerGid is invalid');

  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
  fs.mkdirSync(root, { mode: 0o700 });
  const correlationDir = path.join(root, '.host-correlation');
  fs.mkdirSync(correlationDir, { mode: 0o700 });

  const session: OperatorGwsSession = {
    schemaVersion: 1,
    root,
    operatorId,
    sessionId: operatorId,
    agentGroupId,
    groupFolder,
    leaseId,
    inputId: `operator:${operatorId}`,
    routeKey: `operator|${agentGroupId}|${operatorId}`,
    acceptedAt,
    messageId: `operator-message-${operatorId}`,
    inboundDbPath: path.join(root, 'inbound.db'),
    outboundDbPath: path.join(root, 'outbound.db'),
    ledgerPath: path.join(root, 'side-effects.jsonl'),
    correlationDir,
    correlationPath: path.join(correlationDir, 'current.json'),
    activeLeasePath: path.join(correlationDir, 'active-lease.json'),
    reconciliationReceiptPath: path.join(root, 'reconciliation.json'),
  };

  ensureSchema(session.inboundDbPath, 'inbound');
  ensureSchema(session.outboundDbPath, 'outbound');
  const inbound = openInboundDb(session.inboundDbPath);
  try {
    insertMessage(inbound, {
      id: session.messageId,
      kind: 'operator',
      timestamp: acceptedAt,
      platformId: null,
      channelType: 'operator',
      threadId: operatorId,
      content: 'Interactive operator session',
      processAfter: null,
      recurrence: null,
      messagingGroupId: null,
      isGroup: 0,
      hostInputId: session.inputId,
      hostRouteKey: session.routeKey,
      hostReceivedAt: acceptedAt,
    });
  } finally {
    inbound.close();
  }

  fs.writeFileSync(session.ledgerPath, '', { flag: 'wx', mode: 0o600 });
  writeJsonAtomic(session.activeLeasePath, {
    schemaVersion: 1,
    agentGroupId,
    sessionId: session.sessionId,
    leaseId,
    issuedAt: acceptedAt,
  });
  bindAcceptedGwsCorrelation({
    dbPath: session.inboundDbPath,
    correlationPath: session.correlationPath,
    sessionId: session.sessionId,
    inputId: session.inputId,
    routeKey: session.routeKey,
    messageIds: [session.messageId],
    acceptedAt,
    leaseId,
    sequence: 1,
  });
  writeJsonAtomic(path.join(root, 'operator-session.json'), session);

  // The operator container must write its ledger/outbound DB and traverse the
  // correlation directory. Docker mounts keep host authority files read-only.
  for (const ownedPath of [
    root,
    correlationDir,
    session.inboundDbPath,
    session.outboundDbPath,
    session.ledgerPath,
    session.correlationPath,
    session.activeLeasePath,
  ]) {
    fs.chownSync(ownedPath, opts.containerUid, opts.containerGid);
  }
  fs.chmodSync(root, 0o700);
  fs.chmodSync(correlationDir, 0o700);

  return session;
}

export function finalizeOperatorGwsSession(opts: {
  operator: OperatorGwsSession;
  containerStopped: boolean;
  auditStorePath: string | undefined;
  reconciliationStorePath: string | undefined;
  gwsPublicKey?: string;
  stoppedAt?: string;
}): ImportSideEffectsResult {
  if (opts.containerStopped !== true) {
    throw new Error('operator GWS session cannot be finalized until the container is confirmed stopped');
  }
  const stoppedAt = canonicalTimestamp(opts.stoppedAt ?? new Date().toISOString(), 'stoppedAt');
  const strictGwsScope = {
    inputId: opts.operator.inputId,
    routeKey: opts.operator.routeKey,
    notBefore: opts.operator.acceptedAt,
    notAfter: stoppedAt,
  };
  const result = importHostSideEffects({
    sessionDir: opts.operator.root,
    containerStopped: true,
    gwsPublicKey: opts.gwsPublicKey,
    requireCompleteLedger: true,
    strictGwsScope,
  });
  // R8: the operator flow has exactly one scope, so it keeps its fail-closed
  // posture: a quarantined record for THIS scope's input aborts finalization.
  // An incident with unreadable input_id makes readGwsReconciliationRecords
  // throw at file level, so this path never matches null against its scope.
  const scopes = [strictGwsScope];
  const { quarantined } = readGwsReconciliationRecords({
    reconciliationStorePath: opts.reconciliationStorePath,
    scopes,
  });
  const blocked = quarantined.filter((q) => scopes.some((s) => s.inputId === q.inputId));
  if (blocked.length > 0) {
    throw new Error(`GWS reconciliation record quarantined for this operator scope: ${blocked[0].reason}`);
  }
  const auditResult = discoverGwsCrashWindowDrafts({
    sessionDir: opts.operator.root,
    containerStopped: true,
    auditStorePath: opts.auditStorePath,
    inputId: opts.operator.inputId,
    routeKey: opts.operator.routeKey,
    notBefore: opts.operator.acceptedAt,
    notAfter: stoppedAt,
    gwsPublicKey: opts.gwsPublicKey,
    requireAuditAccess: true,
    requireCompleteAudit: true,
    failOnUnresolved: true,
  });

  // Both the container ledger and root audit have now flowed through Task 3's
  // single verifier/import path. Re-verify every GWS-shaped stored row from its
  // immutable signed bytes and duplicated bindings. The operator mounts this
  // DB writable, so validation_json and all container-written columns are
  // untrusted until this host-only check succeeds.
  const outDb = openOutboundDb(opts.operator.outboundDbPath);
  try {
    assertHostGwsSideEffectsReconciled(outDb, { ...strictGwsScope, gwsPublicKey: opts.gwsPublicKey });
  } finally {
    outDb.close();
  }

  // Import and exact audit discovery first. If access, parsing, verification,
  // or persistence fails, the durable evidence and active correlation remain
  // intact for a later reconciliation attempt.
  releaseAcceptedGwsCorrelation({
    dbPath: opts.operator.inboundDbPath,
    correlationPath: opts.operator.correlationPath,
    inputId: opts.operator.inputId,
    endedAt: stoppedAt,
  });
  unlinkIfPresent(opts.operator.activeLeasePath);
  writeJsonAtomic(opts.operator.reconciliationReceiptPath, {
    schemaVersion: 1,
    operatorId: opts.operator.operatorId,
    leaseId: opts.operator.leaseId,
    stoppedAt,
    importResult: result,
    auditDiscoveryResult: auditResult,
  });
  return result;
}
