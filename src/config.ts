import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'ONECLI_GATEWAY_URL',
  'AGENT_MCP_CONFIG_PATH',
  'NANOCLAW_AGENT_MCP_CONFIG',
  'YENTE_SCHEDULER_ALERT_CHANNEL_TYPE',
  'YENTE_SCHEDULER_ALERT_PLATFORM_ID',
  'YENTE_SCHEDULER_ALERT_THREAD_ID',
  'DEFAULT_AGENT_PROVIDER',
  'TZ',
]);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
// Instance-wide default for newly created groups. This is stamped into each
// new group's container.json; it is deliberately not consulted during runtime
// provider resolution, so upgrading never flips an existing group.
export const DEFAULT_AGENT_PROVIDER =
  (process.env.DEFAULT_AGENT_PROVIDER || envConfig.DEFAULT_AGENT_PROVIDER || 'claude').trim().toLowerCase() || 'claude';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const ONECLI_GATEWAY_URL = process.env.ONECLI_GATEWAY_URL || envConfig.ONECLI_GATEWAY_URL;
export const AGENT_MCP_CONFIG_PATH =
  process.env.AGENT_MCP_CONFIG_PATH ||
  process.env.NANOCLAW_AGENT_MCP_CONFIG ||
  envConfig.AGENT_MCP_CONFIG_PATH ||
  envConfig.NANOCLAW_AGENT_MCP_CONFIG;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);
export const NANOCLAW_ROOT = process.env.NANOCLAW_ROOT || '/srv/nanoclaw';
export const MANAGED_REPOS_DIR = process.env.NANOCLAW_MANAGED_REPOS_DIR || '';

export function getSchedulerAlertFallbackRoute(): {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
} {
  return {
    channelType: process.env.YENTE_SCHEDULER_ALERT_CHANNEL_TYPE || envConfig.YENTE_SCHEDULER_ALERT_CHANNEL_TYPE || null,
    platformId: process.env.YENTE_SCHEDULER_ALERT_PLATFORM_ID || envConfig.YENTE_SCHEDULER_ALERT_PLATFORM_ID || null,
    threadId: process.env.YENTE_SCHEDULER_ALERT_THREAD_ID || envConfig.YENTE_SCHEDULER_ALERT_THREAD_ID || null,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
