import { AgentMailClient, type AgentMail } from 'agentmail';

import type { AgentMailMessageLike } from './agentmail-config.js';

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

export function createAgentMailApi(apiKey: string): AgentMailApi {
  const client = new AgentMailClient({ apiKey });

  return {
    connectWebSocket: () => client.websockets.connect(),
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
