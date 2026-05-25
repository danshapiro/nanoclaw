import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';
import { requireYenteHostEnv, YENTE_LOCAL_PROXY_HOSTNAMES } from '../yente/service-env.js';

const OPENCODE_ONECLI_PLACEHOLDER = 'onecli-managed';

const OPENCODE_HOST_ENV_KEYS = [
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'ONECLI_GATEWAY_URL',
  'GWS_PROXY_URL',
  'MSGVAULT_PROXY_URL',
  'FAMILIAR_PROXY_URL',
  'NYNE_PROXY_URL',
  'NO_PROXY',
  'no_proxy',
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
] as const;

registerProviderContainerConfig('opencode', ({ hostEnv, sessionDir }) => {
  const mergedHostEnv = { ...readEnvFile([...OPENCODE_HOST_ENV_KEYS]), ...hostEnv };
  const yente = requireYenteHostEnv(mergedHostEnv);
  const opencodeXdgDir = path.join(sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeXdgDir, { recursive: true });

  return {
    mounts: [
      {
        hostPath: opencodeXdgDir,
        containerPath: '/opencode-xdg',
        readonly: false,
      },
    ],
    env: {
      ...yente.containerEnv,
      // OpenCode continuation IDs are pointers into OpenCode's local DB,
      // not self-contained remote thread IDs. NanoClaw persists those IDs in
      // outbound.db across `docker run --rm` container lifetimes, so the DB
      // they point at must live in the durable per-session host directory.
      // Without this XDG_DATA_HOME mount, a resumed continuation can only
      // point at state that was deleted with a previous container filesystem.
      XDG_DATA_HOME: '/opencode-xdg',
      OPENCODE_PROVIDER: mergedHostEnv.OPENCODE_PROVIDER ?? 'opencode-go',
      OPENCODE_MODEL: mergedHostEnv.OPENCODE_MODEL ?? 'opencode-go/deepseek-v4-pro',
      OPENCODE_SMALL_MODEL: mergedHostEnv.OPENCODE_SMALL_MODEL ?? 'opencode-go/deepseek-v4-flash',
      OPENCODE_API_KEY: OPENCODE_ONECLI_PLACEHOLDER,
    },
    extraHosts: YENTE_LOCAL_PROXY_HOSTNAMES,
  };
});
