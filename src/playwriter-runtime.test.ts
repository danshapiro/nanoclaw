import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

const CLIENT_FILENAME = 'playwriter-client-0303f56f07c838bb4686870cc03c9374ccff46f8.tgz';
const CLIENT_SHA256 = '15bdc6b333ef539de575b8b14fd41fd622b57d9af69fbc4c678d339788d823ea';
const CLIENT_BYTES = 1066577;

function repoPath(...parts: string[]): string {
  return path.join(process.cwd(), ...parts);
}

describe('shared Playwriter runtime', () => {
  it('binds the checked-in stock client to the accepted Task 1 artifact and receipt identity', () => {
    const identityPath = repoPath('container', 'playwriter', 'client-identity.json');
    const archivePath = repoPath('container', 'playwriter', CLIENT_FILENAME);
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as unknown;

    expect(identity).toEqual({
      schema_version: 1,
      artifact: {
        kind: 'client_npm_pack',
        filename: CLIENT_FILENAME,
        bytes: CLIENT_BYTES,
        sha256: CLIENT_SHA256,
      },
      source: {
        repository: 'https://github.com/remorses/playwriter.git',
        selection: 'exact_git_commit',
        commit: '0303f56f07c838bb4686870cc03c9374ccff46f8',
        tree: '879cb66e86da0ae81c95d5c00218ec686ce1eeef',
        lockfile_sha256: 'eb88e54978fbdce46545e1e457d9ac534a31816ab828d0ff5b254338fcf088ed',
        playwright_commit: '1c634ae0c0a463a8ee86f12ce8ee732f40521088',
      },
      preparation_receipt: {
        filename: 'playwriter-0303f56f07c838bb4686870cc03c9374ccff46f8.json',
        sha256: '94d712d3bd63df54e6d8386a097dad2e778ade97ab76e0a85c1cd8491a1030ed',
      },
      package: {
        name: 'playwriter',
        version: '0.4.0',
      },
      optional_dependencies_omitted: ['@playwriter/patchright-core', 'sharp'],
    });

    const archive = fs.readFileSync(archivePath);
    expect(archive.byteLength).toBe(CLIENT_BYTES);
    expect(crypto.createHash('sha256').update(archive).digest('hex')).toBe(CLIENT_SHA256);

    const packageJson = JSON.parse(
      execFileSync('tar', ['-xOzf', archivePath, 'package/package.json'], { encoding: 'utf8' }),
    ) as {
      name?: string;
      version?: string;
      optionalDependencies?: Record<string, string>;
    };
    expect(packageJson.name).toBe('playwriter');
    expect(packageJson.version).toBe('0.4.0');
    expect(Object.keys(packageJson.optionalDependencies ?? {}).sort()).toEqual([
      '@playwriter/patchright-core',
      'sharp',
    ]);
  });

  it('exposes stock enabled-target cardinality, title/URL discovery, and wrapped HTTP errors', () => {
    const archivePath = repoPath('container', 'playwriter', CLIENT_FILENAME);
    const relaySource = execFileSync('tar', ['-xOzf', archivePath, 'package/dist/cdp-relay.js'], {
      encoding: 'utf8',
    });
    const cliSource = execFileSync('tar', ['-xOzf', archivePath, 'package/dist/cli.js'], {
      encoding: 'utf8',
    });

    expect(relaySource).toContain("app.get('/extensions/status'");
    expect(relaySource).toContain('stableKey: ext.stableKey');
    expect(relaySource).toContain('activeTargets: ext.connectedTargets.size');
    expect(relaySource).toContain(".on(['GET', 'PUT'], '/json/list'");
    expect(relaySource).toContain('title: t.targetInfo.title');
    expect(relaySource).toContain('url: t.targetInfo.url');
    expect(cliSource).toContain('console.error(`Error: ${response.status} ${text}`)');
  });

  it('rejects optional dependencies that resolve from the installed Playwriter runtime', () => {
    const verifierPath = repoPath('container', 'playwriter', 'verify-no-optional-dependencies.mjs');
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'playwriter-resolution-'));
    const resolutionRoot = path.join(fixtureRoot, 'global', '5', 'node_modules');
    const cliPath = path.join(resolutionRoot, 'playwriter', 'dist', 'cli.js');

    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, '', 'utf8');

    try {
      expect(() => execFileSync(process.execPath, [verifierPath, cliPath], { stdio: 'pipe' })).not.toThrow();

      for (const optional of ['@playwriter/patchright-core', 'sharp']) {
        const optionalRoot = path.join(resolutionRoot, ...optional.split('/'));
        fs.mkdirSync(optionalRoot, { recursive: true });
        fs.writeFileSync(
          path.join(optionalRoot, 'package.json'),
          JSON.stringify({ name: optional, main: 'index.js' }),
          'utf8',
        );
        fs.writeFileSync(path.join(optionalRoot, 'index.js'), '', 'utf8');

        let failure: { stderr?: Buffer } | undefined;
        try {
          execFileSync(process.execPath, [verifierPath, cliPath], { stdio: 'pipe' });
        } catch (error) {
          failure = error as { stderr?: Buffer };
        }
        expect(failure).toBeDefined();
        expect(failure?.stderr?.toString()).toContain(
          `Optional Playwriter dependency resolves at runtime: ${optional}`,
        );

        fs.rmSync(optionalRoot, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('installs only the exact local archive at image build time with optional dependencies omitted', () => {
    const dockerfile = fs.readFileSync(repoPath('container', 'Dockerfile'), 'utf8');
    const section = dockerfile.match(/# ---- Playwriter stock client -+\n(?<body>[\s\S]*?)\n# ---- [^-]/)?.groups?.body;

    expect(section).toBeDefined();
    expect(section).toContain(
      `COPY playwriter/${CLIENT_FILENAME} /usr/local/share/nanoclaw/playwriter/${CLIENT_FILENAME}`,
    );
    expect(section).toContain('COPY playwriter/client-identity.json /usr/local/share/nanoclaw/playwriter/');
    expect(section).toContain(`'${CLIENT_SHA256}  /usr/local/share/nanoclaw/playwriter/${CLIENT_FILENAME}'`);
    expect(section).toContain('sha256sum --check --strict');
    expect(section).toContain(
      `test "$(wc -c <"/usr/local/share/nanoclaw/playwriter/${CLIENT_FILENAME}")" = "${CLIENT_BYTES}"`,
    );
    expect(section).toContain(
      `pnpm install -g --prod --no-optional "/usr/local/share/nanoclaw/playwriter/${CLIENT_FILENAME}"`,
    );
    expect(section).toContain('playwriter_version="$(playwriter --version 2>&1)"');
    expect(section).toContain("grep -Eq '^playwriter/0[.]4[.]0([[:space:]]|$)'");
    expect(section).toContain(
      'COPY playwriter/verify-no-optional-dependencies.mjs /usr/local/share/nanoclaw/playwriter/',
    );
    expect(section).toContain(
      'node /usr/local/share/nanoclaw/playwriter/verify-no-optional-dependencies.mjs "$playwriter_bin"',
    );
    expect(section).not.toContain('@latest');
    expect(section).not.toMatch(/playwriter@/);
    expect(section).not.toMatch(/https?:\/\/(?:registry\.)?npmjs/);
    expect(section).not.toMatch(/\b(?:curl|wget)\b/);

    const entrypoint = fs.readFileSync(repoPath('container', 'entrypoint.sh'), 'utf8');
    expect(entrypoint).not.toMatch(/\b(?:npm|pnpm|npx|bun)\s+(?:install|add).*\bplaywriter\b/);
  });

  it('checks shared non-root client availability and identity in a disposable offline container', () => {
    const buildScript = fs.readFileSync(repoPath('container', 'build.sh'), 'utf8');

    expect(buildScript).toContain('Verifying the exact stock Playwriter client as a non-root uid');
    expect(buildScript).toContain('--network none');
    expect(buildScript).toContain('--user 12345:12345');
    expect(buildScript).toContain('command -v playwriter');
    expect(buildScript).toContain('playwriter_version="$(playwriter --version 2>&1)"');
    expect(buildScript).toContain('grep -Eq "^playwriter/0[.]4[.]0([[:space:]]|$)"');
    expect(buildScript).toContain(CLIENT_FILENAME);
    expect(buildScript).toContain(CLIENT_SHA256);
    expect(buildScript).toContain(`test "$(wc -c <"$archive")" = "${CLIENT_BYTES}"`);
    expect(buildScript).toContain(
      'node /usr/local/share/nanoclaw/playwriter/verify-no-optional-dependencies.mjs "$playwriter_bin"',
    );
  });
});
