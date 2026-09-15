export const YENTE_LOCAL_PROXY_HOSTS = {
  gws: 'yente-gws-proxy.local',
  msgvault: 'yente-msgvault-proxy.local',
  familiar: 'yente-familiar-proxy.local',
  nyne: 'yente-nyne-proxy.local',
  browserHandoff: 'yente-browser-handoff.local',
} as const;
export const YENTE_LOCAL_PROXY_HOSTNAMES = Object.values(YENTE_LOCAL_PROXY_HOSTS);
export const YENTE_BROWSER_HANDOFF_PRODUCTION_URL = `http://${YENTE_LOCAL_PROXY_HOSTS.browserHandoff}:6081`;
export const YENTE_PLAYWRITER_PRODUCTION_HOST = 'http://172.17.0.1:19988';
export const YENTE_PLAYWRITER_AUTO_ENABLE = 'false';

export const REQUIRED_YENTE_PROXY_URLS = [
  { service: 'gws', urlEnv: 'GWS_PROXY_URL', apiUrlEnv: undefined, compatibilityKeyEnv: undefined },
  { service: 'msgvault', urlEnv: 'MSGVAULT_PROXY_URL', apiUrlEnv: 'MSGVAULT_API_URL', compatibilityKeyEnv: undefined },
  { service: 'familiar', urlEnv: 'FAMILIAR_PROXY_URL', apiUrlEnv: 'FAMILIAR_API_URL', compatibilityKeyEnv: undefined },
  { service: 'nyne', urlEnv: 'NYNE_PROXY_URL', apiUrlEnv: 'NYNE_API_URL', compatibilityKeyEnv: undefined },
  {
    service: 'browserHandoff',
    urlEnv: 'YENTE_BROWSER_HANDOFF_URL',
    apiUrlEnv: undefined,
    compatibilityKeyEnv: undefined,
  },
] as const satisfies readonly {
  service: 'gws' | 'msgvault' | 'familiar' | 'nyne' | 'browserHandoff';
  urlEnv: string;
  apiUrlEnv?: string;
  compatibilityKeyEnv?: string;
}[];

export const REQUIRED_YENTE_ONECLI_SECRET_NAMES = [
  'Yente GWS Proxy',
  'Yente Msgvault Proxy',
  'Yente Browser Handoff',
  'NanoClaw Anthropic',
  'NanoClaw OpenAI Images',
  'NanoClaw Gemini',
  'NanoClaw OpenCode Go',
  'NanoClaw OpenCode Go Messages',
  'AssemblyAI',
  'Vercel',
] as const;

// Optional research/browser capability records. Unlike REQUIRED, these are
// granted when they exist in the vault and skipped (no error) when they do
// not — a deployment may legitimately run without any of them. Auto-granting
// them at spawn keeps newly registered groups from silently missing the
// enrichment pool (the 2026-09-14 threaded/dev 401s); manual one-off grant
// waves are no longer the only delivery path.
export const OPTIONAL_YENTE_ONECLI_SECRET_NAMES = ['Tavily', 'Exa', 'Firecrawl', 'Browser Use'] as const;
export const ONECLI_MANAGED_PLACEHOLDER = 'onecli-managed';
function requireEnvValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required ${key}; configure Yente host credentials before starting agent containers.`);
  }
  return value;
}

export function requireYenteHostEnv(env: NodeJS.ProcessEnv): {
  onecliUrl: string;
  onecliApiKey: string;
  containerEnv: Record<string, string>;
} {
  const onecliUrl = requireEnvValue(env, 'ONECLI_URL');
  const onecliApiKey = requireEnvValue(env, 'ONECLI_API_KEY');
  requireEnvValue(env, 'ONECLI_GATEWAY_URL');
  const playwriterHost = env.PLAYWRITER_HOST?.trim() || YENTE_PLAYWRITER_PRODUCTION_HOST;
  if (playwriterHost !== YENTE_PLAYWRITER_PRODUCTION_HOST) {
    throw new Error(`PLAYWRITER_HOST must be exactly ${YENTE_PLAYWRITER_PRODUCTION_HOST}.`);
  }
  const playwriterAutoEnable = env.PLAYWRITER_AUTO_ENABLE?.trim() || YENTE_PLAYWRITER_AUTO_ENABLE;
  if (playwriterAutoEnable !== YENTE_PLAYWRITER_AUTO_ENABLE) {
    throw new Error(`PLAYWRITER_AUTO_ENABLE must be exactly ${YENTE_PLAYWRITER_AUTO_ENABLE}.`);
  }
  const containerEnv: Record<string, string> = {
    PLAYWRITER_HOST: playwriterHost,
    PLAYWRITER_AUTO_ENABLE: playwriterAutoEnable,
  };

  for (const entry of REQUIRED_YENTE_PROXY_URLS) {
    const url = requireEnvValue(env, entry.urlEnv);
    containerEnv[entry.urlEnv] = url;
    if (entry.apiUrlEnv) {
      containerEnv[entry.apiUrlEnv] = url;
    }
    if (entry.compatibilityKeyEnv) {
      containerEnv[entry.compatibilityKeyEnv] = ONECLI_MANAGED_PLACEHOLDER;
    }
  }
  containerEnv.NO_PROXY = buildNoProxy(env);
  containerEnv.no_proxy = containerEnv.NO_PROXY;

  return { onecliUrl, onecliApiKey, containerEnv };
}

export function buildNoProxy(env: NodeJS.ProcessEnv): string {
  const entries = new Set([
    'localhost',
    '127.0.0.1',
    // Public registries that don't need MITM credential injection.
    // Bypassing the proxy prevents fd exhaustion from large concurrent
    // npm installs during agent-container startup surges.
    'registry.npmjs.org',
    // Host-service alias documented in skills (e.g. yente-history-reader on
    // host.docker.internal:8086). The auth-gate proxy cannot reach host
    // services, so requests must go direct over the bridge.
    'host.docker.internal',
    // Playwriter's fixed host proxy injects the relay bearer itself; requests
    // must reach it directly rather than traverse the OneCLI gateway.
    '172.17.0.1',
    '172.17.0.1:19988',
  ]);
  const mediatedHosts = new Set<string>();
  for (const entry of REQUIRED_YENTE_PROXY_URLS) {
    const url = env[entry.urlEnv]?.trim();
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.hostname) {
        mediatedHosts.add(parsed.hostname);
        if (parsed.port) mediatedHosts.add(`${parsed.hostname}:${parsed.port}`);
      }
    } catch (err) {
      throw new Error(`Invalid ${entry.urlEnv}; configure it as a full URL for the mediated local proxy.`, {
        cause: err,
      });
    }
  }
  const existing = env.NO_PROXY ?? env.no_proxy;
  if (existing) {
    for (const entry of existing.split(',')) {
      const trimmed = entry.trim();
      if (trimmed && !mediatedHosts.has(trimmed)) entries.add(trimmed);
    }
  }
  return [...entries].join(',');
}

export function assertOneCliApplied(applied: boolean): void {
  if (!applied) {
    throw new Error('OneCLI gateway did not apply container credentials; refusing to start Yente container.');
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function readJson<T>(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    // Attach statusCode so callers (container-runner retry) can distinguish
    // retryable 5xx from non-retryable 4xx without parsing message text.
    const error = new Error(`OneCLI request failed for ${url}: HTTP ${response.status}`) as Error & {
      statusCode: number;
    };
    error.statusCode = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

export async function ensureOneCliAgentSecretAccess(options: {
  onecliUrl: string;
  onecliApiKey: string;
  onecliGatewayUrl?: string;
  agentIdentifier: string;
  secretNames?: readonly string[];
  optionalSecretNames?: readonly string[];
  fetchImpl?: FetchLike;
}): Promise<void> {
  const onecliUrl = options.onecliUrl.replace(/\/+$/, '');
  const onecliGatewayUrl = options.onecliGatewayUrl ?? process.env.ONECLI_GATEWAY_URL?.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const secretNames = options.secretNames ?? REQUIRED_YENTE_ONECLI_SECRET_NAMES;
  const optionalSecretNames = options.optionalSecretNames ?? OPTIONAL_YENTE_ONECLI_SECRET_NAMES;
  const headers = {
    Authorization: `Bearer ${options.onecliApiKey}`,
    'Content-Type': 'application/json',
  };

  if (!options.agentIdentifier) {
    throw new Error('OneCLI agent identifier is required before applying Yente local proxy credentials.');
  }

  const [secrets, agents] = await Promise.all([
    readJson<{ id: string; name: string }[]>(fetchImpl, `${onecliUrl}/api/secrets`, { headers }),
    readJson<{ id: string; identifier: string | null }[]>(fetchImpl, `${onecliUrl}/api/agents`, { headers }),
  ]);

  const requiredSecrets = secretNames.map((name) => secrets.find((secret) => secret.name === name));
  const missingSecrets = secretNames.filter((_, index) => !requiredSecrets[index]);
  if (missingSecrets.length > 0) {
    throw new Error(
      `Missing OneCLI secret(s): ${missingSecrets.join(', ')}; configure Yente local proxy credentials in OneCLI before starting agent containers.`,
    );
  }

  // Optional records are granted only when they exist; an absent optional
  // record is a normal deployment state, never an error.
  const optionalIds = optionalSecretNames.flatMap((name) => {
    const secret = secrets.find((candidate) => candidate.name === name);
    return secret ? [secret.id] : [];
  });

  const agent = agents.find((candidate) => candidate.identifier === options.agentIdentifier);
  if (!agent) {
    throw new Error(`OneCLI agent ${options.agentIdentifier} was not found after ensureAgent.`);
  }

  const existingIds = await readJson<string[]>(fetchImpl, `${onecliUrl}/api/agents/${agent.id}/secrets`, { headers });
  const requiredIds = requiredSecrets.map((secret) => {
    if (!secret) throw new Error('internal error: required OneCLI secret lookup unexpectedly failed');
    return secret.id;
  });
  const desiredIds = [...new Set([...existingIds, ...requiredIds, ...optionalIds])];
  if (desiredIds.length === existingIds.length && desiredIds.every((id) => existingIds.includes(id))) {
    return;
  }
  if (!onecliGatewayUrl) {
    throw new Error('Missing required ONECLI_GATEWAY_URL; cannot invalidate OneCLI gateway credential cache.');
  }

  await readJson(fetchImpl, `${onecliUrl}/api/agents/${agent.id}/secrets`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ secretIds: desiredIds }),
  });

  await readJson(fetchImpl, `${onecliGatewayUrl}/api/cache/invalidate`, {
    method: 'POST',
    headers,
  });
}
