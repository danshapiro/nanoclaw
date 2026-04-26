import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { runMigrations } from '../src/db/migrations/index.js';
import { ensureSchema } from '../src/db/session-db.js';
import { insertTask } from '../src/modules/scheduling/db.js';
import {
  buildYenteInventory,
  hashSourceState,
  inferChannel,
  namespacedUserId,
  sha256File,
  type ProviderPolicyEvidence,
  type RemoteControlEvidence,
  type SourceGroup,
  type SourceTask,
  type YenteInventory,
} from './yente-inventory.js';

export const MIGRATION_VERSION = 'yente-v1-to-v2@1';

export interface MigrationOptions {
  stateRoot: string;
  configRoot: string;
  assistantName: string;
  target?: 'staging' | 'prod';
  stagingChannelMapPath?: string;
  checkedAt?: string;
}

export interface ApplyOptions extends MigrationOptions {
  dryRunReportPath?: string;
  reportPath: string;
  allowContinuationLoss?: boolean;
  confirmProd?: boolean;
}

export interface ContinuationDecision {
  groupFolder: string;
  oldSessionId: string;
  newSessionId: string;
  claudeStateCopied: boolean;
  requiresOperatorApproval: boolean;
}

export interface MessagingGroupMapping {
  oldJid: string;
  channelType: string;
  sourcePlatformId: string;
  sourceThreadId: string | null;
  targetPlatformId: string | null;
  targetThreadId: string | null;
  stagingQuarantined: boolean;
}

export interface SessionMapping {
  groupFolder: string;
  oldJid: string;
  agentGroupId: string;
  messagingGroupId: string;
  sessionId: string;
}

export interface TaskMapping {
  oldTaskId: string;
  groupFolder: string;
  sessionId: string;
  agentGroupId: string;
  targetPlatformId: string | null;
  channelType: string | null;
  processAfter: string | null;
  recurrence: string | null;
  stagingQuarantined: boolean;
  activeDueAfterApply: boolean;
}

export interface YenteMigrationReport {
  migrationVersion: string;
  target: 'staging' | 'prod';
  stateRoot: string;
  configRoot: string;
  sourceStateHash: string;
  v1DbHash: string | null;
  stagingChannelMapHash: string | null;
  assistantName: string;
  inventory: YenteInventory;
  providerPolicyEvidence: ProviderPolicyEvidence[];
  remoteControl: RemoteControlEvidence;
  continuations: ContinuationDecision[];
  messagingGroupMappings: MessagingGroupMapping[];
  sessionMappings: SessionMapping[];
  taskMappings: TaskMapping[];
  applied?: boolean;
}

interface StagingChannelMap {
  channels?: Array<{
    from: { channelType: string; platformId: string; threadId?: string | null };
    to: { platformId: string; threadId?: string | null };
  }>;
}

export function createMigrationDryRun(options: MigrationOptions): YenteMigrationReport {
  const target = options.target ?? 'prod';
  const stateRoot = path.resolve(options.stateRoot);
  const configRoot = path.resolve(options.configRoot);
  const inventory = buildYenteInventory({
    stateRoot,
    configRoot,
    checkedAt: options.checkedAt,
  });
  const stagingMap =
    target === 'staging' && options.stagingChannelMapPath ? readStagingMap(options.stagingChannelMapPath) : null;
  const stagingChannelMapHash =
    target === 'staging' && options.stagingChannelMapPath ? sha256File(options.stagingChannelMapPath) : null;
  const messagingGroupMappings = inventory.source.groups.map((group) =>
    mapMessagingGroup(group, inventory, target, stagingMap),
  );
  const continuations = inventory.source.targetSessions.map((session) => {
    const agentGroupId = agentGroupIdForFolder(session.groupFolder);
    const newSessionId = sessionIdFor(session.groupFolder, session.sessionId);
    const oldClaudeDir = path.join(stateRoot, 'data', 'sessions', session.groupFolder, '.claude');
    const transcriptExists = findTranscript(oldClaudeDir, session.sessionId) !== null;
    return {
      groupFolder: session.groupFolder,
      oldSessionId: session.sessionId,
      newSessionId,
      claudeStateCopied: fs.existsSync(oldClaudeDir) && transcriptExists,
      requiresOperatorApproval: !transcriptExists,
    };
  });
  const sessionMappings = inventory.source.groups.map((group) => {
    const continuation = continuations.find((c) => c.groupFolder === group.folder);
    const mapped = messagingGroupMappings.find((m) => m.oldJid === group.jid);
    return {
      groupFolder: group.folder,
      oldJid: group.jid,
      agentGroupId: agentGroupIdForFolder(group.folder),
      messagingGroupId: messagingGroupIdFor(group.jid),
      sessionId: continuation?.newSessionId ?? sessionIdFor(group.folder, group.jid),
    };
  });
  const taskMappings = inventory.source.tasks.map((task) =>
    mapTask(task, messagingGroupMappings, sessionMappings, target),
  );

  return {
    migrationVersion: MIGRATION_VERSION,
    target,
    stateRoot,
    configRoot,
    sourceStateHash: hashSourceState(stateRoot),
    v1DbHash: fs.existsSync(v1DbPath(stateRoot)) ? sha256File(v1DbPath(stateRoot)) : null,
    stagingChannelMapHash,
    assistantName: options.assistantName,
    inventory,
    providerPolicyEvidence: inventory.providerPolicyEvidence,
    remoteControl: inventory.remoteControl,
    continuations,
    messagingGroupMappings,
    sessionMappings,
    taskMappings,
  };
}

export function writeMigrationReport(report: YenteMigrationReport, reportPath: string): YenteMigrationReport {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}

export function applyYenteMigration(options: ApplyOptions): YenteMigrationReport {
  const target = options.target ?? 'prod';
  if (!options.dryRunReportPath) throw new Error('--dry-run-report is required for --apply');
  if (!fs.existsSync(options.dryRunReportPath))
    throw new Error(`Dry-run report not found: ${options.dryRunReportPath}`);
  if (target === 'prod' && !options.confirmProd) throw new Error('--confirm-prod is required for production apply');
  if (target === 'staging' && !options.stagingChannelMapPath)
    throw new Error('--staging-channel-map is required for staging apply');

  const report = JSON.parse(fs.readFileSync(options.dryRunReportPath, 'utf8')) as YenteMigrationReport;
  const current = createMigrationDryRun({
    stateRoot: options.stateRoot,
    configRoot: options.configRoot,
    assistantName: options.assistantName,
    target,
    stagingChannelMapPath: options.stagingChannelMapPath,
    checkedAt: report.providerPolicyEvidence[0]?.checkedAt,
  });

  validateApplyReport(report, current, options);
  applyReport(report, options);
  const applied: YenteMigrationReport = { ...report, applied: true };
  writeMigrationReport(applied, options.reportPath);
  return applied;
}

function validateApplyReport(report: YenteMigrationReport, current: YenteMigrationReport, options: ApplyOptions): void {
  if (report.migrationVersion !== MIGRATION_VERSION) throw new Error('dry-run report migration version does not match');
  if (report.target !== current.target) throw new Error('dry-run report target does not match apply target');
  if (report.sourceStateHash !== current.sourceStateHash)
    throw new Error('source state hash does not match dry-run report');
  if (report.v1DbHash !== current.v1DbHash) throw new Error('v1 DB hash does not match dry-run report');
  if (report.stagingChannelMapHash !== current.stagingChannelMapHash) {
    throw new Error('staging channel map hash does not match dry-run report');
  }
  if (report.providerPolicyEvidence.length === 0) throw new Error('provider policy evidence is required');
  if (report.providerPolicyEvidence.some((entry) => !entry.officialDocsUrl || !entry.checkedAt || !entry.decision)) {
    throw new Error('provider policy evidence is incomplete');
  }
  if (report.continuations.some((entry) => entry.requiresOperatorApproval) && !options.allowContinuationLoss) {
    throw new Error('--allow-continuation-loss is required for unmigrated continuations');
  }
  if (report.remoteControl.liveDependency) {
    throw new Error('legacy remote-control live dependency detected; implement v2 replacement before apply');
  }

  const marker = readMigrationMarker(path.join(report.stateRoot, 'data', 'v2.db'));
  if (marker && marker.sourceStateHash !== report.sourceStateHash) {
    throw new Error('data/v2.db has a migration marker for a different source state');
  }
}

function applyReport(report: YenteMigrationReport, options: ApplyOptions): void {
  const dataDir = path.join(report.stateRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const centralDbPath = path.join(dataDir, 'v2.db');
  const central = new Database(centralDbPath);
  central.pragma('journal_mode = WAL');
  central.pragma('foreign_keys = ON');
  runMigrations(central);
  ensureMigrationMarker(central, report);

  const groupsByFolder = new Map(report.inventory.source.groups.map((group) => [group.folder, group]));
  const messagingByJid = new Map(report.messagingGroupMappings.map((mapping) => [mapping.oldJid, mapping]));
  const sessionsByFolder = new Map(report.sessionMappings.map((mapping) => [mapping.groupFolder, mapping]));

  central.transaction(() => {
    for (const group of report.inventory.source.groups) insertAgentGroup(central, group);
    for (const mapping of report.messagingGroupMappings) insertMessagingGroup(central, mapping, report.inventory);
    for (const mapping of report.sessionMappings) {
      insertMessagingGroupAgent(central, mapping, groupsByFolder.get(mapping.groupFolder)!);
      insertAgentDestination(central, mapping);
    }
    insertUsersAndRoles(central, report);
    for (const mapping of report.sessionMappings) insertSession(central, mapping);
  })();
  central.close();

  for (const group of report.inventory.source.groups) {
    initGroupFilesystem(report.stateRoot, group);
  }

  for (const continuation of report.continuations) {
    const mapping = sessionsByFolder.get(continuation.groupFolder);
    if (!mapping) continue;
    copyClaudeState(report.stateRoot, continuation.groupFolder, mapping.agentGroupId);
    initSessionDbs(report.stateRoot, mapping.agentGroupId, continuation.newSessionId);
    if (!continuation.requiresOperatorApproval) {
      writeContinuation(report.stateRoot, mapping.agentGroupId, continuation.newSessionId, continuation.oldSessionId);
    }
  }

  for (const task of report.inventory.source.tasks) {
    if (task.status !== 'active') continue;
    const mapping = sessionsByFolder.get(task.groupFolder);
    const channelMapping = messagingByJid.get(task.chatJid);
    if (!mapping || !channelMapping) continue;
    initSessionDbs(report.stateRoot, mapping.agentGroupId, mapping.sessionId);
    const inbound = new Database(inboundDbPath(report.stateRoot, mapping.agentGroupId, mapping.sessionId));
    try {
      if (inbound.prepare('SELECT 1 FROM messages_in WHERE id = ?').get(task.id)) continue;
      const taskMapping = report.taskMappings.find((entry) => entry.oldTaskId === task.id);
      const quarantined = taskMapping?.stagingQuarantined ?? false;
      insertTask(inbound, {
        id: task.id,
        processAfter: quarantined ? '9999-12-31T00:00:00.000Z' : (task.nextRun ?? new Date().toISOString()),
        recurrence: task.scheduleType === 'once' ? null : task.scheduleValue,
        platformId: quarantined ? null : channelMapping.targetPlatformId,
        channelType: quarantined ? null : channelMapping.channelType,
        threadId: quarantined ? null : channelMapping.targetThreadId,
        content: JSON.stringify({
          prompt: task.prompt,
          script: task.script,
          sourceTaskId: task.id,
          stagingQuarantined: quarantined,
        }),
      });
    } finally {
      inbound.close();
    }
  }
}

function insertAgentGroup(db: Database.Database, group: SourceGroup): void {
  db.prepare(
    `INSERT OR REPLACE INTO agent_groups (id, name, folder, agent_provider, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    agentGroupIdForFolder(group.folder),
    group.name,
    group.folder,
    'claude',
    group.isMain ? groupCreatedAt() : groupCreatedAt(),
  );
}

function insertMessagingGroup(db: Database.Database, mapping: MessagingGroupMapping, inventory: YenteInventory): void {
  const chat = inventory.source.chats.find((entry) => entry.jid === mapping.oldJid);
  db.prepare(
    `INSERT OR REPLACE INTO messaging_groups
       (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messagingGroupIdFor(mapping.oldJid),
    mapping.channelType,
    mapping.targetPlatformId ?? `quarantined:${mapping.sourcePlatformId}`,
    chat?.name ?? mapping.oldJid,
    chat?.isGroup ? 1 : 0,
    mapping.stagingQuarantined ? 'strict' : 'request_approval',
    groupCreatedAt(),
  );
}

function insertMessagingGroupAgent(db: Database.Database, mapping: SessionMapping, group: SourceGroup): void {
  db.prepare(
    `INSERT OR REPLACE INTO messaging_group_agents
       (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope,
        ignored_message_policy, session_mode, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `mga-${shortHash(`${mapping.messagingGroupId}|${mapping.agentGroupId}`)}`,
    mapping.messagingGroupId,
    mapping.agentGroupId,
    'pattern',
    group.requiresTrigger ? group.triggerPattern : '.',
    'known',
    'drop',
    'shared',
    group.isMain ? 100 : 0,
    groupCreatedAt(),
  );
}

function insertAgentDestination(db: Database.Database, mapping: SessionMapping): void {
  if (!hasTable(db, 'agent_destinations')) return;

  const existingTarget = db
    .prepare(
      `SELECT 1 AS present
         FROM agent_destinations
        WHERE agent_group_id = ? AND target_type = 'channel' AND target_id = ?
        LIMIT 1`,
    )
    .get(mapping.agentGroupId, mapping.messagingGroupId);
  if (existingTarget) return;

  const messagingGroup = db
    .prepare('SELECT channel_type, name FROM messaging_groups WHERE id = ?')
    .get(mapping.messagingGroupId) as { channel_type: string; name: string | null } | undefined;
  if (!messagingGroup) return;

  const base = slug(messagingGroup.name || `${messagingGroup.channel_type}-${mapping.messagingGroupId.slice(0, 8)}`);
  let localName = base;
  let suffix = 2;
  while (
    db
      .prepare('SELECT 1 AS present FROM agent_destinations WHERE agent_group_id = ? AND local_name = ? LIMIT 1')
      .get(mapping.agentGroupId, localName)
  ) {
    localName = `${base}-${suffix}`;
    suffix += 1;
  }

  db.prepare(
    `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
     VALUES (?, ?, 'channel', ?, ?)`,
  ).run(mapping.agentGroupId, localName, mapping.messagingGroupId, groupCreatedAt());
}

function insertUsersAndRoles(db: Database.Database, report: YenteMigrationReport): void {
  for (const sender of report.inventory.source.senders) {
    const userId = namespacedUserId(sender.channelType, sender.senderId);
    db.prepare('INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)').run(
      userId,
      sender.channelType,
      sender.senderName,
      groupCreatedAt(),
    );
  }
  for (const role of report.inventory.source.roles) {
    db.prepare(
      `INSERT OR REPLACE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      role.userId,
      role.role,
      role.agentGroupFolder ? agentGroupIdForFolder(role.agentGroupFolder) : null,
      null,
      groupCreatedAt(),
    );
  }
  for (const sender of report.inventory.source.senders.filter((entry) => entry.groupFolder)) {
    const agentGroupId = agentGroupIdForFolder(sender.groupFolder!);
    db.prepare(
      `INSERT OR REPLACE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES (?, ?, ?, ?)`,
    ).run(namespacedUserId(sender.channelType, sender.senderId), agentGroupId, null, groupCreatedAt());
  }
}

function insertSession(db: Database.Database, mapping: SessionMapping): void {
  db.prepare(
    `INSERT OR REPLACE INTO sessions
       (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mapping.sessionId,
    mapping.agentGroupId,
    mapping.messagingGroupId,
    null,
    'claude',
    'active',
    'stopped',
    null,
    groupCreatedAt(),
  );
}

function mapMessagingGroup(
  group: SourceGroup,
  inventory: YenteInventory,
  target: 'staging' | 'prod',
  stagingMap: StagingChannelMap | null,
): MessagingGroupMapping {
  const chat = inventory.source.chats.find((entry) => entry.jid === group.jid);
  const inferred = inferChannel(group.jid, chat?.channel);
  const sourceThreadId: string | null = null;
  const mapped =
    target === 'staging'
      ? findStagingMapping(stagingMap, inferred.channelType, inferred.platformId, sourceThreadId)
      : null;
  return {
    oldJid: group.jid,
    channelType: inferred.channelType,
    sourcePlatformId: inferred.platformId,
    sourceThreadId,
    targetPlatformId: target === 'staging' ? (mapped?.platformId ?? null) : inferred.platformId,
    targetThreadId: target === 'staging' ? (mapped?.threadId ?? null) : sourceThreadId,
    stagingQuarantined: target === 'staging' && !mapped,
  };
}

function mapTask(
  task: SourceTask,
  messagingMappings: MessagingGroupMapping[],
  sessionMappings: SessionMapping[],
  target: 'staging' | 'prod',
): TaskMapping {
  const channel = messagingMappings.find((mapping) => mapping.oldJid === task.chatJid);
  const session = sessionMappings.find((mapping) => mapping.groupFolder === task.groupFolder);
  const quarantined = target === 'staging' && (!channel || channel.stagingQuarantined);
  return {
    oldTaskId: task.id,
    groupFolder: task.groupFolder,
    sessionId: session?.sessionId ?? sessionIdFor(task.groupFolder, task.id),
    agentGroupId: session?.agentGroupId ?? agentGroupIdForFolder(task.groupFolder),
    targetPlatformId: quarantined ? null : (channel?.targetPlatformId ?? null),
    channelType: quarantined ? null : (channel?.channelType ?? null),
    processAfter: task.nextRun,
    recurrence: task.scheduleType === 'once' ? null : task.scheduleValue,
    stagingQuarantined: quarantined,
    activeDueAfterApply: !quarantined && task.status === 'active',
  };
}

function findStagingMapping(
  map: StagingChannelMap | null,
  channelType: string,
  platformId: string,
  threadId: string | null,
): { platformId: string; threadId: string | null } | null {
  const found = map?.channels?.find(
    (entry) =>
      entry.from.channelType === channelType &&
      entry.from.platformId === platformId &&
      (entry.from.threadId ?? null) === threadId,
  );
  if (!found) return null;
  return { platformId: found.to.platformId, threadId: found.to.threadId ?? null };
}

function readStagingMap(file: string): StagingChannelMap {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as StagingChannelMap;
}

function initGroupFilesystem(stateRoot: string, group: SourceGroup): void {
  const groupDir = path.join(stateRoot, 'groups', group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const containerPath = path.join(groupDir, 'container.json');
  if (!fs.existsSync(containerPath)) {
    fs.writeFileSync(containerPath, JSON.stringify(group.containerConfig ?? {}, null, 2) + '\n');
  }
}

function copyClaudeState(stateRoot: string, groupFolder: string, agentGroupId: string): void {
  const src = path.join(stateRoot, 'data', 'sessions', groupFolder, '.claude');
  const dst = path.join(stateRoot, 'data', 'v2-sessions', agentGroupId, '.claude-shared');
  fs.mkdirSync(dst, { recursive: true });
  if (!fs.existsSync(src)) {
    writeDefaultSettings(dst);
    return;
  }

  copyDirSanitized(src, dst);
  writeDefaultSettings(dst);
}

function copyDirSanitized(src: string, dst: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (isCredentialFile(entry.name)) continue;
    if (entry.isDirectory()) {
      if (entry.name === 'skills') continue;
      fs.mkdirSync(dstPath, { recursive: true });
      copyDirSanitized(srcPath, dstPath);
    } else if (entry.isFile()) {
      if (entry.name === 'settings.json') {
        fs.writeFileSync(dstPath, sanitizeSettings(fs.readFileSync(srcPath, 'utf8')));
      } else {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}

function writeDefaultSettings(claudeDir: string): void {
  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({ env: {} }, null, 2) + '\n');
  }
}

function sanitizeSettings(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const env =
    parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
      ? { ...(parsed.env as Record<string, unknown>) }
      : {};
  for (const key of Object.keys(env)) {
    if (/TOKEN|SECRET|KEY|PASSWORD|AUTH/i.test(key)) delete env[key];
  }
  parsed.env = env;
  return JSON.stringify(parsed, null, 2) + '\n';
}

function isCredentialFile(name: string): boolean {
  return /credential|token|auth/i.test(name) && name !== 'settings.json';
}

function initSessionDbs(stateRoot: string, agentGroupId: string, sessionId: string): void {
  fs.mkdirSync(sessionDir(stateRoot, agentGroupId, sessionId), { recursive: true });
  ensureSchema(inboundDbPath(stateRoot, agentGroupId, sessionId), 'inbound');
  ensureSchema(outboundDbPath(stateRoot, agentGroupId, sessionId), 'outbound');
}

function writeContinuation(stateRoot: string, agentGroupId: string, sessionId: string, continuation: string): void {
  const db = new Database(outboundDbPath(stateRoot, agentGroupId, sessionId));
  try {
    db.prepare(
      `INSERT OR REPLACE INTO session_state (key, value, updated_at)
       VALUES ('continuation:claude', ?, ?)`,
    ).run(continuation, new Date().toISOString());
  } finally {
    db.close();
  }
}

function ensureMigrationMarker(db: Database.Database, report: YenteMigrationReport): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS yente_migration_marker (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      migration_version TEXT NOT NULL,
      source_state_hash TEXT NOT NULL,
      target TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT OR REPLACE INTO yente_migration_marker
       (id, migration_version, source_state_hash, target, applied_at)
     VALUES (1, ?, ?, ?, ?)`,
  ).run(report.migrationVersion, report.sourceStateHash, report.target, new Date().toISOString());
}

function readMigrationMarker(dbPath: string): { sourceStateHash: string } | null {
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'yente_migration_marker'")
      .get();
    if (!table) return null;
    const row = db.prepare('SELECT source_state_hash FROM yente_migration_marker WHERE id = 1').get() as
      | { source_state_hash: string }
      | undefined;
    return row ? { sourceStateHash: row.source_state_hash } : null;
  } finally {
    db.close();
  }
}

function findTranscript(claudeDir: string, sessionId: string): string | null {
  if (!fs.existsSync(claudeDir)) return null;
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  walk(claudeDir);
  return files.find((file) => path.basename(file) === `${sessionId}.jsonl`) ?? null;
}

function agentGroupIdForFolder(folder: string): string {
  return `ag-${slug(folder)}`;
}

function messagingGroupIdFor(jid: string): string {
  return `mg-${shortHash(jid)}`;
}

function sessionIdFor(folder: string, seed: string): string {
  return `sess-${shortHash(`${folder}|${seed}`)}`;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'group'
  );
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function v1DbPath(stateRoot: string): string {
  return path.join(stateRoot, 'store', 'messages.db');
}

function sessionDir(stateRoot: string, agentGroupId: string, sessionId: string): string {
  return path.join(stateRoot, 'data', 'v2-sessions', agentGroupId, sessionId);
}

function inboundDbPath(stateRoot: string, agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(stateRoot, agentGroupId, sessionId), 'inbound.db');
}

function outboundDbPath(stateRoot: string, agentGroupId: string, sessionId: string): string {
  return path.join(sessionDir(stateRoot, agentGroupId, sessionId), 'outbound.db');
}

function groupCreatedAt(): string {
  return '2026-04-26T00:00:00.000Z';
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function stringArg(args: Record<string, string | boolean>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function requireString(args: Record<string, string | boolean>, key: string): string {
  const value = stringArg(args, key);
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = (stringArg(args, 'target') as 'staging' | 'prod' | undefined) ?? 'prod';
  if (args['dry-run']) {
    const report = createMigrationDryRun({
      stateRoot: requireString(args, 'state-root'),
      configRoot: requireString(args, 'config-root'),
      assistantName: requireString(args, 'assistant-name'),
      target,
      stagingChannelMapPath: stringArg(args, 'staging-channel-map'),
    });
    writeMigrationReport(report, requireString(args, 'report'));
    return;
  }
  if (args['apply']) {
    applyYenteMigration({
      stateRoot: requireString(args, 'state-root'),
      configRoot: requireString(args, 'config-root'),
      assistantName: requireString(args, 'assistant-name'),
      target,
      stagingChannelMapPath: stringArg(args, 'staging-channel-map'),
      dryRunReportPath: stringArg(args, 'dry-run-report'),
      reportPath: requireString(args, 'report'),
      allowContinuationLoss: args['allow-continuation-loss'] === true,
      confirmProd: args['confirm-prod'] === true,
    });
    return;
  }
  throw new Error('Specify --dry-run or --apply');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
