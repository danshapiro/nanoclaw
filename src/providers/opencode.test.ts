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

  it('loads OpenCode and proxy host env from the release .env when systemd does not export it', () => {
    const cwd = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-env-'));
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, '.env'),
      [
        'ONECLI_URL=http://onecli.local',
        'ONECLI_API_KEY=secret',
        'ONECLI_GATEWAY_URL=http://onecli-gateway.local',
        'GWS_PROXY_URL=http://yente-gws-proxy.local:8083',
        'MSGVAULT_PROXY_URL=http://yente-msgvault-proxy.local:8084',
        'FAMILIAR_PROXY_URL=http://yente-familiar-proxy.local:8081',
        'NYNE_PROXY_URL=http://yente-nyne-proxy.local:8082',
        'OPENCODE_PROVIDER=opencode-go',
        'OPENCODE_MODEL=opencode-go/test-model',
        'OPENCODE_SMALL_MODEL=opencode-go/test-small',
        'OPENCODE_VISION_MODEL=opencode-go/test-vision',
        'OPENCODE_API_KEY=opencode-secret',
        '',
      ].join('\n'),
    );

    try {
      process.chdir(root);
      const config = getProviderContainerConfig('opencode');
      const contribution = config!({
        sessionDir,
        agentGroupId: 'ag-main',
        hostEnv: {},
      });

      expect(contribution.env?.GWS_PROXY_URL).toBe('http://yente-gws-proxy.local:8083');
      expect(contribution.env?.OPENCODE_PROVIDER).toBe('opencode-go');
      expect(contribution.env?.OPENCODE_MODEL).toBe('opencode-go/test-model');
      expect(contribution.env?.OPENCODE_SMALL_MODEL).toBe('opencode-go/test-small');
      expect(contribution.env?.OPENCODE_VISION_MODEL).toBe('opencode-go/test-vision');
      expect(contribution.env?.OPENCODE_API_KEY).toBe('onecli-managed');
      expect(contribution.env?.OPENCODE_API_KEY).not.toBe('opencode-secret');
    } finally {
      process.chdir(cwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not pass a raw OpenCode API key from host env into the container', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-session-'));
    try {
      const config = getProviderContainerConfig('opencode');

      expect(config).toBeDefined();
      const contribution = config!({
        sessionDir,
        agentGroupId: 'ag-discord-yente-dvora',
        hostEnv: {
          ONECLI_URL: 'http://onecli.local',
          ONECLI_API_KEY: 'onecli-service-key',
          ONECLI_GATEWAY_URL: 'http://onecli-gateway.local',
          GWS_PROXY_URL: 'http://yente-gws-proxy.local:8083',
          MSGVAULT_PROXY_URL: 'http://yente-msgvault-proxy.local:8084',
          FAMILIAR_PROXY_URL: 'http://yente-familiar-proxy.local:8081',
          NYNE_PROXY_URL: 'http://yente-nyne-proxy.local:8082',
          OPENCODE_PROVIDER: 'opencode-go',
          OPENCODE_MODEL: 'opencode-go/deepseek-v4-pro',
          OPENCODE_SMALL_MODEL: 'opencode-go/deepseek-v4-flash',
          OPENCODE_VISION_MODEL: 'opencode-go/qwen3.6-plus',
          OPENCODE_API_KEY: 'raw-live-opencode-key',
        },
      });

      expect(contribution.env?.OPENCODE_PROVIDER).toBe('opencode-go');
      expect(contribution.env?.OPENCODE_MODEL).toBe('opencode-go/deepseek-v4-pro');
      expect(contribution.env?.OPENCODE_SMALL_MODEL).toBe('opencode-go/deepseek-v4-flash');
      expect(contribution.env?.OPENCODE_VISION_MODEL).toBe('opencode-go/qwen3.6-plus');
      expect(contribution.env?.OPENCODE_API_KEY).toBe('onecli-managed');
      expect(contribution.env?.OPENCODE_API_KEY).not.toBe('raw-live-opencode-key');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('prefers groupModel over hostEnv OPENCODE_MODEL for per-group override', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-session-'));
    try {
      const config = getProviderContainerConfig('opencode');

      expect(config).toBeDefined();
      const contribution = config!({
        sessionDir,
        agentGroupId: 'ag-discord-yente-hinda',
        hostEnv: {
          ONECLI_URL: 'http://onecli.local',
          ONECLI_API_KEY: 'secret',
          ONECLI_GATEWAY_URL: 'http://onecli-gateway.local',
          GWS_PROXY_URL: 'http://yente-gws-proxy.local:8083',
          MSGVAULT_PROXY_URL: 'http://yente-msgvault-proxy.local:8084',
          FAMILIAR_PROXY_URL: 'http://yente-familiar-proxy.local:8081',
          NYNE_PROXY_URL: 'http://yente-nyne-proxy.local:8082',
          OPENCODE_MODEL: 'opencode-go/deepseek-v4-pro',
        },
        groupModel: 'opencode-go/deepseek-v4-flash',
      });

      expect(contribution.env?.OPENCODE_MODEL).toBe('opencode-go/deepseek-v4-flash');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('falls back to hostEnv OPENCODE_MODEL when groupModel is not set', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-session-'));
    try {
      const config = getProviderContainerConfig('opencode');

      expect(config).toBeDefined();
      const contribution = config!({
        sessionDir,
        agentGroupId: 'ag-discord-yente-hinda',
        hostEnv: {
          ONECLI_URL: 'http://onecli.local',
          ONECLI_API_KEY: 'secret',
          ONECLI_GATEWAY_URL: 'http://onecli-gateway.local',
          GWS_PROXY_URL: 'http://yente-gws-proxy.local:8083',
          MSGVAULT_PROXY_URL: 'http://yente-msgvault-proxy.local:8084',
          FAMILIAR_PROXY_URL: 'http://yente-familiar-proxy.local:8081',
          NYNE_PROXY_URL: 'http://yente-nyne-proxy.local:8082',
          OPENCODE_MODEL: 'opencode-go/deepseek-v4-pro',
        },
      });

      expect(contribution.env?.OPENCODE_MODEL).toBe('opencode-go/deepseek-v4-pro');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
