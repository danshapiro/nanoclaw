import { describe, expect, it } from 'vitest';

import './yente-claude.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

describe('Yente Claude provider container config', () => {
  it('forwards non-secret local service URLs and host aliases into Claude containers', () => {
    const config = getProviderContainerConfig('claude');

    expect(config).toBeDefined();
    const contribution = config!({
      sessionDir: '/tmp/nanoclaw-session',
      agentGroupId: 'ag-main',
      hostEnv: {
        ONECLI_URL: 'http://onecli.local',
        ONECLI_API_KEY: 'secret',
        ONECLI_GATEWAY_URL: 'http://onecli-gateway.local',
        GWS_PROXY_URL: 'http://yente-gws-proxy.local:8083',
        MSGVAULT_PROXY_URL: 'http://yente-msgvault-proxy.local:8084',
        FAMILIAR_PROXY_URL: 'http://yente-familiar-proxy.local:8081',
        NYNE_PROXY_URL: 'http://yente-nyne-proxy.local:8082',
        YENTE_BROWSER_HANDOFF_URL: 'http://yente-browser-handoff.local:6081',
        YENTE_BROWSER_HANDOFF_BROKER_SECRET: 'raw-broker-secret',
        YENTE_BROWSER_HANDOFF_VNC_PASSWORD: 'raw-vnc-password',
      },
    });

    expect(contribution.env?.YENTE_BROWSER_HANDOFF_URL).toBe('http://yente-browser-handoff.local:6081');
    expect(contribution.env).not.toHaveProperty('YENTE_BROWSER_HANDOFF_BROKER_SECRET');
    expect(contribution.env).not.toHaveProperty('YENTE_BROWSER_HANDOFF_VNC_PASSWORD');
    expect(contribution.extraHosts).toEqual(
      expect.arrayContaining(['yente-gws-proxy.local', 'yente-browser-handoff.local']),
    );
  });
});
