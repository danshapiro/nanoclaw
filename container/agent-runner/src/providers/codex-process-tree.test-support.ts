import { spawn } from 'child_process';
import { createInterface } from 'readline';

import type { AppServer } from './codex-app-server.js';

export type CodexTestProcessTreeMode = 'graceful' | 'stubborn';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !isProcessAlive(pid);
}

export async function spawnCodexTestProcessTree(mode: CodexTestProcessTreeMode): Promise<{
  server: AppServer;
  parentPid: number;
  descendantPid: number;
  cleanup(): Promise<void>;
}> {
  const descendantSource = 'setInterval(() => {}, 1000);';
  const shutdownSource =
    mode === 'graceful'
      ? [
          'let shuttingDown = false;',
          'process.stdin.resume();',
          "process.stdin.on('end', () => {",
          '  if (shuttingDown) return;',
          '  shuttingDown = true;',
          "  descendant.once('exit', () => process.exit(0));",
          "  descendant.kill('SIGTERM');",
          '});',
        ]
      : [
          'process.stdin.resume();',
          "process.stdin.on('end', () => {});",
          "process.on('SIGTERM', () => process.exit(0));",
        ];
  const parentSource = [
    "const { spawn } = require('child_process');",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
    "process.stdout.write(String(descendant.pid) + '\\n');",
    ...shutdownSource,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const parent = spawn(process.execPath, ['-e', parentSource], { stdio: ['pipe', 'pipe', 'pipe'] });
  const readline = createInterface({ input: parent.stdout });
  const descendantPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupListeners();
      reject(new Error(`Timed out waiting for ${mode} descendant PID`));
    }, 2_000);
    let stderr = '';
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString();
    };
    const onLine = (line: string): void => {
      const pid = Number(line);
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      cleanupListeners();
      resolve(pid);
    };
    const onError = (err: Error): void => {
      cleanupListeners();
      reject(err);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanupListeners();
      reject(
        new Error(`Test process parent exited before announcing descendant: code=${code} signal=${signal}: ${stderr}`),
      );
    };
    function cleanupListeners(): void {
      clearTimeout(timer);
      readline.off('line', onLine);
      parent.stderr.off('data', onStderr);
      parent.off('error', onError);
      parent.off('exit', onExit);
    }
    readline.on('line', onLine);
    parent.stderr.on('data', onStderr);
    parent.once('error', onError);
    parent.once('exit', onExit);
  });

  const server = {
    process: parent,
    readline,
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  } satisfies AppServer;

  return {
    server,
    parentPid: parent.pid!,
    descendantPid,
    async cleanup() {
      try {
        if (isProcessAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
      } catch {
        // Best-effort cleanup for test-only processes.
      }
      try {
        if (parent.pid && isProcessAlive(parent.pid)) parent.kill('SIGKILL');
      } catch {
        // Best-effort cleanup for test-only processes.
      }
      readline.close();
      await Promise.all([
        waitForProcessExit(descendantPid, 1_000),
        parent.pid ? waitForProcessExit(parent.pid, 1_000) : Promise.resolve(true),
      ]);
    },
  };
}
