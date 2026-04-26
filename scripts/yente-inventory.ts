import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface InventoryOptions {
  stateRoot: string;
  configRoot: string;
  checkedAt?: string;
}

export interface InventoryWriteOptions extends InventoryOptions {
  outputJson: string;
}

export interface SourceChat {
  jid: string;
  name: string | null;
  channel: string | null;
  isGroup: boolean;
  lastMessageTime: string | null;
}

export interface SourceGroup {
  jid: string;
  name: string;
  folder: string;
  triggerPattern: string;
  containerConfig: Record<string, unknown> | null;
  requiresTrigger: boolean;
  isMain: boolean;
}

export interface SourceSender {
  senderId: string;
  senderName: string | null;
  channelType: string;
  groupFolder: string | null;
}

export interface SourceRole {
  userId: string;
  role: 'owner' | 'admin';
  agentGroupFolder: string | null;
}

export interface SourceTask {
  id: string;
  groupFolder: string;
  chatJid: string;
  prompt: string;
  script: string | null;
  scheduleType: string;
  scheduleValue: string;
  contextMode: string | null;
  nextRun: string | null;
  status: string;
  createdAt: string;
}

export interface SourceSession {
  groupFolder: string;
  sessionId: string;
}

export interface CredentialMaterial {
  path: string;
  reason: string;
  keys?: string[];
  unreadable?: boolean;
}

export interface ProviderPolicyEvidence {
  provider: string;
  officialDocsUrl: string;
  checkedAt: string;
  decision: 'preserve' | 'replace' | 'remove';
}

export interface ProviderSettingsEvidence {
  path: string;
  provider: string;
  keys: string[];
  hasModelPolicy: boolean;
  hasSecretEnv: boolean;
}

export interface RemoteControlEvidence {
  stateFile: string | null;
  liveDependency: boolean;
  usageEvidence: boolean;
}

export interface YenteInventory {
  stateRoot: string;
  configRoot: string;
  sourceStateHash: string;
  source: {
    chats: SourceChat[];
    groups: SourceGroup[];
    senders: SourceSender[];
    roles: SourceRole[];
    tasks: SourceTask[];
    targetSessions: SourceSession[];
    files: string[];
  };
  credentialMaterial: CredentialMaterial[];
  providerSettings: ProviderSettingsEvidence[];
  providerPolicyEvidence: ProviderPolicyEvidence[];
  remoteControl: RemoteControlEvidence;
}

const PROVIDER_DOCS_URL = 'https://docs.anthropic.com/en/docs/claude-code/settings';

export function buildYenteInventory(options: InventoryOptions): YenteInventory {
  const stateRoot = path.resolve(options.stateRoot);
  const configRoot = path.resolve(options.configRoot);
  const files = listFiles(stateRoot);
  const dbPath = path.join(stateRoot, 'store', 'messages.db');
  const checkedAt = options.checkedAt ?? new Date().toISOString();

  const source = {
    chats: [] as SourceChat[],
    groups: [] as SourceGroup[],
    senders: [] as SourceSender[],
    roles: [] as SourceRole[],
    tasks: [] as SourceTask[],
    targetSessions: [] as SourceSession[],
    files,
  };

  let remoteControl: RemoteControlEvidence = {
    stateFile: fs.existsSync(path.join(stateRoot, 'data', 'remote-control.json')) ? 'data/remote-control.json' : null,
    liveDependency: false,
    usageEvidence: false,
  };

  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      source.chats = readChats(db);
      source.groups = readGroups(db);
      source.tasks = readTasks(db);
      source.targetSessions = readSessions(db);
      source.senders = readSenders(db, source.chats, source.groups);
      source.roles = readRoles(db);
      remoteControl = readRemoteControlEvidence(db, stateRoot, remoteControl.stateFile);
    } finally {
      db.close();
    }
  }

  const providerSettings = readProviderSettings(stateRoot, files);
  return {
    stateRoot,
    configRoot,
    sourceStateHash: hashSourceState(stateRoot),
    source,
    credentialMaterial: classifyCredentialMaterial(stateRoot, files, providerSettings),
    providerSettings,
    providerPolicyEvidence:
      providerSettings.length > 0
        ? [
            {
              provider: 'claude-code',
              officialDocsUrl: PROVIDER_DOCS_URL,
              checkedAt,
              decision: 'preserve',
            },
          ]
        : [],
    remoteControl,
  };
}

export function writeInventory(options: InventoryWriteOptions): YenteInventory {
  const inventory = buildYenteInventory(options);
  fs.mkdirSync(path.dirname(options.outputJson), { recursive: true });
  fs.writeFileSync(options.outputJson, JSON.stringify(inventory, null, 2) + '\n');
  return inventory;
}

export function hashSourceState(stateRoot: string): string {
  const root = path.resolve(stateRoot);
  const hash = crypto.createHash('sha256');
  for (const rel of listFiles(root).filter((file) => isSourceHashFile(file))) {
    hash.update(rel);
    hash.update('\0');
    updateHashFromFile(hash, path.join(root, rel));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  updateHashFromFile(hash, file);
  return hash.digest('hex');
}

function updateHashFromFile(hash: crypto.Hash, file: string): void {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (isPermissionDenied(err)) {
      const stat = fs.statSync(file);
      hash.update('<unreadable>');
      hash.update(String(stat.size));
      hash.update('\0');
      hash.update(String(stat.mtimeMs));
      return;
    }
    throw err;
  }
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
}

function isSourceHashFile(rel: string): boolean {
  if (rel === 'data/v2.db') return false;
  if (isGeneratedMigrationFile(rel)) return false;
  if (rel.startsWith('data/v2-sessions/')) return false;
  if (/^groups\/[^/]+\/container\.json$/.test(rel)) return false;
  if (/^groups\/[^/]+\/CLAUDE\.local\.md$/.test(rel)) return false;
  return true;
}

function isGeneratedMigrationFile(rel: string): boolean {
  return (
    rel === 'preflight-migration-dry-run.json' ||
    rel === 'authoritative-migration-dry-run.json' ||
    rel === 'migration-apply-report.json' ||
    rel === 'yente-v1-staging-sanitize-report.json' ||
    rel === 'data/yente-v1-staging-baseline-report.json'
  );
}

function readChats(db: Database.Database): SourceChat[] {
  if (!hasTable(db, 'chats')) return [];
  return (
    db.prepare('SELECT jid, name, last_message_time, channel, is_group FROM chats ORDER BY jid').all() as Array<{
      jid: string;
      name: string | null;
      last_message_time: string | null;
      channel: string | null;
      is_group: number | null;
    }>
  )
    .filter((row) => !row.jid.startsWith('__'))
    .map((row) => ({
      jid: row.jid,
      name: row.name,
      channel: row.channel,
      isGroup: row.is_group === 1,
      lastMessageTime: row.last_message_time,
    }));
}

function readGroups(db: Database.Database): SourceGroup[] {
  if (!hasTable(db, 'registered_groups')) return [];
  return (
    db
      .prepare(
        `SELECT jid, name, folder, trigger_pattern, container_config, requires_trigger, is_main
         FROM registered_groups ORDER BY folder`,
      )
      .all() as Array<{
      jid: string;
      name: string;
      folder: string;
      trigger_pattern: string;
      container_config: string | null;
      requires_trigger: number | null;
      is_main: number | null;
    }>
  ).map((row) => ({
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    triggerPattern: row.trigger_pattern,
    containerConfig: parseJsonObject(row.container_config),
    requiresTrigger: row.requires_trigger !== 0,
    isMain: row.is_main === 1,
  }));
}

function readTasks(db: Database.Database): SourceTask[] {
  if (!hasTable(db, 'scheduled_tasks')) return [];
  return (
    db
      .prepare(
        `SELECT id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value,
                context_mode, next_run, status, created_at
           FROM scheduled_tasks ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      group_folder: string;
      chat_jid: string;
      prompt: string;
      script: string | null;
      schedule_type: string;
      schedule_value: string;
      context_mode: string | null;
      next_run: string | null;
      status: string;
      created_at: string;
    }>
  ).map((row) => ({
    id: row.id,
    groupFolder: row.group_folder,
    chatJid: row.chat_jid,
    prompt: row.prompt,
    script: row.script,
    scheduleType: row.schedule_type,
    scheduleValue: row.schedule_value,
    contextMode: row.context_mode,
    nextRun: row.next_run,
    status: row.status,
    createdAt: row.created_at,
  }));
}

function readSessions(db: Database.Database): SourceSession[] {
  if (!hasTable(db, 'sessions')) return [];
  return (
    db.prepare('SELECT group_folder, session_id FROM sessions ORDER BY group_folder').all() as Array<{
      group_folder: string;
      session_id: string;
    }>
  ).map((row) => ({ groupFolder: row.group_folder, sessionId: row.session_id }));
}

function readSenders(db: Database.Database, chats: SourceChat[], groups: SourceGroup[]): SourceSender[] {
  const byKey = new Map<string, SourceSender>();
  const chatChannel = new Map(chats.map((chat) => [chat.jid, inferChannel(chat.jid, chat.channel).channelType]));
  const chatGroupFolder = new Map(groups.map((group) => [group.jid, group.folder]));

  if (hasTable(db, 'messages')) {
    const rows = db
      .prepare('SELECT chat_jid, sender, sender_name FROM messages WHERE sender IS NOT NULL ORDER BY sender')
      .all() as Array<{ chat_jid: string; sender: string; sender_name: string | null }>;
    for (const row of rows) {
      const channelType = chatChannel.get(row.chat_jid) ?? inferChannel(row.chat_jid).channelType;
      addSender(byKey, {
        senderId: row.sender,
        senderName: row.sender_name,
        channelType,
        groupFolder: chatGroupFolder.get(row.chat_jid) ?? null,
      });
    }
  }

  if (hasTable(db, 'known_senders')) {
    const rows = db
      .prepare('SELECT sender_id, sender_name, channel_type, group_folder FROM known_senders')
      .all() as Array<{
      sender_id: string;
      sender_name: string | null;
      channel_type: string;
      group_folder: string;
    }>;
    for (const row of rows) {
      addSender(byKey, {
        senderId: row.sender_id,
        senderName: row.sender_name,
        channelType: row.channel_type,
        groupFolder: row.group_folder,
      });
    }
  }

  if (hasTable(db, 'admin_senders')) {
    const rows = db
      .prepare('SELECT sender_id, sender_name, channel_type, group_folder FROM admin_senders')
      .all() as Array<{
      sender_id: string;
      sender_name: string | null;
      channel_type: string;
      group_folder: string | null;
    }>;
    for (const row of rows) {
      addSender(byKey, {
        senderId: row.sender_id,
        senderName: row.sender_name,
        channelType: row.channel_type,
        groupFolder: null,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => a.senderId.localeCompare(b.senderId));
}

function addSender(byKey: Map<string, SourceSender>, sender: SourceSender): void {
  const key = `${sender.channelType}:${sender.senderId}`;
  const existing = byKey.get(key);
  byKey.set(key, {
    senderId: sender.senderId,
    senderName: sender.senderName ?? existing?.senderName ?? null,
    channelType: sender.channelType,
    groupFolder: sender.groupFolder ?? existing?.groupFolder ?? null,
  });
}

function readRoles(db: Database.Database): SourceRole[] {
  if (!hasTable(db, 'admin_senders')) return [];
  return (
    db
      .prepare('SELECT sender_id, channel_type, role, group_folder FROM admin_senders ORDER BY sender_id')
      .all() as Array<{
      sender_id: string;
      channel_type: string;
      role: string;
      group_folder: string | null;
    }>
  ).map((row) => ({
    userId: namespacedUserId(row.channel_type, row.sender_id),
    role: row.role === 'owner' ? 'owner' : 'admin',
    agentGroupFolder: row.role === 'owner' ? null : row.group_folder,
  }));
}

function readRemoteControlEvidence(
  db: Database.Database,
  stateRoot: string,
  stateFile: string | null,
): RemoteControlEvidence {
  let usageEvidence = stateFile !== null;
  let liveDependency = false;

  if (stateFile) {
    const parsed = parseJsonObject(fs.readFileSync(path.join(stateRoot, stateFile), 'utf8'));
    liveDependency = parsed?.status === 'active' || parsed?.status === 'running';
  }

  if (hasTable(db, 'messages')) {
    const row = db.prepare("SELECT 1 FROM messages WHERE content LIKE '%/remote-control%' LIMIT 1").get();
    usageEvidence = usageEvidence || row !== undefined;
  }
  if (hasTable(db, 'router_state')) {
    const row = db
      .prepare("SELECT 1 FROM router_state WHERE key LIKE '%remote-control%' OR value LIKE '%remote-control%' LIMIT 1")
      .get();
    usageEvidence = usageEvidence || row !== undefined;
  }

  return { stateFile, liveDependency, usageEvidence };
}

function readProviderSettings(stateRoot: string, files: string[]): ProviderSettingsEvidence[] {
  const settings: ProviderSettingsEvidence[] = [];
  for (const rel of files) {
    if (!/data\/sessions\/[^/]+\/\.claude\/settings\.json$/.test(rel)) continue;
    const parsed = parseJsonObject(fs.readFileSync(path.join(stateRoot, rel), 'utf8'));
    if (!parsed) continue;
    const keys = Object.keys(parsed).sort();
    const env = parseRecord(parsed.env);
    settings.push({
      path: rel,
      provider: 'claude-code',
      keys,
      hasModelPolicy: Object.prototype.hasOwnProperty.call(parsed, 'model'),
      hasSecretEnv: Object.keys(env).some(isSecretKey),
    });
  }
  return settings;
}

function classifyCredentialMaterial(
  stateRoot: string,
  files: string[],
  providerSettings: ProviderSettingsEvidence[],
): CredentialMaterial[] {
  const credentials: CredentialMaterial[] = [];
  const providerSettingsByPath = new Map(providerSettings.map((item) => [item.path, item]));

  for (const rel of files) {
    if (rel === '.env' || rel === 'data/env') {
      const file = path.join(stateRoot, rel);
      credentials.push({
        path: rel,
        reason: 'environment file',
        keys: readEnvKeys(file),
        ...(isEnvFileUnreadable(file) ? { unreadable: true } : {}),
      });
      continue;
    }
    if (rel.startsWith('store/auth/') || rel.includes('/baileys/') || rel.includes('whatsapp')) {
      credentials.push({ path: rel, reason: 'channel auth state' });
      continue;
    }
    if (rel.includes('/browser-auth/')) {
      credentials.push({ path: rel, reason: 'browser auth state' });
      continue;
    }
    if (rel.includes('/.claude/') && /credential|token|auth/i.test(path.basename(rel))) {
      credentials.push({ path: rel, reason: 'provider credential cache' });
      continue;
    }
    const providerSetting = providerSettingsByPath.get(rel);
    if (providerSetting?.hasSecretEnv) {
      credentials.push({ path: rel, reason: 'provider settings with secret env keys' });
    }
  }

  return credentials.sort((a, b) => a.path.localeCompare(b.path));
}

function readEnvKeys(file: string): string[] {
  const raw = readTextIfReadable(file);
  if (raw === null) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.slice(0, line.indexOf('=')).trim())
    .filter(isSecretKey)
    .sort();
}

function isEnvFileUnreadable(file: string): boolean {
  return readTextIfReadable(file) === null;
}

function readTextIfReadable(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (isPermissionDenied(err)) return null;
    throw err;
  }
}

function isPermissionDenied(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code !== undefined &&
    ['EACCES', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '')
  );
}

export function inferChannel(jid: string, channelHint?: string | null): { channelType: string; platformId: string } {
  if (channelHint) return { channelType: channelHint, platformId: stripPlatformPrefix(jid, channelHint) };
  if (jid.startsWith('dc:')) return { channelType: 'discord', platformId: jid.slice(3) };
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us')) return { channelType: 'whatsapp', platformId: jid };
  if (jid.startsWith('cli:')) return { channelType: 'cli', platformId: jid };
  return { channelType: 'unknown', platformId: jid };
}

function stripPlatformPrefix(jid: string, channelType: string): string {
  if (channelType === 'discord' && jid.startsWith('dc:')) return jid.slice(3);
  return jid;
}

export function namespacedUserId(channelType: string, senderId: string): string {
  if (channelType === 'whatsapp') return `whatsapp:${senderId}`;
  if (channelType === 'discord') return `discord:${senderId}`;
  if (channelType === 'cli') return `cli:${senderId}`;
  return `${channelType}:${senderId}`;
}

function hasTable(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined;
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }

  walk(root);
  return files.sort();
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseRecord(parsed);
  } catch {
    return null;
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function isSecretKey(key: string): boolean {
  return /TOKEN|SECRET|KEY|PASSWORD|AUTH/i.test(key);
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

function requireString(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing required --${key}`);
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  writeInventory({
    stateRoot: requireString(args, 'state-root'),
    configRoot: requireString(args, 'config-root'),
    outputJson: requireString(args, 'output-json'),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
