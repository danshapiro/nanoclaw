/**
 * Host-side container config for the `codex` provider.
 *
 * Codex reads auth and MCP config from ~/.codex. We give each session its
 * own private copy of that directory so:
 *
 * - The session's brokered access-token-only auth.json reaches the container
 *   without us touching the host's own ~/.codex/config.toml (which the host's
 *   own `codex` CLI might be using).
 * - The in-container provider can rewrite config.toml freely on every
 *   wake with container-appropriate MCP server paths, without racing
 *   other sessions or leaking per-session paths back to the host.
 *
 * Credential source: the per-group credential broker — NOT the host's
 * ~/.codex/auth.json. The broker owns the single refresh token and refreshes
 * centrally; this container only ever receives a short-lived access token.
 *
 * Env passthrough (NO raw model-provider keys — credential boundary):
 *   CODEX_MODEL            — model override (optional)
 *   OPENAI_BASE_URL        — API-compatible alternate base URL (rare)
 *   CODEX_REASONING_EFFORT — reasoning effort level (default: high, set by
 *                            createCodexConfigOverrides in codex-app-server.ts)
 *
 * OPENAI_API_KEY is intentionally NOT forwarded. Codex authenticates via the
 * ChatGPT-OAuth auth.json only; a raw API key would breach the container
 * credential boundary and flip Codex out of ChatGPT-OAuth into API-key billing.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { registerProviderContainerConfig, type ProviderContainerContext } from './provider-container-registry.js';

interface CodexBrokerResponse {
  ok: boolean;
  store?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Auth-gated OneCLI egress.
//
// Every Codex container's network egress is forced through the OneCLI auth-gate
// with a scoped `aoc_` token plus a placeholder provider credential. Codex
// differs from OpenCode in two ways that matter here:
//
//   1. Codex carries its OWN ChatGPT-OAuth bearer (the brokered access token in
//      auth.json) to https://chatgpt.com/backend-api/. The gateway injects a
//      stored secret ONLY when the request host matches that secret's
//      hostPattern; chatgpt.com matches NO secret, so codex's bearer passes
//      through untouched. We therefore do NOT bind/inject any model-provider
//      key — the placeholder exists only to satisfy patch 009's spawn gate, and
//      it must be one of ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
//      OPENCODE_API_KEY (009's accepted set). It must NOT be OPENAI_API_KEY,
//      which 009 does not accept AND which would flip codex into API billing.
//
//   2. The auth-gate MITM-terminates TLS, so the container must trust the
//      gateway CA. Codex is a Rust/reqwest/rustls binary: it honors
//      CODEX_CA_CERTIFICATE (codex-specific) and SSL_CERT_FILE, but IGNORES
//      NODE_EXTRA_CA_CERTS (Node-only). We therefore require the per-bot native
//      config to point all three at the mounted CA so both the Rust codex
//      binary AND the Node agent-runner wrapper trust the gateway.
//
// Mirrors opencode.ts's native-OneCLI contract; the token is injected at
// spawn time from a separate file so it is never persisted in the config JSON.
// ---------------------------------------------------------------------------

const ONECLI_PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;
// Placeholder credential keys. OPENAI_API_KEY is deliberately excluded because
// it would breach the credential boundary and flip Codex into API billing.
const ONECLI_PLACEHOLDER_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENCODE_API_KEY'] as const;
// The CA env keys codex needs (CODEX_CA_CERTIFICATE + SSL_CERT_FILE for the Rust
// binary; NODE_EXTRA_CA_CERTS for the Node wrapper) plus proxy/git knobs.
const ONECLI_CA_ENV = ['CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'] as const;
const ONECLI_ALLOWED_ENV = new Set<string>([
  ...ONECLI_PROXY_ENV,
  ...ONECLI_PLACEHOLDER_ENV,
  ...ONECLI_CA_ENV,
  'NODE_USE_ENV_PROXY',
  'GIT_TERMINAL_PROMPT',
  'GIT_HTTP_PROXY_AUTHMETHOD',
  'GIT_PROXY_COMMAND',
]);

interface OneCliMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

interface NativeCodexOneCliConfig {
  agentGroupId: string;
  onecliAgentIdentifier: string;
  onecliAgentId: string;
  onecliAgentTokenFile: string;
  onecliAgentAccessTokenSha256: string;
  onecliAuthGateHost?: string;
  onecliAuthGatePort?: number;
  env: Record<string, string>;
  proxyEnv: Record<string, string>;
  mounts: OneCliMount[];
}

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

function authGateHostFromEnv(hostEnv: NodeJS.ProcessEnv): string {
  return hostEnv.ONECLI_GATEWAY_AUTH_GATE_HOST_ALIAS || 'yente-onecli-auth-gate.local';
}

function authGatePortFromEnv(hostEnv: NodeJS.ProcessEnv): string {
  return hostEnv.ONECLI_GATEWAY_AUTH_GATE_PORT || hostEnv.ONECLI_GATEWAY_AUTH_GATE_HOST_PORT || '18055';
}

function assertCodexPlaceholderValue(key: string, value: string): void {
  const normalized = value.trim().toLowerCase();
  if (
    normalized !== 'placeholder' &&
    normalized !== '__placeholder__' &&
    normalized !== 'onecli-placeholder' &&
    normalized !== 'dummy' &&
    normalized !== 'stub' &&
    normalized !== 'redacted' &&
    normalized !== 'changeme' &&
    !normalized.startsWith('placeholder-') &&
    !normalized.startsWith('placeholder_')
  ) {
    throw new Error(`Native OneCLI codex env ${key} must contain only placeholder auth`);
  }
}

function assertCodexAuthGatedProxyTemplate(
  key: string,
  value: string,
  hostEnv: NodeJS.ProcessEnv,
  config: NativeCodexOneCliConfig,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Native OneCLI codex env ${key} is not a valid proxy URL`);
  }
  const expectedHost = config.onecliAuthGateHost || authGateHostFromEnv(hostEnv);
  const expectedPort = String(config.onecliAuthGatePort || authGatePortFromEnv(hostEnv));
  if (url.protocol !== 'http:') {
    throw new Error(`Native OneCLI codex env ${key} must use the HTTP auth-gate proxy`);
  }
  if (url.hostname !== expectedHost || url.port !== expectedPort) {
    throw new Error(`Native OneCLI codex env ${key} must point at ${expectedHost}:${expectedPort}`);
  }
  // Tokenless template: the scoped token is injected from the token file at
  // spawn time and must never be persisted in the config JSON.
  if (!url.username || url.password) {
    throw new Error(`Native OneCLI codex env ${key} must be a tokenless auth-gate proxy template`);
  }
  return url;
}

function readCodexOneCliAgentToken(config: NativeCodexOneCliConfig): string {
  if (!path.isAbsolute(config.onecliAgentTokenFile || '')) {
    throw new Error('Native OneCLI codex config must include an absolute token file path');
  }
  const token = fs.readFileSync(config.onecliAgentTokenFile, 'utf8').trim();
  if (!token.startsWith('aoc_')) {
    throw new Error('Native OneCLI codex token file must contain a scoped OneCLI agent token');
  }
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  if (tokenHash !== config.onecliAgentAccessTokenSha256) {
    throw new Error('Native OneCLI codex token file does not match config hash');
  }
  return token;
}

function buildCodexAuthGatedProxyEnv(
  config: NativeCodexOneCliConfig,
  hostEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!config.proxyEnv || typeof config.proxyEnv !== 'object' || Array.isArray(config.proxyEnv)) {
    throw new Error('Native OneCLI codex config must include proxyEnv object');
  }
  const token = readCodexOneCliAgentToken(config);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.proxyEnv)) {
    if (!(ONECLI_PROXY_ENV as readonly string[]).includes(key)) {
      throw new Error(`Native OneCLI codex config contains unsupported proxy env key: ${key}`);
    }
    const url = assertCodexAuthGatedProxyTemplate(key, value, hostEnv, config);
    url.password = token;
    out[key] = url.toString().replace(/\/$/, '');
  }
  if (Object.keys(out).length === 0) {
    throw new Error('Native OneCLI codex config must include auth-gated proxy env');
  }
  return out;
}

function assertNativeCodexOneCliConfig(
  config: NativeCodexOneCliConfig,
  hostEnv: NodeJS.ProcessEnv,
  agentGroupId: string,
): void {
  if (config.agentGroupId !== agentGroupId) {
    throw new Error('Native OneCLI codex config agent group does not match this session');
  }
  if (!config.onecliAgentIdentifier || !config.onecliAgentId || !config.onecliAgentAccessTokenSha256) {
    throw new Error('Native OneCLI codex config is missing agent metadata');
  }
  if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) {
    throw new Error('Native OneCLI codex config must include env object');
  }
  if (!Array.isArray(config.mounts)) {
    throw new Error('Native OneCLI codex config mounts must be an array');
  }
  let hasPlaceholder = false;
  for (const [key, value] of Object.entries(config.env)) {
    if (!ONECLI_ALLOWED_ENV.has(key)) {
      throw new Error(`Native OneCLI codex config contains unsupported env key: ${key}`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Native OneCLI codex config env ${key} must be a non-empty string`);
    }
    if ((ONECLI_PROXY_ENV as readonly string[]).includes(key)) {
      throw new Error(`Native OneCLI codex config must not persist credentialed proxy env key: ${key}`);
    }
    if ((ONECLI_PLACEHOLDER_ENV as readonly string[]).includes(key)) {
      hasPlaceholder = true;
      assertCodexPlaceholderValue(key, value);
    }
  }
  if (!hasPlaceholder) {
    throw new Error('Native OneCLI codex config must include a provider placeholder credential');
  }
  // The container MUST trust the auth-gate CA. Codex (Rust) honors
  // CODEX_CA_CERTIFICATE + SSL_CERT_FILE; require BOTH, each pointing at a
  // read-only CA mount. NODE_EXTRA_CA_CERTS (Node wrapper) is also required.
  for (const caKey of ONECLI_CA_ENV) {
    const caPath = config.env[caKey];
    if (!caPath || !path.posix.isAbsolute(caPath)) {
      throw new Error(`Native OneCLI codex config must include absolute ${caKey}`);
    }
    const caMount = config.mounts.find((mount) => mount.containerPath === caPath);
    if (!caMount?.readonly) {
      throw new Error(`Native OneCLI codex CA must be mounted read-only at ${caKey}`);
    }
  }
  for (const mount of config.mounts) {
    if (!path.isAbsolute(mount.hostPath) || !path.posix.isAbsolute(mount.containerPath)) {
      throw new Error('Native OneCLI codex mounts must use absolute host and container paths');
    }
    if (mount.readonly !== true) {
      throw new Error('Native OneCLI codex mounts must be read-only');
    }
  }
  // Validate the proxy templates (and token-file hash) eagerly.
  buildCodexAuthGatedProxyEnv(config, hostEnv);
}

function readNativeCodexOneCliConfig(
  configPath: string,
  hostEnv: NodeJS.ProcessEnv,
  agentGroupId: string,
): NativeCodexOneCliConfig {
  if (!configPath) {
    throw new Error('Yente Codex OneCLI config path is required for native OneCLI codex egress');
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as NativeCodexOneCliConfig;
  assertNativeCodexOneCliConfig(parsed, hostEnv, agentGroupId);
  return parsed;
}

function fetchCodexCredentialSync(socketPath: string, target: string): CodexBrokerResponse {
  // Self-contained client: connect, send one request line, read one response
  // line, print it, exit. Errors are reported as a fail-closed JSON object on
  // stdout (never a non-zero exit that would throw before we can read it).
  const client = [
    "const net=require('node:net');",
    'const [sock,target]=process.argv.slice(1);',
    "const c=net.createConnection(sock);let buf='';",
    "c.on('connect',()=>c.write(JSON.stringify({op:'get-codex-credential',target})+'\\n'));",
    "c.on('data',d=>{buf+=d;const i=buf.indexOf('\\n');if(i>=0){process.stdout.write(buf.slice(0,i));c.end();}});",
    "c.on('error',e=>{process.stdout.write(JSON.stringify({ok:false,error:String(e&&e.message||e)}));c.end();});",
  ].join('');
  let out: string;
  try {
    out = execFileSync(process.execPath, ['-e', client, socketPath, target], { encoding: 'utf8', timeout: 5000 });
  } catch (e) {
    return { ok: false, error: `broker client failed: ${(e as Error).message}` };
  }
  try {
    return JSON.parse(out.trim()) as CodexBrokerResponse;
  } catch {
    return { ok: false, error: 'unparseable broker response' };
  }
}

// Fail-closed boundary guard: throw if a forbidden secret appears ANYWHERE in the
// store the broker returned, before it is written into the container mount. A
// "forbidden secret" is a non-empty `refresh_token` (the rotating crown-jewel) OR
// a non-empty raw provider key (`*_api_key` / `*_api_token`, e.g. `OPENAI_API_KEY`).
// The `id_token` is NOT forbidden: codex-cli auth.json parsing requires it
// (the app-server exits with `missing field \`id_token\`` without it), and it is a
// signed OIDC identity assertion — NOT an API bearer and NOT a refresh capability,
// so admitting it preserves the load-bearing invariant (only the host holds the
// refresh token; the container can never mint new credentials). This matches the
// boundary documented in ARCHITECTURE.md. Empty-string / null placeholders are
// permitted (A1-false handling forces null). This is the alarm layer; the host
// also allowlist-reconstructs the store so a field this denylist fails to
// enumerate still cannot reach the container.
function assertNoContainerForbiddenSecretsDeep(value: unknown, at = '$'): void {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const forbiddenKey = /refresh[_-]?token/i.test(k) || /api[_-]?(key|token)/i.test(k);
      if (forbiddenKey && v != null && v !== '') {
        throw new Error(`codex credential boundary violation: forbidden secret present at ${at}.${k}`);
      }
      assertNoContainerForbiddenSecretsDeep(v, `${at}.${k}`);
    }
  }
}

function requiredAgentGroupFolder(ctx: ProviderContainerContext): string {
  if (!ctx.agentGroupFolder) {
    throw new Error('codex provider requires agent group folder context');
  }
  return ctx.agentGroupFolder;
}

function codexGroupDir(ctx: ProviderContainerContext): string {
  return path.join(GROUPS_DIR, requiredAgentGroupFolder(ctx), 'codex');
}

function codexOneCliConfigPath(ctx: ProviderContainerContext): string {
  return (
    ctx.containerConfig?.codex?.onecliConfigPath ?? path.join(codexGroupDir(ctx), 'onecli-codex-container-config.json')
  );
}

function codexBrokerSocket(ctx: ProviderContainerContext): string {
  return ctx.containerConfig?.codex?.brokerSocket ?? `/run/nanoclaw-runtime-broker/${ctx.agentGroupId}.sock`;
}

function codexBrokerTarget(ctx: ProviderContainerContext): string {
  return ctx.containerConfig?.codex?.brokerTarget ?? ctx.agentGroupId;
}

function codexAuthGateHost(ctx: ProviderContainerContext): string {
  return ctx.containerConfig?.codex?.authGateHost ?? authGateHostFromEnv(ctx.hostEnv);
}

function codexAuthGatePort(ctx: ProviderContainerContext): string {
  return String(ctx.containerConfig?.codex?.authGatePort ?? authGatePortFromEnv(ctx.hostEnv));
}

export const codexHostContainerFactory = (ctx: ProviderContainerContext) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const nativeConfig = readNativeCodexOneCliConfig(codexOneCliConfigPath(ctx), ctx.hostEnv, ctx.agentGroupId);

  // Ask the per-group broker socket for a short-lived access token. The broker
  // owns the single refresh token and refreshes centrally; this container
  // NEVER receives the refresh token. Synchronous: the container-
  // config factory contract is sync, so we block on a node subprocess that does
  // the newline-delimited-JSON socket round-trip and prints the response.
  const socketPath = codexBrokerSocket(ctx);
  const res = fetchCodexCredentialSync(socketPath, codexBrokerTarget(ctx));
  if (!res?.ok) throw new Error(`codex credential broker denied: ${res?.error ?? 'unknown'}`);

  // LAST-BOUNDARY ENFORCEMENT — TWO independent layers at the container edge,
  // because the broker response is NOT to be trusted blindly:
  //
  // (1) TRIPWIRE: fail closed if the broker response carries ANY secret that must
  //     never reach a container — a non-empty `refresh_token` (the rotating
  //     crown-jewel) OR a non-empty raw provider key (`*_api_key`, e.g.
  //     `OPENAI_API_KEY`). This THROWS so a buggy/compromised broker is surfaced
  //     loudly (and the malicious-broker test asserts the throw), rather than
  //     silently dropped. Empty-string / null placeholders are allowed.
  assertNoContainerForbiddenSecretsDeep(res.store);
  //
  // (2) ALLOWLIST RECONSTRUCTION: do NOT write `res.store` verbatim. Build the
  //     mounted store from an explicit allowlist of ONLY the fields codex needs:
  //     the access token (bearer-auth), the id_token (REQUIRED by codex's
  //     auth.json parser), and the non-secret account id. This makes it
  //     STRUCTURALLY impossible for ANY unexpected field in the broker response
  //     (OPENAI_API_KEY, refresh_token, future schema additions) to land in
  //     /home/node/.codex — independent of what the denylist tripwire enumerates.
  const rs = res.store as
    | { tokens?: Record<string, unknown>; auth_mode?: unknown; last_refresh?: unknown }
    | null
    | undefined;
  const bt = rs?.tokens ?? {};
  const safeStore = {
    // PRESERVE auth_mode from the source (default 'chatgpt') — identical to C2's
    // accessTokenOnlyStore (`store?.auth_mode ?? 'chatgpt'`) and the C1/F8 python
    // (`a.get("auth_mode","chatgpt")`), so the canonical safe-store shape is the
    // SAME across validator, CLI helper, host allowlist, and hand-placement.
    auth_mode: typeof rs?.auth_mode === 'string' ? rs.auth_mode : 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: bt.access_token,
      // codex-cli REQUIRES id_token to deserialize auth.json (it exits with
      // `missing field id_token` otherwise). It is an identity assertion, not a
      // refresh capability — admitting it keeps the crown-jewel invariant.
      ...(bt.id_token != null ? { id_token: bt.id_token } : {}),
      // codex-cli ALSO requires a refresh_token FIELD to parse the store, but the
      // real one must NEVER enter a container. Hard-code an EMPTY placeholder
      // (never copied from the broker response): it satisfies codex's parser and
      // is inert (the ~10-day access TTL means codex never refreshes in-container).
      refresh_token: '',
      ...(bt.account_id != null ? { account_id: bt.account_id } : {}),
    },
    last_refresh: rs?.last_refresh ?? null,
  };
  if (!safeStore.tokens.access_token) throw new Error('codex credential broker returned no access token');

  // Write the reconstructed store into the writable .codex dir. codex-cli opens
  // auth.json READ-WRITE at app-server startup (it persists rotated tokens), so a
  // read-only file makes the app-server abort with
  // `failed to initialize ... Permission denied`. The file is mode 0o666 so the
  // container's node user can open it O_RDWR regardless of the host->container uid
  // mapping. This is SAFE: this auth.json is a per-session, EPHEMERAL copy holding
  // only the short-lived access token + identity id_token + an EMPTY refresh
  // placeholder — never the shared master store or the real refresh token (those
  // live host-side in the broker). A container writing to its own session copy
  // cannot mint new credentials or affect any other bot. (The host sessionDir is
  // itself access-controlled, so 0o666 here is in-container scope only.)
  const authPath = path.join(codexDir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify(safeStore));
  fs.chmodSync(authPath, 0o666); // explicit: defeat a restrictive runtime umask

  // CREDENTIAL BOUNDARY: deliberately do NOT forward `OPENAI_API_KEY` (or any
  // raw model-provider key) into the container. Codex authenticates *only* via
  // the brokered, access-token-only `auth.json` written above (ChatGPT-OAuth,
  // the Pro subscription). Forwarding a raw `OPENAI_API_KEY` would (a) violate
  // "no raw model-provider keys in team containers" and (b) actively flip Codex
  // out of ChatGPT-OAuth mode into API-key billing — both wrong. Only non-secret
  // *config* (model id, base URL, reasoning effort, timeouts) is passed through.
  const model = ctx.containerConfig?.model ?? ctx.groupModel ?? ctx.hostEnv.CODEX_MODEL ?? 'gpt-5.5';
  const reasoningEffort =
    ctx.containerConfig?.reasoningEffort ?? ctx.groupReasoningEffort ?? ctx.hostEnv.CODEX_REASONING_EFFORT ?? 'high';
  const env: Record<string, string> = {
    CODEX_MODEL: model,
    CODEX_REASONING_EFFORT: reasoningEffort,
  };
  for (const key of [
    'OPENAI_BASE_URL',
    'CODEX_TRANSPORT_TIMEOUT_MS',
    'CODEX_ABSOLUTE_TURN_TIMEOUT_MS',
    'CODEX_INACTIVITY_NOTICE_MS',
    'CODEX_INACTIVITY_THROTTLE_MS',
  ] as const) {
    const v = ctx.hostEnv[key];
    if (v) env[key] = v;
  }

  const mounts = [
    // The .codex dir is mounted WRITABLE and CONTAINS auth.json. The in-container
    // provider rewrites config.toml here every turn, and codex-cli opens auth.json
    // read-write at startup — so auth.json must NOT be a read-only single-file
    // mount (that aborts the app-server). Security is preserved by WHAT is in the
    // file (access-token-only + empty refresh placeholder, a disposable per-session
    // copy), not by a read-only mount: the shared master + real refresh token never
    // leave the host. See the auth.json write above for the full rationale.
    { hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false },
  ];

  // AUTH-GATED ONECLI EGRESS: a Codex container cannot spawn without an
  // auth-gate proxy + placeholder credential contribution. Read the
  // per-group native config, inject the scoped token, and add the CA mount + CA
  // env so the Rust codex binary trusts the MITM gateway. No model-provider key
  // is injected; Codex carries its own brokered bearer to chatgpt.com, which
  // matches no gateway secret and passes through untouched.
  Object.assign(env, nativeConfig.env, buildCodexAuthGatedProxyEnv(nativeConfig, ctx.hostEnv), {
    // Local MCP servers / app-server IPC must bypass the proxy.
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
    YENTE_CODEX_ONECLI_NATIVE: '1',
    YENTE_CODEX_ONECLI_AGENT_IDENTIFIER: nativeConfig.onecliAgentIdentifier,
    ONECLI_GATEWAY_AUTH_GATE_HOST_ALIAS: nativeConfig.onecliAuthGateHost || codexAuthGateHost(ctx),
    ONECLI_GATEWAY_AUTH_GATE_PORT: String(nativeConfig.onecliAuthGatePort || codexAuthGatePort(ctx)),
  });
  for (const mount of nativeConfig.mounts) mounts.push(mount);

  // Defense-in-depth: codex authenticates ONLY via the brokered auth.json. A raw
  // OPENAI_API_KEY would breach the credential boundary AND flip codex into
  // API-key billing. The native-config allowlist already rejects it; delete here
  // too so it can never ride into the container via any path.
  delete (env as Record<string, string>).OPENAI_API_KEY;

  return { mounts, env, extraHosts: [codexAuthGateHost(ctx)] };
};
registerProviderContainerConfig('codex', codexHostContainerFactory);
