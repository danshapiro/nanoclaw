import { describe, expect, it } from 'vitest';

import {
  assertOneCliApplied,
  buildNoProxy,
  ensureOneCliAgentSecretAccess,
  REQUIRED_YENTE_PROXY_URLS,
  requireYenteHostEnv,
  YENTE_LOCAL_PROXY_HOSTS,
} from './service-env.js';

const COMPLETE_ENV: NodeJS.ProcessEnv = {
  ONECLI_URL: 'https://onecli.local',
  ONECLI_API_KEY: 'onecli-key',
  ONECLI_GATEWAY_URL: 'http://onecli-gateway.local',
  GWS_PROXY_URL: `http://${YENTE_LOCAL_PROXY_HOSTS.gws}:8083`,
  MSGVAULT_PROXY_URL: `http://${YENTE_LOCAL_PROXY_HOSTS.msgvault}:8084`,
  FAMILIAR_PROXY_URL: `http://${YENTE_LOCAL_PROXY_HOSTS.familiar}:8081`,
  NYNE_PROXY_URL: `http://${YENTE_LOCAL_PROXY_HOSTS.nyne}:8082`,
};

describe('Yente service env contract', () => {
  it('requires OneCLI host credentials', () => {
    expect(() => requireYenteHostEnv({ ...COMPLETE_ENV, ONECLI_URL: '' })).toThrow('Missing required ONECLI_URL');
    expect(() => requireYenteHostEnv({ ...COMPLETE_ENV, ONECLI_API_KEY: undefined })).toThrow(
      'Missing required ONECLI_API_KEY',
    );
    expect(() => requireYenteHostEnv({ ...COMPLETE_ENV, ONECLI_GATEWAY_URL: undefined })).toThrow(
      'Missing required ONECLI_GATEWAY_URL',
    );
  });

  it('requires every mediated local service URL', () => {
    expect(REQUIRED_YENTE_PROXY_URLS.map((entry) => entry.service)).toEqual(['gws', 'msgvault', 'familiar', 'nyne']);

    for (const entry of REQUIRED_YENTE_PROXY_URLS) {
      expect(() => requireYenteHostEnv({ ...COMPLETE_ENV, [entry.urlEnv]: '' })).toThrow(
        `Missing required ${entry.urlEnv}`,
      );
    }
  });

  it('passes only non-secret proxy URLs and placeholder compatibility env into containers', () => {
    const result = requireYenteHostEnv({
      ...COMPLETE_ENV,
      GOOGLE_APPLICATION_CREDENTIALS: '/secret/raw-google.json',
      ANTHROPIC_API_KEY: 'raw-provider-key',
      GWS_PROXY_KEY: 'raw-gws-proxy-key',
      MSGVAULT_PROXY_KEY: 'raw-msgvault-proxy-key',
      MSGVAULT_API_KEY: 'raw-msgvault-api-key',
    });

    expect(result.onecliUrl).toBe('https://onecli.local');
    expect(result.onecliApiKey).toBe('onecli-key');
    expect(result.containerEnv).toMatchObject({
      GWS_PROXY_URL: `http://${YENTE_LOCAL_PROXY_HOSTS.gws}:8083`,
      MSGVAULT_PROXY_URL: `http://${YENTE_LOCAL_PROXY_HOSTS.msgvault}:8084`,
      MSGVAULT_API_URL: `http://${YENTE_LOCAL_PROXY_HOSTS.msgvault}:8084`,
      FAMILIAR_PROXY_URL: `http://${YENTE_LOCAL_PROXY_HOSTS.familiar}:8081`,
      FAMILIAR_API_URL: `http://${YENTE_LOCAL_PROXY_HOSTS.familiar}:8081`,
      NYNE_PROXY_URL: `http://${YENTE_LOCAL_PROXY_HOSTS.nyne}:8082`,
      NYNE_API_URL: `http://${YENTE_LOCAL_PROXY_HOSTS.nyne}:8082`,
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
    });
    expect(result.containerEnv).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    expect(result.containerEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(result.containerEnv).not.toHaveProperty('GWS_PROXY_KEY');
    expect(result.containerEnv).not.toHaveProperty('MSGVAULT_PROXY_KEY');
    expect(result.containerEnv).not.toHaveProperty('MSGVAULT_API_KEY');
  });

  it('does not bypass OneCLI for mediated local service hosts', () => {
    const entries = buildNoProxy({
      ...COMPLETE_ENV,
      NO_PROXY: `localhost,127.0.0.1,${YENTE_LOCAL_PROXY_HOSTS.gws},${YENTE_LOCAL_PROXY_HOSTS.msgvault}:8084,internal.example`,
    }).split(',');

    expect(entries).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', 'internal.example']));
    expect(entries).not.toContain(YENTE_LOCAL_PROXY_HOSTS.gws);
    expect(entries).not.toContain(`${YENTE_LOCAL_PROXY_HOSTS.msgvault}:8084`);
    expect(entries).not.toContain(YENTE_LOCAL_PROXY_HOSTS.familiar);
    expect(entries).not.toContain(YENTE_LOCAL_PROXY_HOSTS.nyne);
  });

  it('throws when OneCLI reports that gateway config was not applied', () => {
    expect(() => assertOneCliApplied(false)).toThrow(
      'OneCLI gateway did not apply container credentials; refusing to start Yente container.',
    );
    expect(() => assertOneCliApplied(true)).not.toThrow();
  });

  it('ensures required OneCLI local-proxy secrets are granted to the agent', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/secrets')) {
        return Response.json([
          { id: 'secret-anthropic', name: 'NanoClaw Anthropic' },
          { id: 'secret-gws', name: 'Yente GWS Proxy' },
          { id: 'secret-msgvault', name: 'Yente Msgvault Proxy' },
          { id: 'secret-openai', name: 'NanoClaw OpenAI' },
          { id: 'secret-gemini', name: 'NanoClaw Gemini' },
          { id: 'secret-opencode-go', name: 'NanoClaw OpenCode Go' },
          { id: 'secret-opencode-go-messages', name: 'NanoClaw OpenCode Go Messages' },
          { id: 'secret-assemblyai', name: 'AssemblyAI' },
          { id: 'secret-vercel', name: 'Vercel' },
        ]);
      }
      if (url.endsWith('/api/agents')) {
        return Response.json([{ id: 'agent-main', identifier: 'ag-main' }]);
      }
      if (url.endsWith('/api/agents/agent-main/secrets') && init?.method !== 'PUT') {
        return Response.json(['secret-anthropic']);
      }
      if (url.endsWith('/api/agents/agent-main/secrets') && init?.method === 'PUT') {
        return Response.json({ success: true });
      }
      if (url === 'https://onecli-gateway.local/api/cache/invalidate' && init?.method === 'POST') {
        return Response.json({ invalidated: true });
      }
      return new Response('not found', { status: 404 });
    };

    await ensureOneCliAgentSecretAccess({
      onecliUrl: 'https://onecli.local',
      onecliApiKey: 'onecli-key',
      onecliGatewayUrl: 'https://onecli-gateway.local',
      agentIdentifier: 'ag-main',
      fetchImpl,
    });

    const update = calls.find((call) => call.init?.method === 'PUT');
    expect(update?.init?.body).toBe(
      JSON.stringify({
        secretIds: [
          'secret-anthropic',
          'secret-gws',
          'secret-msgvault',
          'secret-openai',
          'secret-gemini',
          'secret-opencode-go',
          'secret-opencode-go-messages',
          'secret-assemblyai',
        ],
      }),
    );
    expect(calls.some((call) => call.url === 'https://onecli-gateway.local/api/cache/invalidate')).toBe(true);
  });

  it('requires a gateway URL before updating OneCLI grants so the cache cannot stay stale', async () => {
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/secrets')) {
        return Response.json([
          { id: 'secret-gws', name: 'Yente GWS Proxy' },
          { id: 'secret-msgvault', name: 'Yente Msgvault Proxy' },
          { id: 'secret-anthropic', name: 'NanoClaw Anthropic' },
          { id: 'secret-openai', name: 'NanoClaw OpenAI' },
          { id: 'secret-gemini', name: 'NanoClaw Gemini' },
          { id: 'secret-opencode-go', name: 'NanoClaw OpenCode Go' },
          { id: 'secret-opencode-go-messages', name: 'NanoClaw OpenCode Go Messages' },
          { id: 'secret-assemblyai', name: 'AssemblyAI' },
          { id: 'secret-vercel', name: 'Vercel' },
        ]);
      }
      if (url.endsWith('/api/agents')) {
        return Response.json([{ id: 'agent-main', identifier: 'ag-main' }]);
      }
      if (url.endsWith('/api/agents/agent-main/secrets') && init?.method !== 'PUT') {
        return Response.json([]);
      }
      return Response.json({ success: true });
    };

    await expect(
      ensureOneCliAgentSecretAccess({
        onecliUrl: 'https://onecli.local',
        onecliApiKey: 'onecli-key',
        agentIdentifier: 'ag-main',
        fetchImpl,
      }),
    ).rejects.toThrow('Missing required ONECLI_GATEWAY_URL');
  });

  it('fails closed when a required OneCLI secret is missing', async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/secrets')) {
        return Response.json([
          { id: 'secret-gws', name: 'Yente GWS Proxy' },
          { id: 'secret-msgvault', name: 'Yente Msgvault Proxy' },
        ]);
      }
      if (url.endsWith('/api/agents')) return Response.json([{ id: 'agent-main', identifier: 'ag-main' }]);
      return Response.json([]);
    };

    await expect(
      ensureOneCliAgentSecretAccess({
        onecliUrl: 'https://onecli.local',
        onecliApiKey: 'onecli-key',
        agentIdentifier: 'ag-main',
        fetchImpl,
      }),
    ).rejects.toThrow(
      'Missing OneCLI secret(s): NanoClaw Anthropic, NanoClaw OpenAI, NanoClaw Gemini, NanoClaw OpenCode Go, NanoClaw OpenCode Go Messages, AssemblyAI, Vercel',
    );
  });
});
