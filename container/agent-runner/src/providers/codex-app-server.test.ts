import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  createCodexConfigOverrides,
  STALE_THREAD_RE,
  tomlBasicString,
  writeCodexMcpConfigToml,
} from './codex-app-server.js';

describe('tomlBasicString', () => {
  it('leaves safe strings unchanged inside quotes', () => {
    expect(tomlBasicString('hello')).toBe('"hello"');
    expect(tomlBasicString('bun')).toBe('"bun"');
    expect(tomlBasicString('/usr/local/bin/node')).toBe('"/usr/local/bin/node"');
  });

  it('escapes double-quotes', () => {
    expect(tomlBasicString('a"b')).toBe('"a\\"b"');
    expect(tomlBasicString('"quoted"')).toBe('"\\"quoted\\""');
  });

  it('escapes backslashes', () => {
    expect(tomlBasicString('a\\b')).toBe('"a\\\\b"');
    expect(tomlBasicString('C:\\path\\to\\bin')).toBe('"C:\\\\path\\\\to\\\\bin"');
  });

  it('escapes backslash before quote (order matters)', () => {
    expect(tomlBasicString('\\"')).toBe('"\\\\\\""');
  });

  it('rejects strings containing newlines', () => {
    expect(() => tomlBasicString('line1\nline2')).toThrow(/newline/);
    expect(() => tomlBasicString('trailing\n')).toThrow(/newline/);
    expect(() => tomlBasicString('crlf\r\nhere')).toThrow(/newline/);
  });
});

describe('STALE_THREAD_RE', () => {
  it('matches stale-thread error messages', () => {
    expect(STALE_THREAD_RE.test('thread not found')).toBe(true);
    expect(STALE_THREAD_RE.test('unknown thread xyz')).toBe(true);
    expect(STALE_THREAD_RE.test('No such thread: abc')).toBe(true);
    expect(STALE_THREAD_RE.test('invalid thread_id')).toBe(true);
  });

  it('does not match transient or unrelated errors', () => {
    expect(STALE_THREAD_RE.test('rate limit exceeded')).toBe(false);
    expect(STALE_THREAD_RE.test('authentication failed')).toBe(false);
    expect(STALE_THREAD_RE.test('connection reset by peer')).toBe(false);
    expect(STALE_THREAD_RE.test('internal server error')).toBe(false);
  });
});

describe('Codex strict config compatibility', () => {
  it('does not emit unsupported mcp server type under strict config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      writeCodexMcpConfigToml({
        local: { command: 'node', args: ['server.mjs'], env: { SAFE_VALUE: 'ok' } },
      });
      const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
      expect(toml).toContain('[mcp_servers.local]');
      expect(toml).toContain('command = "node"');
      expect(toml).not.toContain('type = "stdio"');
    } finally {
      process.env.HOME = oldHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('disables the hosted apps connector under strict config', () => {
    // codex_apps cannot authenticate through the OneCLI-broker-mediated egress,
    // so every Codex turn must start with the connector disabled.
    expect(createCodexConfigOverrides()).toContain('features.apps=false');
  });

  it('passes model_reasoning_effort as a strict config override', () => {
    process.env.CODEX_REASONING_EFFORT = 'xhigh';
    try {
      expect(createCodexConfigOverrides()).toContain('model_reasoning_effort=xhigh');
    } finally {
      delete process.env.CODEX_REASONING_EFFORT;
    }
  });
});
