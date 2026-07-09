import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import { AGENTMAIL_ONECLI_PLACEHOLDER, createAgentMailOneCliWebSocket } from './agentmail-api.js';

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

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('idle') }));
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
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
