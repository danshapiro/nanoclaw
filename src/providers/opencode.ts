import { registerProviderContainerConfig } from './provider-container-registry.js';
import { requireYenteHostEnv, YENTE_LOCAL_PROXY_HOSTNAMES } from '../yente/service-env.js';

registerProviderContainerConfig('opencode', ({ hostEnv }) => {
  const yente = requireYenteHostEnv(hostEnv);
  return {
    env: {
      ...yente.containerEnv,
      OPENCODE_PROVIDER: hostEnv.OPENCODE_PROVIDER ?? 'opencode-go',
      OPENCODE_MODEL: hostEnv.OPENCODE_MODEL ?? 'opencode-go/deepseek-v4-pro',
      OPENCODE_SMALL_MODEL: hostEnv.OPENCODE_SMALL_MODEL ?? 'opencode-go/deepseek-v4-flash',
      ANTHROPIC_BASE_URL: hostEnv.ANTHROPIC_BASE_URL ?? 'https://opencode.ai/zen/v1',
    },
    extraHosts: YENTE_LOCAL_PROXY_HOSTNAMES,
  };
});
