import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildStatusReport } from './status-report.js';
import { RegisteredGroup } from './types.js';

const GROUP: RegisteredGroup = {
  name: 'Yente',
  folder: 'main',
  trigger: '@Andy',
  added_at: '2026-01-01T00:00:00.000Z',
  isMain: true,
};

describe('buildStatusReport', () => {
  const originalEnv = { ...process.env };
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-status-'));
    vi.stubGlobal('fetch', vi.fn());
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('summarizes healthy services and lists failures only', async () => {
    const dataDir = path.join(rootDir, 'data');
    const storeDir = path.join(rootDir, 'store');
    const projectsDir = path.join(
      dataDir,
      'sessions',
      'main',
      '.claude',
      'projects',
      '-workspace-group',
    );
    const skillsDir = path.join(
      dataDir,
      'sessions',
      'main',
      '.claude',
      'skills',
    );

    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'status'), { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'messages.db'), 'ok');
    fs.writeFileSync(
      path.join(projectsDir, 'session-123.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-04-12T18:00:00.000Z',
          message: {
            model: 'claude-sonnet-4-6',
            usage: {
              input_tokens: 1000,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 300,
              output_tokens: 400,
            },
          },
        }),
      ].join('\n'),
    );

    process.env.GWS_PROXY_URL = 'https://gws.example.com';
    process.env.FAMILIAR_API_URL = 'https://familiar.example.com';

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('gws.example.com')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('bad gateway', { status: 502 });
    });

    const report = await buildStatusReport({
      chatName: 'Dan Code Projects #yente',
      group: GROUP,
      sessionId: 'session-123',
      isDiscordConnected: true,
      dataDir,
      storeDir,
      processUptimeMs: 3_900_000,
      timezone: 'America/Los_Angeles',
    });

    expect(report).toContain('• Current model: claude-sonnet-4-6');
    expect(report).toContain('• Tokens: 1,900 / 200,000 (1.0%)');
    expect(report).toContain('• 5 services OK');
    expect(report).toContain(
      '• Familiar API: HTTP 502 from https://familiar.example.com/health',
    );
    expect(report).not.toContain('Discord gateway:');
    expect(report).not.toContain('GWS proxy:');
  });
});
