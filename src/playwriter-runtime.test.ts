import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

function repoPath(...parts: string[]): string {
  return path.join(process.cwd(), ...parts);
}

describe('shared Playwriter runtime', () => {
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

  it.each(['0.4.0', 'playwriter/0.4.0 linux-x64 node-v22.21.1'])(
    'executes the client and accepts the stock version output %s',
    (version) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'playwriter-version-'));
      const client = path.join(root, 'client.cjs');
      const marker = path.join(root, 'invoked');
      fs.writeFileSync(
        client,
        `if (process.argv[2] !== '--version') process.exit(9); require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes'); console.log(${JSON.stringify(version)});`,
      );
      try {
        expect(() =>
          execFileSync(process.execPath, [repoPath('container', 'playwriter', 'verify-client-version.mjs'), client], {
            stdio: 'pipe',
          }),
        ).not.toThrow();
        expect(fs.readFileSync(marker, 'utf8')).toBe('yes');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['console.log("0.4.1")', 'unexpected-version'],
    ['process.exit(73)', 'client-failed'],
  ])('rejects a wrong version or failed executable: %s', (source, reason) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'playwriter-version-'));
    const client = path.join(root, 'client.cjs');
    fs.writeFileSync(client, source);
    try {
      let failure: { stderr?: Buffer } | undefined;
      try {
        execFileSync(process.execPath, [repoPath('container', 'playwriter', 'verify-client-version.mjs'), client], {
          stdio: 'pipe',
        });
      } catch (error) {
        failure = error as { stderr?: Buffer };
      }
      expect(failure).toBeDefined();
      expect(failure?.stderr?.toString()).toContain(reason);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
