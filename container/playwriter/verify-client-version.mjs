import { spawnSync } from 'node:child_process';

const [entrypoint] = process.argv.slice(2);
if (!entrypoint) {
  throw new Error('Playwriter entry point is required');
}

const result = spawnSync(process.execPath, [entrypoint, '--version'], { encoding: 'utf8' });
const version = result.stdout?.trim() ?? '';
let reason = null;
if (result.error || result.status !== 0) {
  reason = 'client-failed';
} else if (!/^(?:playwriter\/)?0\.4\.0(?:[ \t].*)?$/.test(version)) {
  reason = 'unexpected-version';
}

if (reason) {
  console.error(
    JSON.stringify({
      severity: 'error',
      message: 'Playwriter version verification failed',
      reason,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
    }),
  );
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ severity: 'info', message: 'Playwriter version verified', version }));
}
