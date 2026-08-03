import { describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import { ensureAgentMailOneCliEnv, hasAgentMailOneCliProxyEnv } from './agentmail-onecli.js';

const ACQUIRED_ENV = {
  HTTPS_PROXY: 'http://user:pass@127.0.0.1:8443',
  HTTP_PROXY: 'http://user:pass@127.0.0.1:8443',
  https_proxy: 'http://user:pass@127.0.0.1:8443',
  http_proxy: 'http://user:pass@127.0.0.1:8443',
  AGENTMAIL_ONECLI_ENV_READY: '1',
  NODE_EXTRA_CA_CERTS: '/srv/nanoclaw/shared/agentmail/onecli-gateway-ca.pem',
  NODE_USE_ENV_PROXY: '1',
};

describe('ensureAgentMailOneCliEnv', () => {
  it('is a no-op when AgentMail is disabled', async () => {
    const runScript = vi.fn();
    await expect(ensureAgentMailOneCliEnv({}, { runScript })).resolves.toBe('disabled');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('is a no-op when the proxy env is already present (start.sh eval worked)', async () => {
    const runScript = vi.fn();
    const env = { AGENTMAIL_ENABLED: '1', ...ACQUIRED_ENV };
    await expect(ensureAgentMailOneCliEnv(env, { runScript })).resolves.toBe('present');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('runs the script and applies the acquired env', async () => {
    const env: NodeJS.ProcessEnv = { AGENTMAIL_ENABLED: '1', AGENTMAIL_ONECLI_ENV_SCRIPT: '/srv/x/env.mjs' };
    const runScript = vi.fn(async () => JSON.stringify(ACQUIRED_ENV));
    await expect(ensureAgentMailOneCliEnv(env, { runScript, fileExists: () => true })).resolves.toBe('acquired');
    expect(runScript).toHaveBeenCalledWith('/srv/x/env.mjs', 30000);
    expect(env.HTTPS_PROXY).toBe(ACQUIRED_ENV.HTTPS_PROXY);
    expect(hasAgentMailOneCliProxyEnv(env)).toBe(true);
  });

  it('honors AGENTMAIL_ONECLI_ENV_TIMEOUT_MS', async () => {
    const env: NodeJS.ProcessEnv = {
      AGENTMAIL_ENABLED: '1',
      AGENTMAIL_ONECLI_ENV_SCRIPT: '/srv/x/env.mjs',
      AGENTMAIL_ONECLI_ENV_TIMEOUT_MS: '5000',
    };
    const runScript = vi.fn(async () => JSON.stringify(ACQUIRED_ENV));
    await ensureAgentMailOneCliEnv(env, { runScript, fileExists: () => true });
    expect(runScript).toHaveBeenCalledWith('/srv/x/env.mjs', 5000);
  });

  it('returns failed and leaves env untouched when the script fails (cold network)', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = { AGENTMAIL_ENABLED: '1', AGENTMAIL_ONECLI_ENV_SCRIPT: '/srv/x/env.mjs' };
    const runScript = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    await expect(ensureAgentMailOneCliEnv(env, { runScript, fileExists: () => true })).resolves.toBe('failed');
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'AgentMail OneCLI env acquisition failed, adapter start will be retried',
      expect.objectContaining({ scriptPath: '/srv/x/env.mjs' }),
    );
    warnSpy.mockRestore();
  });

  it('returns failed when the script path does not exist', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = { AGENTMAIL_ENABLED: '1' };
    await expect(ensureAgentMailOneCliEnv(env, { fileExists: () => false })).resolves.toBe('failed');
    warnSpy.mockRestore();
  });

  it('returns failed on non-JSON stdout', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = { AGENTMAIL_ENABLED: '1', AGENTMAIL_ONECLI_ENV_SCRIPT: '/srv/x/env.mjs' };
    const runScript = vi.fn(async () => 'export FOO=bar');
    await expect(ensureAgentMailOneCliEnv(env, { runScript, fileExists: () => true })).resolves.toBe('failed');
    warnSpy.mockRestore();
  });
});
