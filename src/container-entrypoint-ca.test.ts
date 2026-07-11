import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

const ENTRYPOINT_PATH = path.join(process.cwd(), 'container', 'entrypoint.sh');

const FAKE_CERT = (label: string): string => `-----BEGIN CERTIFICATE-----\n${label}\n-----END CERTIFICATE-----\n`;

/**
 * Extract the onecli-ca-bundle section from the entrypoint so it can run in a
 * sandbox without bun/stdin. The markers keep the tested code identical to
 * what ships in the image.
 */
function caBundleSnippet(): string {
  const entrypoint = fs.readFileSync(ENTRYPOINT_PATH, 'utf8');
  const begin = entrypoint.indexOf('# --- begin onecli-ca-bundle ---');
  const end = entrypoint.indexOf('# --- end onecli-ca-bundle ---');
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return entrypoint.slice(begin, end);
}

function runSnippet(env: Record<string, string | undefined>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const script = `${caBundleSnippet()}\nprintf '%s|%s' "\${SSL_CERT_FILE:-}" "\${CODEX_CA_CERTIFICATE:-}"\n`;
  const result = spawnSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('container entrypoint OneCLI CA bundle', () => {
  it('entrypoint passes shell syntax check', () => {
    const result = spawnSync('bash', ['-n', ENTRYPOINT_PATH], { encoding: 'utf8' });
    expect(result.status).toBe(0);
  });

  it('builds a full bundle (system roots + gateway CA) and exports both env vars', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ca-test-'));
    try {
      const gatewayCa = path.join(dir, 'gateway-ca.pem');
      const systemBundle = path.join(dir, 'ca-certificates.crt');
      const bundleOut = path.join(dir, 'onecli-ca-bundle.pem');
      fs.writeFileSync(gatewayCa, FAKE_CERT('GATEWAYCA'));
      fs.writeFileSync(systemBundle, FAKE_CERT('SYSTEMROOT'));

      const result = runSnippet({
        CODEX_CA_CERTIFICATE: gatewayCa,
        SSL_CERT_FILE: gatewayCa,
        NANOCLAW_SYSTEM_CA_BUNDLE: systemBundle,
        NANOCLAW_CA_BUNDLE_OUT: bundleOut,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${bundleOut}|${bundleOut}`);
      const bundle = fs.readFileSync(bundleOut, 'utf8');
      const certCount = bundle.match(/BEGIN CERTIFICATE/g)?.length ?? 0;
      expect(certCount).toBe(2);
      // System roots first, gateway CA appended.
      expect(bundle.indexOf('SYSTEMROOT')).toBeLessThan(bundle.indexOf('GATEWAYCA'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves env untouched and warns on stderr when the system bundle is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ca-test-'));
    try {
      const gatewayCa = path.join(dir, 'gateway-ca.pem');
      const bundleOut = path.join(dir, 'onecli-ca-bundle.pem');
      fs.writeFileSync(gatewayCa, FAKE_CERT('GATEWAYCA'));

      const result = runSnippet({
        CODEX_CA_CERTIFICATE: gatewayCa,
        SSL_CERT_FILE: gatewayCa,
        NANOCLAW_SYSTEM_CA_BUNDLE: path.join(dir, 'does-not-exist.crt'),
        NANOCLAW_CA_BUNDLE_OUT: bundleOut,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${gatewayCa}|${gatewayCa}`);
      expect(result.stderr).toContain('system CA bundle');
      expect(fs.existsSync(bundleOut)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when no gateway CA pem is configured', () => {
    const result = runSnippet({});
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('|');
    expect(result.stderr).toBe('');
  });
});
