import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR, TIMEZONE } from './config.js';
import { RegisteredGroup } from './types.js';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const LONG_CONTEXT_WINDOW_TOKENS = 1_000_000;
const SERVICE_PROBE_TIMEOUT_MS = 2_000;

interface TranscriptSnapshot {
  model: string | null;
  usedTokens: number | null;
  lastUpdated: string | null;
  totalTokens: number;
}

interface ServiceStatus {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface StatusReportOptions {
  chatName: string;
  group: RegisteredGroup;
  sessionId?: string;
  isDiscordConnected: boolean;
  processUptimeMs?: number;
  dataDir?: string;
  storeDir?: string;
  timezone?: string;
}

export async function buildStatusReport(
  opts: StatusReportOptions,
): Promise<string> {
  const uptimeMs = opts.processUptimeMs ?? process.uptime() * 1000;
  const dataDir = opts.dataDir ?? DATA_DIR;
  const storeDir = opts.storeDir ?? STORE_DIR;
  const timezone = opts.timezone ?? TIMEZONE;

  const transcript = loadTranscriptSnapshot(
    dataDir,
    opts.group.folder,
    opts.sessionId,
  );
  const services = await probeServices({
    dataDir,
    groupFolder: opts.group.folder,
    isDiscordConnected: opts.isDiscordConnected,
    storeDir,
  });

  const okCount = services.filter((service) => service.ok).length;
  const failures = services.filter((service) => !service.ok);

  const lines = [
    'Yente status',
    '',
    'Runtime',
    `• Uptime: ${formatDuration(uptimeMs)}`,
    `• Channel: ${opts.chatName}`,
    `• Session: ${opts.sessionId ?? 'none'}`,
    '',
    'Model',
    `• Current model: ${transcript.model ?? 'unavailable'}`,
    `• Tokens: ${formatUsedTokens(transcript.usedTokens, transcript.totalTokens)}`,
    `• Last updated: ${formatTimestamp(transcript.lastUpdated, timezone)}`,
    '',
    'Capabilities',
    `• ${okCount} services OK`,
  ];

  for (const failure of failures) {
    lines.push(`• ${failure.label}: ${failure.detail ?? 'unavailable'}`);
  }

  return lines.join('\n');
}

function loadTranscriptSnapshot(
  dataDir: string,
  groupFolder: string,
  sessionId?: string,
): TranscriptSnapshot {
  const totalTokens = resolveContextWindowTokens();
  if (!sessionId) {
    return {
      model: null,
      usedTokens: null,
      lastUpdated: null,
      totalTokens,
    };
  }

  const transcriptPath = findTranscriptPath(dataDir, groupFolder, sessionId);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return {
      model: null,
      usedTokens: null,
      lastUpdated: null,
      totalTokens,
    };
  }

  const lines = fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;

    try {
      const record = JSON.parse(line) as {
        timestamp?: string;
        message?: {
          model?: string;
          usage?: {
            input_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
            output_tokens?: number;
          };
        };
      };

      const usage = record.message?.usage;
      if (!usage) continue;

      return {
        model: record.message?.model ?? null,
        usedTokens:
          safeNumber(usage.input_tokens) +
          safeNumber(usage.cache_creation_input_tokens) +
          safeNumber(usage.cache_read_input_tokens) +
          safeNumber(usage.output_tokens),
        lastUpdated: record.timestamp ?? null,
        totalTokens,
      };
    } catch {
      continue;
    }
  }

  return {
    model: null,
    usedTokens: null,
    lastUpdated: null,
    totalTokens,
  };
}

function safeNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function findTranscriptPath(
  dataDir: string,
  groupFolder: string,
  sessionId: string,
): string | null {
  const projectsDir = path.join(
    dataDir,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );

  if (!fs.existsSync(projectsDir)) return null;

  const targetName = `${sessionId}.jsonl`;
  const stack = [projectsDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === targetName) {
        return entryPath;
      }
    }
  }

  return null;
}

function resolveContextWindowTokens(): number {
  const betaFlags = [
    process.env.ANTHROPIC_BETA,
    process.env.CLAUDE_CODE_BETA,
    process.env.ANTHROPIC_API_BETA,
  ]
    .filter(Boolean)
    .join(',');

  if (/\bcontext-1m\b/i.test(betaFlags)) {
    return LONG_CONTEXT_WINDOW_TOKENS;
  }

  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

async function probeServices(opts: {
  storeDir: string;
  dataDir: string;
  groupFolder: string;
  isDiscordConnected: boolean;
}): Promise<ServiceStatus[]> {
  const skillsDir = path.join(
    opts.dataDir,
    'sessions',
    opts.groupFolder,
    '.claude',
    'skills',
  );

  const services: ServiceStatus[] = [
    {
      label: 'Discord gateway',
      ok: opts.isDiscordConnected,
      detail: opts.isDiscordConnected ? undefined : 'gateway disconnected',
    },
    {
      label: 'Message store',
      ok: fs.existsSync(path.join(opts.storeDir, 'messages.db')),
      detail: 'store/messages.db is missing',
    },
    {
      label: 'Session data',
      ok: fs.existsSync(path.join(opts.dataDir, 'sessions', opts.groupFolder)),
      detail: `sessions/${opts.groupFolder} is missing`,
    },
    {
      label: 'Skills bundle',
      ok:
        fs.existsSync(skillsDir) &&
        fs
          .readdirSync(skillsDir, { withFileTypes: true })
          .some((entry) => entry.isDirectory()),
      detail: 'no synced skills were found for this group',
    },
  ];

  const externalServices: Array<[string, string]> = [];
  if (process.env.GWS_PROXY_URL) {
    externalServices.push(['GWS proxy', process.env.GWS_PROXY_URL]);
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (!value || !key.endsWith('_API_URL')) continue;
    externalServices.push([formatEnvServiceLabel(key), value]);
  }

  const seenLabels = new Set<string>();
  for (const [label, url] of externalServices) {
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    services.push(await probeHttpService(label, url));
  }

  return services;
}

async function probeHttpService(
  label: string,
  rawUrl: string,
): Promise<ServiceStatus> {
  const candidates = buildProbeCandidates(rawUrl);

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        signal: AbortSignal.timeout(SERVICE_PROBE_TIMEOUT_MS),
      });
      if (response.ok) {
        return { label, ok: true };
      }
      if (response.status === 404) {
        continue;
      }
      return {
        label,
        ok: false,
        detail: `HTTP ${response.status} from ${candidate}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        label,
        ok: false,
        detail: `${message} (${candidate})`,
      };
    }
  }

  return {
    label,
    ok: false,
    detail: `no healthy endpoint found at ${rawUrl}`,
  };
}

function buildProbeCandidates(rawUrl: string): string[] {
  const trimmed = rawUrl.replace(/\/+$/, '');
  if (!trimmed) return [];
  if (/\/health$/i.test(trimmed)) return [trimmed];
  return [`${trimmed}/health`, trimmed];
}

function formatEnvServiceLabel(key: string): string {
  return (
    key
      .replace(/_API_URL$/, '')
      .toLowerCase()
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') + ' API'
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function formatUsedTokens(
  usedTokens: number | null,
  totalTokens: number,
): string {
  if (usedTokens === null) {
    return `unavailable / ${formatNumber(totalTokens)}`;
  }

  const percent = (Math.round((usedTokens / totalTokens) * 1000) / 10).toFixed(
    1,
  );
  return `${formatNumber(usedTokens)} / ${formatNumber(totalTokens)} (${percent}%)`;
}

function formatTimestamp(timestamp: string | null, timezone: string): string {
  if (!timestamp) return 'unavailable';

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'unavailable';

  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}
