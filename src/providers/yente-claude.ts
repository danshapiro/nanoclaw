import { registerProviderContainerConfig } from './provider-container-registry.js';
import { requireYenteHostEnv } from '../yente/service-env.js';

registerProviderContainerConfig('claude', ({ hostEnv }) => ({
  env: requireYenteHostEnv(hostEnv).containerEnv,
}));
