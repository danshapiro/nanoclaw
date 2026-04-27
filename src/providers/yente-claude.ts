import { registerProviderContainerConfig } from './provider-container-registry.js';
import { requireYenteHostEnv, YENTE_LOCAL_PROXY_HOSTNAMES } from '../yente/service-env.js';

registerProviderContainerConfig('claude', ({ hostEnv }) => ({
  env: requireYenteHostEnv(hostEnv).containerEnv,
  extraHosts: YENTE_LOCAL_PROXY_HOSTNAMES,
}));
