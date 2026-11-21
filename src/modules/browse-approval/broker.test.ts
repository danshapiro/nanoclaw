import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { expect, it } from 'vitest';
import type { BrowseRecord, BrowseDependencies } from './service.js';
import { BrowseControlClient } from './broker.js';

it('uses only the host Unix control socket and handles grant/revoke/reset with real HTTP', async () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp-browse-'));
  const socketPath = path.join(directory, 'control.sock');
  const calls: Array<{ method: string | undefined; path: string | undefined; body: string }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      calls.push({ method: request.method, path: request.url, body });
      response.setHeader('Content-Type', 'application/json');
      response.end(
        request.url === '/sessions'
          ? JSON.stringify({ token: 'opaque', ...JSON.parse(body), expiresAt: '2026-11-21T18:00:00Z' })
          : '{}',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const client = new BrowseControlClient(socketPath);
    expect(await client.grant({ sessionId: 's-a', requestId: 'r-a', browser: 'chrome-dandesktop' })).toMatchObject({
      token: 'opaque',
      sessionId: 's-a',
    });
    await client.revoke('s-a');
    await client.reset();
    expect(calls.map((x) => [x.method, x.path])).toEqual([
      ['POST', '/sessions'],
      ['DELETE', '/sessions/s-a'],
      ['POST', '/reset'],
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true });
  }
});

it('does not report stopped or replace an approval when the real control socket fails to revoke', async () => {
  const { BrowseApprovalService } = await import('./service.js');
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp-browse-'));
  const socket = path.join(dir, 'control.sock');
  let failRevoke = false;
  let permit = false;
  const server = http.createServer((request, response) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
    });
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'DELETE' && failRevoke) {
        response.writeHead(503);
        response.end('{"error":"unavailable"}');
        return;
      }
      if (request.url === '/sessions') {
        permit = true;
        response.end(
          JSON.stringify({
            ...JSON.parse(data),
            token: 'secret',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
            maximumExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          }),
        );
        return;
      }
      permit = false;
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const session = {
    id: 's',
    agent_group_id: 'ag',
    messaging_group_id: 'mg',
    thread_id: null,
    agent_provider: 'codex',
    status: 'active' as const,
    container_status: 'running' as const,
    last_active: null,
    created_at: '',
  };
  const records: BrowseRecord[] = [];
  const cards: Array<{ question: string; options: Parameters<BrowseDependencies['sendCard']>[3] }> = [];
  const service = new BrowseApprovalService({
    broker: new BrowseControlClient(socket),
    getSession: () => session,
    writeRecord: (_s, r) => {
      records.push(r);
    },
    sendCard: async (_s, _id, question, options) => {
      cards.push({ question, options });
      return { channelType: 'discord', platformId: 'channel', threadId: null, messageId: `card-${cards.length}` };
    },
    saveRender: () => {},
    deleteRender: () => {},
    notify: () => {},
    now: Date.now,
  });
  const req = {
    requestId: 'r',
    purpose: 'Read updates',
    url: 'https://example.com',
    browser: 'chrome-dandesktop',
    hostInputId: 'input',
    routeKey: 'route',
  };
  const response = (value: string, card: string) => ({
    questionId: service.questionId('s')!,
    value,
    userId: 'dan',
    channelType: 'discord',
    platformId: 'channel',
    threadId: null,
    transportReceipt: { source: 'discord-component' as const, channelId: 'channel', messageId: card },
  });
  try {
    await service.request(session, req, {
      userId: 'dan',
      channelType: 'discord',
      platformId: 'channel',
      threadId: null,
    });
    await service.respond(response('allow', 'card-1'));
    expect(permit).toBe(true);
    failRevoke = true;
    await expect(service.respond(response('stop', 'card-2'))).rejects.toThrow(/503/);
    expect(permit).toBe(true);
    expect(records.at(-1)?.status).toBe('revocation_failed');
    expect(records.at(-1)).not.toHaveProperty('token');
    expect(cards.at(-1)?.question).toContain('Access may still be active');
    expect(cards.at(-1)?.options[0].value).toBe('stop');
    await expect(
      service.request(
        session,
        { ...req, requestId: 'replacement' },
        { userId: 'dan', channelType: 'discord', platformId: 'channel', threadId: null },
      ),
    ).rejects.toThrow(/503/);
    expect(permit).toBe(true);
    failRevoke = false;
    await service.respond(response('stop', `card-${cards.length}`));
    expect(permit).toBe(false);
    expect(records.at(-1)?.status).toBe('ended');
  } finally {
    failRevoke = false;
    await service.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true });
  }
});

it('keeps previous access files locked after an actual socket reset failure', async () => {
  const { BrowseRecordStore } = await import('./records.js');
  const { BrowseApprovalService } = await import('./service.js');
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-tmp-browse-reset-'));
  const socket = path.join(dir, 'control.sock');
  let grants = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/sessions') grants++;
    response.writeHead(503);
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const session = { id: 's', agent_group_id: 'ag', status: 'active' } as import('../../types.js').Session;
  const records = new BrowseRecordStore(dir);
  records.write(session, {
    status: 'approved',
    requestId: 'old',
    purpose: 'Old task',
    url: 'https://example.com',
    browser: 'chrome-dandesktop',
    token: 'old-permit',
  });
  records.invalidateAfterRestart();
  const service = new BrowseApprovalService({
    broker: new BrowseControlClient(socket),
    getSession: () => session,
    writeRecord: (s, r) => records.write(s, r),
    sendCard: async () => {
      throw new Error('no card should be delivered');
    },
    saveRender: () => {},
    deleteRender: () => {},
    notify: () => {},
    now: Date.now,
  });
  try {
    await expect(
      service.request(
        session,
        {
          requestId: 'new',
          purpose: 'New task',
          url: 'https://example.com',
          browser: 'chrome-dandesktop',
          hostInputId: 'input',
          routeKey: 'route',
        },
        { userId: 'dan', channelType: 'discord', platformId: 'channel', threadId: null },
      ),
    ).rejects.toThrow(/503/);
    const file = JSON.parse(fs.readFileSync(records.file('ag', 's'), 'utf8'));
    expect(file.status).toBe('ended');
    expect(file).not.toHaveProperty('token');
    expect(grants).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true });
  }
});
