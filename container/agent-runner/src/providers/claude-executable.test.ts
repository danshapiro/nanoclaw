/**
 * FIX 2: Claude Code executable resolution.
 *
 * The hardcoded /pnpm/claude bin shim exists in the base image (created at
 * image-build time by `pnpm install -g @anthropic-ai/claude-code`) but can be
 * missing in per-agent-group images whose extra `pnpm install -g <pkgs>` layer
 * re-links pnpm's global bin dir (buildAgentGroupImage). Resolution must fall
 * back to a PATH lookup and then to the SDK's bundled default, with one loud
 * structured error (not per-turn noise) when nothing is found.
 */
import { describe, it, expect, beforeEach, spyOn } from 'bun:test';

import {
  DEFAULT_CLAUDE_EXECUTABLE_PATH,
  resetClaudeExecutableResolutionLogForTests,
  resolveClaudeCodeExecutable,
  resolveClaudeExecutableWithLogging,
} from './claude.js';

describe('resolveClaudeCodeExecutable', () => {
  beforeEach(() => {
    resetClaudeExecutableResolutionLogForTests();
  });

  it('prefers the configured /pnpm/claude path when it exists', () => {
    const resolution = resolveClaudeCodeExecutable({
      existsSync: (p) => p === DEFAULT_CLAUDE_EXECUTABLE_PATH,
      env: { PATH: '/usr/local/bin:/usr/bin' },
    });
    expect(resolution.path).toBe(DEFAULT_CLAUDE_EXECUTABLE_PATH);
    expect(resolution.source).toBe('configured-path');
  });

  it('falls back to a PATH lookup when the configured path is missing', () => {
    const resolution = resolveClaudeCodeExecutable({
      existsSync: (p) => p === '/usr/local/bin/claude',
      env: { PATH: '/pnpm/bin:/usr/local/bin:/usr/bin' },
    });
    expect(resolution.path).toBe('/usr/local/bin/claude');
    expect(resolution.source).toBe('path-lookup');
    expect(resolution.tried[0]).toBe(DEFAULT_CLAUDE_EXECUTABLE_PATH);
  });

  it('falls back to the SDK bundled default when nothing is found', () => {
    const resolution = resolveClaudeCodeExecutable({
      existsSync: () => false,
      env: { PATH: '/usr/local/bin:/usr/bin' },
    });
    expect(resolution.path).toBeUndefined();
    expect(resolution.source).toBe('sdk-default');
    expect(resolution.tried).toContain('/usr/bin/claude');
  });

  it('treats existsSync throws as not-found instead of crashing provider init', () => {
    const resolution = resolveClaudeCodeExecutable({
      existsSync: () => {
        throw new Error('EACCES');
      },
      env: { PATH: '/usr/bin' },
    });
    expect(resolution.path).toBeUndefined();
    expect(resolution.source).toBe('sdk-default');
  });

  it('logs the structured not-found error once, not per resolution attempt', () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const deps = { existsSync: () => false, env: { PATH: '/usr/bin' } };

    expect(resolveClaudeExecutableWithLogging(deps)).toBeUndefined();
    expect(resolveClaudeExecutableWithLogging(deps)).toBeUndefined();

    const notFoundLogs = errSpy.mock.calls.filter((call) => String(call[0]).includes('claude_executable_not_found'));
    expect(notFoundLogs).toHaveLength(1);
    const payload = JSON.parse(String(notFoundLogs[0][0])) as Record<string, unknown>;
    expect(payload.severity).toBe('error');
    expect(payload.configured_path).toBe(DEFAULT_CLAUDE_EXECUTABLE_PATH);
    expect(payload.fallback).toBe('sdk_bundled_default');
    errSpy.mockRestore();
  });

  it('logs a warn (not error) when resolved via PATH lookup', () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const resolved = resolveClaudeExecutableWithLogging({
      existsSync: (p) => p === '/usr/local/bin/claude',
      env: { PATH: '/usr/local/bin' },
    });
    expect(resolved).toBe('/usr/local/bin/claude');
    const pathLogs = errSpy.mock.calls.filter((call) =>
      String(call[0]).includes('claude_executable_resolved_from_path'),
    );
    expect(pathLogs).toHaveLength(1);
    expect(JSON.parse(String(pathLogs[0][0])).severity).toBe('warn');
    errSpy.mockRestore();
  });
});
