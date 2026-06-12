import fs from 'fs';

export const AGENTMAIL_CHANNEL_TYPE = 'agentmail';
export const DEFAULT_AGENTMAIL_ROUTES_PATH = '/srv/nanoclaw/agentmail-routes.json';
export const DEFAULT_AGENTMAIL_CATCHUP_PAGE_LIMIT = 25;
export const DEFAULT_AGENTMAIL_CATCHUP_MAX_PAGES = 4;
export const DEFAULT_AGENTMAIL_ROUTE_LEASE_MS = 5 * 60 * 1000;
export const DEFAULT_AGENTMAIL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_AGENTMAIL_CATCHUP_INTERVAL_MS = 5 * 60 * 1000;
export type AgentMailEventType = 'message.received' | 'message.received.unauthenticated';
export const DEFAULT_AGENTMAIL_EVENT_TYPES = [
  'message.received',
  'message.received.unauthenticated',
] as const satisfies AgentMailEventType[];
const ALLOWED_AGENTMAIL_EVENT_TYPES = new Set<AgentMailEventType>([
  'message.received',
  'message.received.unauthenticated',
]);

export type AgentMailRouteFile = {
  version: 1;
  domainEnv: 'AGENTMAIL_DOMAIN';
  maxRoutes: 3;
  routes: AgentMailRouteConfig[];
};

export type AgentMailRouteConfig = {
  localPart: string;
  name: string;
  agentGroupFolder: string;
  purpose: 'general' | 'qa-internal' | 'aidy-internal';
  sessionMode: 'per-thread';
};

export type AgentMailResolvedRoute = AgentMailRouteConfig & {
  inboxId: string;
  messagingGroupId: string;
};

export type AgentMailMessageLike = {
  inboxId: string;
  messageId: string;
  eventId?: string | null;
  threadId?: string | null;
  from?: string | null;
  from_?: string | null;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  extractedText?: string | null;
  extracted_text?: string | null;
  extractedHtml?: string | null;
  extracted_html?: string | null;
  attachments?: unknown[];
  labels?: string[];
  headers?: Record<string, string | string[] | undefined>;
  timestamp?: string | null;
  createdAt?: string | null;
  receivedAt?: string | null;
};

export type AgentMailInboundContent = {
  text: string;
  html?: string;
  extractedText?: string;
  sender: string;
  senderId: string;
  senderName: string;
  inboxId: string;
  inboxLocalPart: string;
  messageId: string;
  threadId: string | null;
  subject: string;
  to: unknown;
  cc: unknown;
  bcc: unknown;
  labels: string[];
  attachments: unknown[];
  agentmail: {
    routePurpose: AgentMailRouteConfig['purpose'];
    provider: 'agentmail';
    inboxId: string;
    messageId: string;
    threadId: string | null;
    eventId: string | null;
  };
};

export function defaultAgentMailRouteFile(): AgentMailRouteFile {
  return {
    version: 1,
    domainEnv: 'AGENTMAIL_DOMAIN',
    maxRoutes: 3,
    routes: [
      {
        localPart: 'yente',
        name: 'AgentMail yente',
        agentGroupFolder: 'main',
        purpose: 'general',
        sessionMode: 'per-thread',
      },
      {
        localPart: 'yente-threads',
        name: 'AgentMail yente-threads',
        agentGroupFolder: 'main',
        purpose: 'qa-internal',
        sessionMode: 'per-thread',
      },
      {
        localPart: 'yente-aidy',
        name: 'AgentMail yente-aidy',
        agentGroupFolder: 'main',
        purpose: 'aidy-internal',
        sessionMode: 'per-thread',
      },
    ],
  };
}

export function readAgentMailRouteFile(path: string): AgentMailRouteFile {
  return JSON.parse(fs.readFileSync(path, 'utf8')) as AgentMailRouteFile;
}

export function resolveAgentMailRoutes(file: AgentMailRouteFile, env: NodeJS.ProcessEnv): AgentMailResolvedRoute[] {
  if (file.version !== 1) throw new Error(`Unsupported AgentMail route file version: ${String(file.version)}`);
  if (file.maxRoutes !== 3) throw new Error('AgentMail route file must set maxRoutes to 3');
  if (file.routes.length !== 3) throw new Error('Expected exactly three AgentMail routes for the free-tier inbox set');

  const domain = env[file.domainEnv]?.trim();
  if (!domain) throw new Error(`${file.domainEnv} is required when AgentMail is enabled`);
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) throw new Error(`${file.domainEnv} must be a DNS domain`);

  const localParts = new Set<string>();
  return file.routes.map((route) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(route.localPart)) {
      throw new Error(`Invalid AgentMail inbox local part: ${route.localPart}`);
    }
    if (localParts.has(route.localPart)) throw new Error(`Duplicate AgentMail inbox local part: ${route.localPart}`);
    localParts.add(route.localPart);
    if (route.agentGroupFolder !== 'main') {
      throw new Error(`AgentMail route ${route.localPart} must target main in the initial Yente deployment`);
    }
    return {
      ...route,
      inboxId: `${route.localPart}@${domain}`,
      messagingGroupId: `mg-agentmail-${route.localPart}`,
    };
  });
}

export function catchupPageLimitFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.AGENTMAIL_CATCHUP_PAGE_LIMIT?.trim();
  if (!raw) return DEFAULT_AGENTMAIL_CATCHUP_PAGE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('AGENTMAIL_CATCHUP_PAGE_LIMIT must be an integer from 1 through 100');
  }
  return parsed;
}

export function catchupMaxPagesFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.AGENTMAIL_CATCHUP_MAX_PAGES?.trim();
  if (!raw) return DEFAULT_AGENTMAIL_CATCHUP_MAX_PAGES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('AGENTMAIL_CATCHUP_MAX_PAGES must be an integer from 1 through 20');
  }
  return parsed;
}

export function agentMailEventTypesFromEnv(env: NodeJS.ProcessEnv): AgentMailEventType[] {
  const raw = env.AGENTMAIL_EVENT_TYPES?.trim();
  const values = raw
    ? raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [...DEFAULT_AGENTMAIL_EVENT_TYPES];
  return values.map((value) => {
    if (!ALLOWED_AGENTMAIL_EVENT_TYPES.has(value as AgentMailEventType)) {
      throw new Error(`Unsupported AGENTMAIL_EVENT_TYPES value: ${value}`);
    }
    return value as AgentMailEventType;
  });
}

export function nanoThreadIdForAgentMailMessage(route: AgentMailResolvedRoute, message: AgentMailMessageLike): string {
  const sourceThread = (message.threadId || message.messageId).trim();
  return `agentmail:${route.localPart}:${sourceThread}`;
}

export function senderEmailForAgentMailMessage(message: AgentMailMessageLike): string {
  const raw = (message.from ?? message.from_ ?? 'unknown@agentmail.local').trim();
  const match = raw.match(/<([^<>@\s]+@[^<>\s]+)>/);
  return (match?.[1] ?? raw).trim().toLowerCase();
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function firstText(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

export function buildAgentMailInboundContent(
  route: Pick<AgentMailResolvedRoute, 'localPart' | 'inboxId' | 'purpose'>,
  message: AgentMailMessageLike,
): AgentMailInboundContent {
  const sender = senderEmailForAgentMailMessage(message);
  const html = firstText(message.extractedHtml, message.extracted_html, message.html);
  const text =
    (firstText(message.extractedText, message.extracted_text, message.text) ?? (html ? htmlToPlainText(html) : '')) ||
    '(empty email body)';

  return {
    text,
    ...(html ? { html } : {}),
    ...(message.extractedText || message.extracted_text
      ? { extractedText: (message.extractedText ?? message.extracted_text)!.trim() }
      : {}),
    sender,
    senderId: `agentmail:${sender.toLowerCase()}`,
    senderName: sender,
    inboxId: route.inboxId,
    inboxLocalPart: route.localPart,
    messageId: message.messageId,
    threadId: message.threadId ?? null,
    subject: message.subject ?? '',
    to: message.to ?? [],
    cc: message.cc ?? [],
    bcc: message.bcc ?? [],
    labels: message.labels ?? [],
    attachments: message.attachments ?? [],
    agentmail: {
      routePurpose: route.purpose,
      provider: 'agentmail',
      inboxId: route.inboxId,
      messageId: message.messageId,
      threadId: message.threadId ?? null,
      eventId: message.eventId ?? null,
    },
  };
}
