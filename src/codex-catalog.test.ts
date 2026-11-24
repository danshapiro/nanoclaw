import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { acquireStoreLease, catalogMount, resolveCodexImage } from './codex-catalog.js';

const roots: string[] = [];
const root = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
  roots.push(dir);
  return dir;
};
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

it('shares only catalogs within one group/version, retaining separate homes and rollback generations', () => {
  const data = root();
  const first = catalogMount(data, 'ag-qa', '0.170.0');
  expect(catalogMount(data, 'ag-qa', '0.170.0')).toEqual(first);
  expect(catalogMount(data, 'ag-other', '0.170.0').hostPath).not.toBe(first.hostPath);
  const upgrade = catalogMount(data, 'ag-qa', '0.171.0');
  expect(upgrade.hostPath).not.toBe(first.hostPath);
  fs.writeFileSync(path.join(first.hostPath, 'account-a.json'), '{"complete":true}');
  expect(fs.readFileSync(path.join(catalogMount(data, 'ag-qa', '0.170.0').hostPath, 'account-a.json'), 'utf8')).toBe(
    '{"complete":true}',
  );
  expect(first.containerPath).toBe('/home/node/.codex/cache/remote_plugin_catalog');
  expect(first.hostPath).toBe(path.join(data, '.cache', 'codex-catalog', 'ag-qa', '0.170.0'));
  expect(first.readonly).toBe(false);
  expect(fs.statSync(first.hostPath).mode & 0o777).toBe(0o700);
});

it('uses the actual immutable image binary version and fails on uncertain probes', async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return args[0] === 'image' ? 'sha256:abcd\n' : 'codex-cli 0.170.0\n';
  };
  expect(await resolveCodexImage('agent:latest', run)).toEqual({ imageId: 'sha256:abcd', version: '0.170.0' });
  expect(calls[1]).toContain('sha256:abcd');
  expect(calls[1]).toContain('--network=none');
  await expect(
    resolveCodexImage('bad', async () => {
      throw new Error('unavailable');
    }),
  ).rejects.toThrow('unavailable');
  await expect(
    resolveCodexImage('bad', async (args) => (args[0] === 'image' ? 'sha256:aaaa' : 'unknown')),
  ).rejects.toThrow('Codex version');
});

it('holds a kernel lease across wake and releases it explicitly, including failed setup', async () => {
  const data = root();
  const lease = await acquireStoreLease(data, 'session', 'ag-qa', 'sess-original');
  const competing = () => execFileSync('/usr/bin/flock', ['--exclusive', '--nonblock', lease.path, 'true']);
  expect(competing).toThrow();
  lease.release();
  lease.release();
  expect(competing).not.toThrow();
  const catalog = await acquireStoreLease(data, 'catalog', 'ag-qa', '0.170.0');
  expect(() => execFileSync('/usr/bin/flock', ['--exclusive', '--nonblock', catalog.path, 'true'])).toThrow();
  catalog.release();
});
