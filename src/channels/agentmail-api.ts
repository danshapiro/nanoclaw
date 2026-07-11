import { HttpsProxyAgent } from 'https-proxy-agent';
import { AgentMailClient, AgentMailEnvironment, type AgentMail } from 'agentmail';
import WebSocket from 'ws';

import { log } from '../log.js';
import type { AgentMailMessageLike } from './agentmail-config.js';

export const AGENTMAIL_ONECLI_PLACEHOLDER = 'onecli-managed';
const AGENTMAIL_WEBSOCKET_PATH = '/v0';
const AGENTMAIL_WEBSOCKET_MIN_RECONNECT_MS = 1000;
const AGENTMAIL_WEBSOCKET_MAX_RECONNECT_MS = 10000;
const AGENTMAIL_WEBSOCKET_RETRY_WARN_EVERY = 30;
const AGENTMAIL_WEBSOCKET_PING_INTERVAL_MS = 30000;
const AGENTMAIL_WEBSOCKET_IDLE_MULTIPLIER = 2;

export type AgentMailSocketLike = {
  on(event: 'open', handler: () => void): void;
  on(event: 'message', handler: (event: unknown) => void | Promise<void>): void;
  on(event: 'close', handler: (event: { code?: number; reason?: string }) => void): void;
  on(event: 'error', handler: (error: unknown) => void): void;
  sendSubscribe(payload: { type: 'subscribe'; inboxIds: string[]; eventTypes: AgentMail.EventType[] }): void;
  waitForOpen?(): Promise<unknown>;
  close(): void;
};

export type AgentMailApi = {
  connectWebSocket(): Promise<AgentMailSocketLike>;
  listMessages(
    inboxId: string,
    options: {
      limit: number;
      labels?: string[];
      pageToken?: string;
      includeUnauthenticated?: boolean;
    },
  ): Promise<{ messages: AgentMailMessageLike[]; nextPageToken?: string }>;
  getMessage(inboxId: string, messageId: string): Promise<AgentMailMessageLike>;
  updateLabels(inboxId: string, messageId: string, labels: { add: string[]; remove: string[] }): Promise<void>;
  replyToMessage(
    inboxId: string,
    messageId: string,
    payload: {
      text: string;
      html?: string;
      attachments?: AgentMailSendAttachment[];
      labels?: string[];
      headers?: Record<string, string>;
    },
  ): Promise<{ messageId?: string; message_id?: string }>;
  downloadAttachment(args: {
    inboxId: string;
    messageId: string;
    attachmentId: string;
    maxBytes: number;
  }): Promise<AgentMailDownloadedAttachment>;
};

export type AgentMailSendAttachment = {
  filename: string;
  content: string;
  contentType?: string;
};

export type AgentMailDownloadedAttachment = {
  attachmentId: string;
  filename: string;
  contentType: string | null;
  data: Buffer;
};

export type AgentMailApiAuthOptions = { mode: 'onecli' } | { mode: 'api-key'; apiKey: string };

type WebSocketOptions = { headers?: Record<string, string>; agent?: unknown };
type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: WebSocketOptions,
) => WebSocketConnectionLike;

type WebSocketCloseEventLike = { code?: unknown; reason?: unknown };

type WebSocketConnectionLike = {
  readyState: number;
  on(event: 'open', handler: () => void): void;
  on(event: 'message', handler: (data: unknown) => void): void;
  on(event: 'close', handler: (codeOrEvent?: number | WebSocketCloseEventLike, reason?: Buffer | string) => void): void;
  on(event: 'error', handler: (error: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping?(): void;
  terminate?(): void;
};

export type AgentMailOneCliWebSocketOptions = {
  env?: NodeJS.ProcessEnv;
  url?: string;
  websocketCtor?: WebSocketConstructor;
  proxyAgentFactory?: (proxyUrl: string) => unknown;
};

export function agentMailClientOptions(options: AgentMailApiAuthOptions): AgentMailClient.Options {
  if (options.mode === 'api-key') {
    return { apiKey: options.apiKey };
  }
  return {
    authProvider: {
      async getAuthRequest() {
        return { headers: { Authorization: `Bearer ${AGENTMAIL_ONECLI_PLACEHOLDER}` } };
      },
    },
  } as AgentMailClient.Options;
}

export function createAgentMailApi(options: AgentMailApiAuthOptions): AgentMailApi {
  const client = new AgentMailClient(agentMailClientOptions(options));

  return {
    connectWebSocket:
      options.mode === 'onecli' ? () => createAgentMailOneCliWebSocket() : () => client.websockets.connect(),
    async listMessages(inboxId, options) {
      const response = await client.inboxes.messages.list(inboxId, {
        limit: options.limit,
        ...(options.labels ? { labels: options.labels } : {}),
        ...(options.pageToken ? { pageToken: options.pageToken } : {}),
        ...(options.includeUnauthenticated ? { includeUnauthenticated: true } : {}),
      });
      return normalizeMessageList(response);
    },
    async getMessage(inboxId, messageId) {
      return normalizeMessage(await client.inboxes.messages.get(inboxId, messageId));
    },
    async updateLabels(inboxId, messageId, labels) {
      await client.inboxes.messages.update(inboxId, messageId, {
        addLabels: labels.add,
        removeLabels: labels.remove,
      });
    },
    async replyToMessage(inboxId, messageId, payload) {
      const response = await client.inboxes.messages.reply(inboxId, messageId, {
        text: payload.text,
        ...(payload.html ? { html: payload.html } : {}),
        ...(payload.attachments ? { attachments: payload.attachments } : {}),
        ...(payload.labels ? { labels: payload.labels } : {}),
        ...(payload.headers ? { headers: payload.headers } : {}),
      });
      return response as { messageId?: string; message_id?: string };
    },
    async downloadAttachment(args) {
      const meta = normalizeAttachmentMetadata(
        await client.inboxes.messages.getAttachment(args.inboxId, args.messageId, args.attachmentId),
        args.attachmentId,
      );
      const response = await fetch(meta.downloadUrl);
      if (!response.ok) throw new Error(`AgentMail attachment download failed: HTTP ${response.status}`);
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > args.maxBytes) throw new Error(`AgentMail attachment exceeds ${args.maxBytes} bytes`);
      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength > args.maxBytes) throw new Error(`AgentMail attachment exceeds ${args.maxBytes} bytes`);
      return {
        attachmentId: args.attachmentId,
        filename: meta.filename ?? args.attachmentId,
        contentType: meta.contentType ?? response.headers.get('content-type'),
        data,
      };
    },
  };
}

export async function createAgentMailOneCliWebSocket(
  options: AgentMailOneCliWebSocketOptions = {},
): Promise<AgentMailSocketLike> {
  return new OneCliAgentMailSocket(options);
}

class OneCliAgentMailSocket implements AgentMailSocketLike {
  private readonly handlers: {
    open?: () => void;
    message?: (event: unknown) => void | Promise<void>;
    close?: (event: { code?: number; reason?: string }) => void;
    error?: (error: unknown) => void;
  } = {};
  private readonly url: string;
  private readonly websocketCtor: WebSocketConstructor;
  private readonly proxyAgentFactory: (proxyUrl: string) => unknown;
  private readonly proxyUrl: string;
  private ws: WebSocketConnectionLike | null = null;
  private closeRequested = false;
  private retryCount = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private lastActivityAt = 0;
  private readonly pingIntervalMs: number;
  private openWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  constructor(options: AgentMailOneCliWebSocketOptions) {
    const env = options.env ?? process.env;
    this.proxyUrl = agentMailProxyUrl(env);
    this.pingIntervalMs = agentMailPingIntervalMs(env);
    this.url = options.url ?? `${AgentMailEnvironment.Prod.websockets}${AGENTMAIL_WEBSOCKET_PATH}`;
    this.websocketCtor = options.websocketCtor ?? (WebSocket as unknown as WebSocketConstructor);
    this.proxyAgentFactory = options.proxyAgentFactory ?? ((proxyUrl) => new HttpsProxyAgent(proxyUrl));
    this.connect();
  }

  on(event: 'open', handler: () => void): void;
  on(event: 'message', handler: (event: unknown) => void | Promise<void>): void;
  on(event: 'close', handler: (event: { code?: number; reason?: string }) => void): void;
  on(event: 'error', handler: (error: unknown) => void): void;
  on(event: 'open' | 'message' | 'close' | 'error', handler: unknown): void {
    this.handlers[event] = handler as never;
  }

  sendSubscribe(payload: { type: 'subscribe'; inboxIds: string[]; eventTypes: AgentMail.EventType[] }): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Socket is not open.');
    this.ws.send(JSON.stringify(payload));
  }

  waitForOpen(): Promise<unknown> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    return new Promise((resolve, reject) => {
      this.openWaiters.push({ resolve: () => resolve(this.ws), reject });
    });
  }

  close(): void {
    this.closeRequested = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopKeepalive();
    for (const waiter of this.openWaiters.splice(0)) waiter.reject(new Error('AgentMail WebSocket closed'));
    this.ws?.close(1000, 'closed');
    this.ws = null;
  }

  private connect(): void {
    if (this.closeRequested) return;
    const ws = new this.websocketCtor(this.url, [], {
      headers: { Authorization: `Bearer ${AGENTMAIL_ONECLI_PLACEHOLDER}` },
      agent: this.proxyAgentFactory(this.proxyUrl),
    });
    this.ws = ws;
    ws.on('open', () => {
      this.retryCount = 0;
      this.lastActivityAt = Date.now();
      this.startKeepalive(ws);
      for (const waiter of this.openWaiters.splice(0)) waiter.resolve();
      this.handlers.open?.();
    });
    if (typeof ws.ping === 'function') {
      (ws as unknown as { on(event: string, handler: () => void): void }).on('pong', () => {
        this.lastActivityAt = Date.now();
      });
    }
    ws.on('message', (data) => {
      this.lastActivityAt = Date.now();
      const parsed = parseAgentMailWebSocketMessage(data);
      if (parsed.ok) {
        void this.handlers.message?.(parsed.value);
      } else {
        this.handlers.error?.(parsed.error);
      }
    });
    ws.on('error', (error) => {
      this.handlers.error?.(error);
      for (const waiter of this.openWaiters.splice(0)) waiter.reject(error);
    });
    ws.on('close', (codeOrEvent, reason) => {
      if (this.ws === ws) this.stopKeepalive();
      this.handlers.close?.(normalizeCloseEvent(codeOrEvent, reason));
      if (!this.closeRequested) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.retryCount += 1;
    const delay = Math.min(
      AGENTMAIL_WEBSOCKET_MAX_RECONNECT_MS,
      AGENTMAIL_WEBSOCKET_MIN_RECONNECT_MS * 2 ** Math.min(this.retryCount - 1, 30),
    );
    if (this.retryCount % AGENTMAIL_WEBSOCKET_RETRY_WARN_EVERY === 0) {
      log.warn('AgentMail WebSocket reconnect still failing', { consecutiveFailures: this.retryCount });
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startKeepalive(ws: WebSocketConnectionLike): void {
    this.stopKeepalive();
    if (this.pingIntervalMs <= 0) return;
    this.keepaliveTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs >= this.pingIntervalMs * AGENTMAIL_WEBSOCKET_IDLE_MULTIPLIER) {
        this.stopKeepalive();
        // Idle force-reconnect is self-healing by design (the close handler
        // schedules the reconnect) — log at WARN, not through the error
        // handler, which channels genuine socket errors to ERROR logs.
        log.warn('AgentMail WebSocket idle; forcing reconnect', {
          idleMs,
          pingIntervalMs: this.pingIntervalMs,
        });
        if (typeof ws.terminate === 'function') ws.terminate();
        else ws.close();
        return;
      }
      if (typeof ws.ping === 'function') ws.ping();
    }, this.pingIntervalMs);
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }
}

function agentMailProxyUrl(env: NodeJS.ProcessEnv): string {
  const proxy = env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || env.HTTP_PROXY?.trim() || env.http_proxy?.trim();
  if (!proxy) throw new Error('AgentMail WebSocket requires OneCLI proxy env');
  return proxy;
}

function parseAgentMailWebSocketMessage(data: unknown): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    return { ok: true, value: JSON.parse(text) };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Invalid WebSocket frames are expected protocol errors.
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function reasonToString(reason: unknown): string | undefined {
  if (Buffer.isBuffer(reason)) {
    const text = reason.toString('utf8');
    return text.length > 0 ? text : undefined;
  }
  if (typeof reason === 'string') return reason.length > 0 ? reason : undefined;
  return undefined;
}

function normalizeCloseEvent(
  codeOrEvent: number | WebSocketCloseEventLike | undefined,
  reason: Buffer | string | undefined,
): { code?: number; reason?: string } {
  if (codeOrEvent && typeof codeOrEvent === 'object') {
    return {
      code: typeof codeOrEvent.code === 'number' ? codeOrEvent.code : undefined,
      reason: reasonToString(codeOrEvent.reason),
    };
  }
  return { code: typeof codeOrEvent === 'number' ? codeOrEvent : undefined, reason: reasonToString(reason) };
}

function agentMailPingIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.AGENTMAIL_WS_PING_INTERVAL_MS?.trim();
  if (!raw) return AGENTMAIL_WEBSOCKET_PING_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : AGENTMAIL_WEBSOCKET_PING_INTERVAL_MS;
}

export function normalizeMessageEvent(event: unknown): AgentMailMessageLike | null {
  if (!event || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;
  if (record.type !== 'event') return null;
  const eventType = stringValue(record.eventType) ?? stringValue(record.event_type);
  if (!eventType?.startsWith('message.received')) return null;
  const message = record.message;
  if (!message || typeof message !== 'object') return null;
  return normalizeMessage(message, stringValue(record.eventId) ?? stringValue(record.event_id) ?? null);
}

function normalizeMessage(message: unknown, eventId: string | null = null): AgentMailMessageLike {
  if (!message || typeof message !== 'object') throw new Error('AgentMail message payload was missing');
  const msg = message as Record<string, unknown>;
  const inboxId = stringValue(msg.inboxId) ?? stringValue(msg.inbox_id);
  const messageId = stringValue(msg.messageId) ?? stringValue(msg.message_id);
  if (!inboxId || !messageId) throw new Error('AgentMail message payload was missing inboxId/messageId');
  return {
    ...(msg as AgentMailMessageLike),
    eventId,
    inboxId,
    messageId,
    threadId: stringValue(msg.threadId) ?? stringValue(msg.thread_id) ?? null,
    from: stringValue(msg.from) ?? stringValue(msg.from_),
    subject: stringValue(msg.subject),
    text: stringValue(msg.text),
    html: stringValue(msg.html),
    timestamp: stringValue(msg.timestamp),
    createdAt: stringValue(msg.createdAt) ?? stringValue(msg.created_at),
    extractedText: stringValue(msg.extractedText) ?? stringValue(msg.extracted_text),
    extractedHtml: stringValue(msg.extractedHtml) ?? stringValue(msg.extracted_html),
  } as AgentMailMessageLike;
}

export function isAgentMailQuotaOrRateLimitError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const status = Number(record.statusCode ?? record.status_code ?? record.status);
  const message = error instanceof Error ? error.message : String(error);
  return (
    status === 402 || status === 403 || status === 429 || /\b(quota|rate limit|too many requests)\b/i.test(message)
  );
}

function normalizeMessageList(response: unknown): { messages: AgentMailMessageLike[]; nextPageToken?: string } {
  if (Array.isArray(response)) return { messages: response.map((message) => normalizeMessage(message)) };
  if (!response || typeof response !== 'object') return { messages: [] };
  const record = response as Record<string, unknown>;
  const messages = Array.isArray(record.messages)
    ? record.messages.map((message) => normalizeMessage(message))
    : Array.isArray(record.data)
      ? record.data.map((message) => normalizeMessage(message))
      : [];
  return { messages, nextPageToken: stringValue(record.nextPageToken) ?? stringValue(record.next_page_token) };
}

function normalizeAttachmentMetadata(
  response: unknown,
  attachmentId: string,
): { filename?: string; contentType?: string; downloadUrl: string } {
  if (!response || typeof response !== 'object') {
    throw new Error(`AgentMail attachment ${attachmentId} metadata missing`);
  }
  const record = response as Record<string, unknown>;
  const downloadUrl = stringValue(record.downloadUrl) ?? stringValue(record.download_url);
  if (!downloadUrl) throw new Error(`AgentMail attachment ${attachmentId} missing downloadUrl`);
  return {
    filename: stringValue(record.filename) ?? stringValue(record.name),
    contentType: stringValue(record.contentType) ?? stringValue(record.content_type),
    downloadUrl,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
