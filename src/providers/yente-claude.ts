import { registerProviderContainerConfig } from './provider-container-registry.js';
import { readEnvFile } from '../env.js';
import { requireYenteHostEnv, YENTE_LOCAL_PROXY_HOSTNAMES } from '../yente/service-env.js';

const YENTE_HOST_ENV_KEYS = [
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'ONECLI_GATEWAY_URL',
  'GWS_PROXY_URL',
  'MSGVAULT_PROXY_URL',
  'FAMILIAR_PROXY_URL',
  'NYNE_PROXY_URL',
  'YENTE_BROWSER_HANDOFF_URL',
  'NO_PROXY',
  'no_proxy',
] as const;

registerProviderContainerConfig('claude', ({ hostEnv }) => {
  const mergedHostEnv = { ...readEnvFile([...YENTE_HOST_ENV_KEYS]), ...hostEnv };
  return {
    env: requireYenteHostEnv(mergedHostEnv).containerEnv,
    extraHosts: YENTE_LOCAL_PROXY_HOSTNAMES,
  };
});
