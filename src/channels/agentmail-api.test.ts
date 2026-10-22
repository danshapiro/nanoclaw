import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const agentMailTestState = vi.hoisted(() => ({ getAttachment: vi.fn() }));
vi.mock('agentmail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentmail')>();
  return {
    ...actual,
    AgentMailClient: class {
      inboxes = { messages: { getAttachment: agentMailTestState.getAttachment } };
    },
  };
});

import { log } from '../log.js';
import {
  AGENTMAIL_ONECLI_PLACEHOLDER,
  createAgentMailApi,
  createAgentMailOneCliWebSocket,
  downloadAgentMailAttachmentResponse,
} from './agentmail-api.js';

type FakeWebSocketEvent = 'open' | 'message' | 'close' | 'error' | 'pong';
type FakeWebSocketStoredHandler = (...args: unknown[]) => void;
type FakeWebSocketHandler =
  | (() => void)
  | ((data: unknown) => void)
  | ((code?: number, reason?: Buffer | string) => void)
  | ((error: unknown) => void);

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  handlers: Record<FakeWebSocketEvent, FakeWebSocketStoredHandler[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
    pong: [],
  };

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: { headers?: Record<string, string>; agent?: unknown },
  ) {
    FakeWebSocket.instances.push(this);
  }

  on(event: 'open', handler: () => void): void;
  on(event: 'message', handler: (data: unknown) => void): void;
  on(event: 'close', handler: (code?: number, reason?: Buffer | string) => void): void;
  on(event: 'error', handler: (error: unknown) => void): void;
  on(event: FakeWebSocketEvent, handler: FakeWebSocketHandler): void {
    this.handlers[event].push(handler as FakeWebSocketStoredHandler);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close', 1000, Buffer.from('closed'));
  }

  emit(event: FakeWebSocketEvent, ...args: unknown[]): void {
    if (event === 'open') this.readyState = 1;
    if (event === 'close') this.readyState = 3;
    for (const handler of this.handlers[event] ?? []) handler(...args);
  }
}

class PingFakeWebSocket extends FakeWebSocket {
  pings = 0;
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.emit('close', 1006, Buffer.from(''));
  }
}

const ONECLI_ENV = { HTTPS_PROXY: 'http://agent-token@onecli-gateway.local:10255' };

describe('AgentMail API WebSocket boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it('opens the OneCLI WebSocket through the configured proxy with placeholder auth', async () => {
    FakeWebSocket.instances = [];
    const proxyAgentFactory = vi.fn((proxyUrl: string) => ({ proxyUrl }));

    const socket = await createAgentMailOneCliWebSocket({
      env: { HTTPS_PROXY: 'http://agent-token@onecli-gateway.local:10255' },
      url: 'wss://ws.agentmail.test/v0',
      websocketCtor: FakeWebSocket,
      proxyAgentFactory,
    });

    const instance = FakeWebSocket.instances[0]!;
    expect(instance.url).toBe('wss://ws.agentmail.test/v0');
    expect(instance.protocols).toEqual([]);
    expect(instance.options).toEqual({
      headers: { Authorization: `Bearer ${AGENTMAIL_ONECLI_PLACEHOLDER}` },
      agent: { proxyUrl: 'http://agent-token@onecli-gateway.local:10255' },
    });
    expect(proxyAgentFactory).toHaveBeenCalledWith('http://agent-token@onecli-gateway.local:10255');

    const opened = socket.waitForOpen?.();
    instance.emit('open');
    await opened;

    socket.sendSubscribe({
      type: 'subscribe',
      inboxIds: ['yente@agentmail.to'],
      eventTypes: ['message.received'],
    });
    expect(instance.sent).toEqual([
      JSON.stringify({
        type: 'subscribe',
        inboxIds: ['yente@agentmail.to'],
        eventTypes: ['message.received'],
      }),
    ]);
  });

  it('parses WebSocket messages before handing them to the channel adapter', async () => {
    FakeWebSocket.instances = [];
    const socket = await createAgentMailOneCliWebSocket({
      env: { HTTPS_PROXY: 'http://agent-token@onecli-gateway.local:10255' },
      url: 'wss://ws.agentmail.test/v0',
      websocketCtor: FakeWebSocket,
      proxyAgentFactory: (proxyUrl) => ({ proxyUrl }),
    });
    const onMessage = vi.fn();
    const onError = vi.fn();
    socket.on('message', onMessage);
    socket.on('error', onError);

    FakeWebSocket.instances[0]!.emit('message', Buffer.from('{"type":"subscribed","inboxIds":["yente@agentmail.to"]}'));
    FakeWebSocket.instances[0]!.emit('message', 'not-json');

    expect(onMessage).toHaveBeenCalledWith({ type: 'subscribed', inboxIds: ['yente@agentmail.to'] });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('fails closed when OneCLI proxy env is missing', async () => {
    await expect(
      createAgentMailOneCliWebSocket({
        env: {},
        websocketCtor: FakeWebSocket,
        proxyAgentFactory: (proxyUrl) => ({ proxyUrl }),
      }),
    ).rejects.toThrow('AgentMail WebSocket requires OneCLI proxy env');
  });

  it('normalizes close code/reason from ws-style args and event-object shapes', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const socket = await createAgentMailOneCliWebSocket({
      env: ONECLI_ENV,
      url: 'wss://ws.agentmail.test/v0',
      websocketCtor: FakeWebSocket,
      proxyAgentFactory: (proxyUrl) => ({ proxyUrl }),
    });
    const closes: Array<{ code?: number; reason?: string }> = [];
    socket.on('close', (event) => closes.push(event));

    FakeWebSocket.instances[0]!.emit('close', 1006, Buffer.from('idle timeout'));
    vi.advanceTimersByTime(1000);
    FakeWebSocket.instances[1]!.emit('close', { code: 4000, reason: 'gateway shutdown' });
    vi.advanceTimersByTime(2000);
    FakeWebSocket.instances[2]!.emit('close');

    expect(closes[0]).toEqual({ code: 1006, reason: 'idle timeout' });
    expect(closes[1]).toEqual({ code: 4000, reason: 'gateway shutdown' });
    expect(closes[2]).toEqual({ code: undefined, reason: undefined });
    socket.close();
  });

  it('pings on the keepalive interval and stops the timer once the socket closes', async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const socket = await createAgentMailOneCliWebSocket({
      env: { ...ONECLI_ENV, AGENTMAIL_WS_PING_INTERVAL_MS: '30000' },
      url: 'wss://ws.agentmail.test/v0',
      websocketCtor: PingFakeWebSocket,
      proxyAgentFactory: (proxyUrl) => ({ proxyUrl }),
    });
    const instance = FakeWebSocket.instances[0] as PingFakeWebSocket;
    instance.emit('open');

    vi.advanceTimersByTime(30_000);
    expect(instance.pings).toBe(1);

    instance.emit('pong');
    vi.advanceTimersByTime(30_000);
    expect(instance.pings).toBe(2);

    socket.close();
    vi.advanceTimersByTime(120_000);
    expect(instance.pings).toBe(2);
  });

  it('force-closes and reconnects when no pong or message arrives for 2x the ping interval', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    FakeWebSocket.instances = [];
    const socket = await createAgentMailOneCliWebSocket({
      env: { ...ONECLI_ENV, AGENTMAIL_WS_PING_INTERVAL_MS: '30000' },
      url: 'wss://ws.agentmail.test/v0',
      websocketCtor: PingFakeWebSocket,
      proxyAgentFactory: (proxyUrl) => ({ proxyUrl }),
    });
    const onError = vi.fn();
    socket.on('error', onError);
    const instance = FakeWebSocket.instances[0] as PingFakeWebSocket;
    instance.emit('open');

    vi.advanceTimersByTime(30_000);
    expect(instance.pings).toBe(1);
    vi.advanceTimersByTime(30_000);

    // Idle force-reconnect is self-healing: it logs at WARN with idle fields
    // and never surfaces through the error handler (which stays reserved for
    // genuine socket errors logged at ERROR).
    expect(warnSpy).toHaveBeenCalledWith('AgentMail WebSocket idle; forcing reconnect', {
      idleMs: 60_000,
      pingIntervalMs: 30_000,
    });
    expect(onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    socket.close();
  });

  it('still surfaces genuine socket errors through the error handler', async () => {
    FakeWebSocket.instances = [];
    const socket = await createAgentMailOneCliWebSocket({
      env: ONECLI_ENV,
      url: 'wss://ws.agentmail.test/v0',
      websocketCtor: FakeWebSocket,
      proxyAgentFactory: (proxyUrl) => ({ proxyUrl }),
    });
    const onError = vi.fn();
    socket.on('error', onError);
    const failure = new Error('ECONNRESET');
    FakeWebSocket.instances[0]!.emit('error', failure);
    expect(onError).toHaveBeenCalledWith(failure);
    socket.close();
  });

  it('keeps retrying past 30 consecutive failures and resets backoff after a successful open', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    FakeWebSocket.instances = [];
    const socket = await createAgentMailOneCliWebSocket({
      env: ONECLI_ENV,
      url: 'wss://ws.agentmail.test/v0',
      websocketCtor: FakeWebSocket,
      proxyAgentFactory: (proxyUrl) => ({ proxyUrl }),
    });

    for (let attempt = 0; attempt < 35; attempt += 1) {
      FakeWebSocket.instances.at(-1)!.emit('close', 1006, Buffer.from(''));
      vi.advanceTimersByTime(10_000);
    }
    expect(FakeWebSocket.instances).toHaveLength(36);
    expect(warnSpy).toHaveBeenCalledWith('AgentMail WebSocket reconnect still failing', { consecutiveFailures: 30 });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const revived = FakeWebSocket.instances.at(-1)!;
    revived.emit('open');
    revived.emit('close', 1006, Buffer.from(''));
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(37);
    socket.close();
  });
});

describe('AgentMail attachment downloads', () => {
  it('fetches the attachment URL and streams its response into a staged file without base64 data', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmail-attachments-'));
    try {
      const chunks = [Buffer.from('large '), Buffer.from('word '), Buffer.from('document')];
      const downloadUrl = 'https://files.agentmail.test/attachment?signature=secret';
      agentMailTestState.getAttachment.mockResolvedValueOnce({
        download_url: downloadUrl,
        filename: 'report.docx',
        content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
              },
            }),
            { headers: { 'content-length': '19' } },
          ),
      );
      const api = createAgentMailApi(
        { mode: 'api-key', apiKey: 'test-key' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, stagingDir: dir },
      );
      const result = await api.downloadAttachment({ inboxId: 'inbox', messageId: 'message', attachmentId: 'file-1' });
      expect(fetchImpl).toHaveBeenCalledWith(downloadUrl, { signal: expect.any(AbortSignal) });
      expect(result).toMatchObject({ filename: 'report.docx', sizeBytes: 19 });
      expect('data' in result).toBe(false);
      expect(await fs.readFile(result.stagedHostPath, 'utf8')).toBe('large word document');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a declared attachment larger than the fixed 1 GiB inbound cap', async () => {
    let bodyCancelled = false;
    const body = {
      cancel: vi.fn(async () => {
        bodyCancelled = true;
      }),
    };
    await expect(
      downloadAgentMailAttachmentResponse(
        {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(1024 ** 3 + 1) }),
          body,
        } as unknown as Response,
        { filename: 'large.docx' },
      ),
    ).rejects.toThrow('Inbound attachment exceeds the 1 GiB limit');
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(bodyCancelled).toBe(true);
  });

  it('reports a safe HTTP status and cancels a rejected response body', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('error body'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 503 },
    );
    await expect(downloadAgentMailAttachmentResponse(response, { filename: 'report.docx' })).rejects.toThrow(
      'AgentMail attachment download failed with HTTP 503',
    );
    expect(cancelled).toBe(true);
  });

  it('rejects declared AgentMail size metadata before fetching the signed URL', async () => {
    agentMailTestState.getAttachment.mockResolvedValueOnce({
      download_url: 'https://files.agentmail.test/attachment?signature=private',
      filename: 'large.docx',
      size_bytes: 1024 ** 3 + 1,
    });
    const fetchImpl = vi.fn();
    const api = createAgentMailApi(
      { mode: 'api-key', apiKey: 'test-key' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await expect(
      api.downloadAttachment({ inboxId: 'inbox', messageId: 'message', attachmentId: 'file-large' }),
    ).rejects.toThrow('Inbound attachment exceeds the 1 GiB limit');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces the byte limit while streaming and removes partial files after overflow', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmail-attachments-'));
    try {
      await expect(
        downloadAgentMailAttachmentResponse(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(Buffer.from('123456'));
                controller.enqueue(Buffer.from('7890'));
                controller.close();
              },
            }),
          ),
          { filename: 'report.docx' },
          { stagingDir: dir, maxBytes: 8 },
        ),
      ).rejects.toThrow('Inbound attachment exceeds the 8-byte limit');
      expect(await fs.readdir(dir)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes interrupted streams and removes partial staging files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmail-attachments-'));
    try {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(Buffer.from('partial'));
          controller.error(new Error('signed URL token=secret'));
        },
      });
      await expect(
        downloadAgentMailAttachmentResponse(new Response(body), { filename: 'report.docx' }, { stagingDir: dir }),
      ).rejects.toThrow('AgentMail attachment download failed');
      expect(await fs.readdir(dir)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('aborts a stalled response after the fixed timeout and removes partial staging bytes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmail-attachments-'));
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(Buffer.from('partial'));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const pending = downloadAgentMailAttachmentResponse(
      response,
      { filename: 'stalled.docx' },
      { stagingDir: dir, timeoutMs: 20 },
    );
    const timeoutAssertion = expect(pending).rejects.toThrow(/timed out/i);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await timeoutAssertion;
      expect(cancelled).toBe(true);
      expect(await fs.readdir(dir)).toEqual([]);
    } finally {
      await pending.catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
