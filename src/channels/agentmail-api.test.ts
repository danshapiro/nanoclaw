import { describe, expect, it, vi } from 'vitest';

import { AGENTMAIL_ONECLI_PLACEHOLDER, createAgentMailOneCliWebSocket } from './agentmail-api.js';

type FakeWebSocketEvent = 'open' | 'message' | 'close' | 'error';
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

describe('AgentMail API WebSocket boundary', () => {
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
});
