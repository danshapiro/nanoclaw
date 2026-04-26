import { describe, expect, it } from 'vitest';

import { assertOneCliApplied, buildNoProxy, REQUIRED_YENTE_PROXY_PAIRS, requireYenteHostEnv } from './service-env.js';

const COMPLETE_ENV: NodeJS.ProcessEnv = {
  ONECLI_URL: 'https://onecli.local',
  ONECLI_API_KEY: 'onecli-key',
  GWS_PROXY_URL: 'http://gws-proxy:8080',
  GWS_PROXY_KEY: 'gws-proxy-key',
  MSGVAULT_PROXY_URL: 'http://msgvault-proxy:8080',
  MSGVAULT_PROXY_KEY: 'msgvault-proxy-key',
  FAMILIAR_PROXY_URL: 'http://familiar-proxy:8080',
  FAMILIAR_PROXY_KEY: 'familiar-proxy-key',
  NYNE_PROXY_URL: 'http://nyne-proxy:8080',
  NYNE_PROXY_KEY: 'nyne-proxy-key',
};

describe('Yente service env contract', () => {
  it('requires OneCLI host credentials', () => {
    expect(() => requireYenteHostEnv({ ...COMPLETE_ENV, ONECLI_URL: '' })).toThrow('Missing required ONECLI_URL');
    expect(() => requireYenteHostEnv({ ...COMPLETE_ENV, ONECLI_API_KEY: undefined })).toThrow(
      'Missing required ONECLI_API_KEY',
    );
  });

  it('requires every mediated local service proxy URL/key pair', () => {
    expect(REQUIRED_YENTE_PROXY_PAIRS.map((pair) => pair.service)).toEqual(['gws', 'msgvault', 'familiar', 'nyne']);

    for (const pair of REQUIRED_YENTE_PROXY_PAIRS) {
      expect(() => requireYenteHostEnv({ ...COMPLETE_ENV, [pair.urlEnv]: '' })).toThrow(
        `Missing required ${pair.urlEnv}`,
      );
      expect(() => requireYenteHostEnv({ ...COMPLETE_ENV, [pair.keyEnv]: undefined })).toThrow(
        `Missing required ${pair.keyEnv}`,
      );
    }
  });

  it('passes only the explicit Yente proxy env contract into containers', () => {
    const result = requireYenteHostEnv({
      ...COMPLETE_ENV,
      GOOGLE_APPLICATION_CREDENTIALS: '/secret/raw-google.json',
      ANTHROPIC_API_KEY: 'raw-provider-key',
    });

    expect(result.onecliUrl).toBe('https://onecli.local');
    expect(result.onecliApiKey).toBe('onecli-key');
    expect(result.containerEnv).toMatchObject({
      GWS_PROXY_URL: 'http://gws-proxy:8080',
      GWS_PROXY_KEY: 'gws-proxy-key',
      MSGVAULT_PROXY_URL: 'http://msgvault-proxy:8080',
      MSGVAULT_PROXY_KEY: 'msgvault-proxy-key',
      FAMILIAR_PROXY_URL: 'http://familiar-proxy:8080',
      FAMILIAR_PROXY_KEY: 'familiar-proxy-key',
      NYNE_PROXY_URL: 'http://nyne-proxy:8080',
      NYNE_PROXY_KEY: 'nyne-proxy-key',
    });
    expect(result.containerEnv).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    expect(result.containerEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('builds NO_PROXY for localhost, Docker gateway, and local service hosts', () => {
    expect(buildNoProxy(COMPLETE_ENV).split(',')).toEqual(
      expect.arrayContaining([
        'localhost',
        '127.0.0.1',
        'host.docker.internal',
        '172.17.0.1',
        'gws-proxy',
        'msgvault-proxy',
        'familiar-proxy',
        'nyne-proxy',
      ]),
    );
  });

  it('throws when OneCLI reports that gateway config was not applied', () => {
    expect(() => assertOneCliApplied(false)).toThrow(
      'OneCLI gateway did not apply container credentials; refusing to start Yente container.',
    );
    expect(() => assertOneCliApplied(true)).not.toThrow();
  });
});
