import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';
import { requireYenteHostEnv, YENTE_LOCAL_PROXY_HOSTNAMES } from '../yente/service-env.js';

registerProviderContainerConfig('opencode', ({ hostEnv, sessionDir }) => {
  const yente = requireYenteHostEnv(hostEnv);
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
      OPENCODE_PROVIDER: hostEnv.OPENCODE_PROVIDER ?? 'opencode-go',
      OPENCODE_MODEL: hostEnv.OPENCODE_MODEL ?? 'opencode-go/deepseek-v4-pro',
      OPENCODE_SMALL_MODEL: hostEnv.OPENCODE_SMALL_MODEL ?? 'opencode-go/deepseek-v4-flash',
      OPENCODE_API_KEY: hostEnv.OPENCODE_API_KEY ?? '',
    },
    extraHosts: YENTE_LOCAL_PROXY_HOSTNAMES,
  };
});
