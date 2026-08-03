/**
 * Runtime acquisition of the AgentMail OneCLI proxy env.
 *
 * Production boots get this env from start.sh (ops repo):
 *   eval "$(node $NANOCLAW_ROOT/agentmail-onecli-env.mjs --shell)"
 * That eval is one-shot: when it fails (cold network at boot, 2026-08-02),
 * nanoclaw runs proxy-less and the AgentMail factory hard-fails forever.
 * This module lets the factory re-run the same script (JSON output mode) on
 * each startup retry, so AgentMail recovers as soon as OneCLI is reachable.
 *
 * It never throws: on failure the existing preflight
 * (requireAgentMailOneCliProxyEnv in agentmail.ts — shape unchanged) still
 * throws its usual error, which feeds the channel-registry startup retry.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

import { NANOCLAW_ROOT } from '../config.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

export type AgentMailOneCliEnvResult = 'disabled' | 'present' | 'acquired' | 'failed';

export type RunOneCliEnvScript = (scriptPath: string, timeoutMs: number) => Promise<string>;

const DEFAULT_ONECLI_ENV_TIMEOUT_MS = 30_000;

const defaultRunScript: RunOneCliEnvScript = async (scriptPath, timeoutMs) => {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], { timeout: timeoutMs });
  return stdout;
};

/** Non-throwing mirror of requireAgentMailOneCliProxyEnv (agentmail.ts:514-525). */
export function hasAgentMailOneCliProxyEnv(env: NodeJS.ProcessEnv): boolean {
  const proxy = env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || env.HTTP_PROXY?.trim() || env.http_proxy?.trim();
  return Boolean(proxy) && env.NODE_USE_ENV_PROXY === '1' && Boolean(env.NODE_EXTRA_CA_CERTS?.trim());
}

export async function ensureAgentMailOneCliEnv(
  env: NodeJS.ProcessEnv,
  deps: { runScript?: RunOneCliEnvScript; fileExists?: (path: string) => boolean } = {},
): Promise<AgentMailOneCliEnvResult> {
  if (env.AGENTMAIL_ENABLED !== '1') return 'disabled';
  if (hasAgentMailOneCliProxyEnv(env)) return 'present';

  const scriptPath =
    env.AGENTMAIL_ONECLI_ENV_SCRIPT?.trim() || `${env.NANOCLAW_ROOT || NANOCLAW_ROOT}/agentmail-onecli-env.mjs`;
  const fileExists = deps.fileExists ?? fs.existsSync;
  if (!fileExists(scriptPath)) {
    log.warn('AgentMail OneCLI env script not found, skipping acquisition', { scriptPath });
    return 'failed';
  }

  let timeoutMs = DEFAULT_ONECLI_ENV_TIMEOUT_MS;
  const timeoutRaw = env.AGENTMAIL_ONECLI_ENV_TIMEOUT_MS?.trim();
  if (timeoutRaw) {
    const parsed = Number(timeoutRaw);
    if (Number.isInteger(parsed) && parsed > 0) timeoutMs = parsed;
    else log.warn('Ignoring malformed AGENTMAIL_ONECLI_ENV_TIMEOUT_MS', { value: timeoutRaw });
  }

  const runScript = deps.runScript ?? defaultRunScript;
  try {
    const stdout = await runScript(scriptPath, timeoutMs);
    const acquired = JSON.parse(stdout) as Record<string, string>;
    Object.assign(env, acquired);
    if (!hasAgentMailOneCliProxyEnv(env)) {
      log.warn('AgentMail OneCLI env script output missing proxy env, adapter start will be retried', {
        scriptPath,
        keys: Object.keys(acquired).sort(),
      });
      return 'failed';
    }
    log.info('AgentMail OneCLI env acquired', { scriptPath, keys: Object.keys(acquired).sort() });
    return 'acquired';
  } catch (err) {
    log.warn('AgentMail OneCLI env acquisition failed, adapter start will be retried', { scriptPath, err });
    return 'failed';
  }
}
