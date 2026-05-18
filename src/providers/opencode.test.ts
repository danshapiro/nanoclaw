import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import './opencode.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

describe('opencode provider container config', () => {
  it('persists OpenCode XDG data beside the durable NanoClaw session', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-session-'));
    try {
      const config = getProviderContainerConfig('opencode');

      expect(config).toBeDefined();
      const contribution = config!({
        sessionDir,
        agentGroupId: 'ag-discord-yente-dvora',
        hostEnv: {
          ONECLI_URL: 'http://onecli.local',
          ONECLI_API_KEY: 'secret',
          ONECLI_GATEWAY_URL: 'http://onecli-gateway.local',
          GWS_PROXY_URL: 'http://yente-gws-proxy.local:8083',
          MSGVAULT_PROXY_URL: 'http://yente-msgvault-proxy.local:8084',
          FAMILIAR_PROXY_URL: 'http://yente-familiar-proxy.local:8081',
          NYNE_PROXY_URL: 'http://yente-nyne-proxy.local:8082',
        },
      });

      const opencodeXdgDir = path.join(sessionDir, 'opencode-xdg');
      expect(fs.statSync(opencodeXdgDir).isDirectory()).toBe(true);
      expect(contribution.env?.XDG_DATA_HOME).toBe('/opencode-xdg');
      expect(contribution.env?.GWS_PROXY_URL).toBe('http://yente-gws-proxy.local:8083');
      expect(contribution.extraHosts).toContain('yente-gws-proxy.local');
      expect(contribution.mounts).toContainEqual({
        hostPath: opencodeXdgDir,
        containerPath: '/opencode-xdg',
        readonly: false,
      });
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
