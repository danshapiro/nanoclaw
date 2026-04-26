export const REQUIRED_YENTE_PROXY_PAIRS = [
  { service: 'gws', urlEnv: 'GWS_PROXY_URL', keyEnv: 'GWS_PROXY_KEY' },
  { service: 'msgvault', urlEnv: 'MSGVAULT_PROXY_URL', keyEnv: 'MSGVAULT_PROXY_KEY' },
  { service: 'familiar', urlEnv: 'FAMILIAR_PROXY_URL', keyEnv: 'FAMILIAR_PROXY_KEY' },
  { service: 'nyne', urlEnv: 'NYNE_PROXY_URL', keyEnv: 'NYNE_PROXY_KEY' },
] as const satisfies readonly {
  service: 'gws' | 'msgvault' | 'familiar' | 'nyne';
  urlEnv: string;
  keyEnv: string;
}[];

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
  const containerEnv: Record<string, string> = {};

  for (const pair of REQUIRED_YENTE_PROXY_PAIRS) {
    containerEnv[pair.urlEnv] = requireEnvValue(env, pair.urlEnv);
    containerEnv[pair.keyEnv] = requireEnvValue(env, pair.keyEnv);
  }
  containerEnv.NO_PROXY = buildNoProxy(env);

  return { onecliUrl, onecliApiKey, containerEnv };
}

export function buildNoProxy(env: NodeJS.ProcessEnv): string {
  const entries = new Set(['localhost', '127.0.0.1', 'host.docker.internal', '172.17.0.1']);
  for (const pair of REQUIRED_YENTE_PROXY_PAIRS) {
    const url = env[pair.urlEnv]?.trim();
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.hostname) entries.add(parsed.hostname);
    } catch (err) {
      throw new Error(`Invalid ${pair.urlEnv}; configure it as a full URL for the mediated local proxy.`, {
        cause: err,
      });
    }
  }
  const existing = env.NO_PROXY ?? env.no_proxy;
  if (existing) {
    for (const entry of existing.split(',')) {
      const trimmed = entry.trim();
      if (trimmed) entries.add(trimmed);
    }
  }
  return [...entries].join(',');
}

export function assertOneCliApplied(applied: boolean): void {
  if (!applied) {
    throw new Error('OneCLI gateway did not apply container credentials; refusing to start Yente container.');
  }
}
