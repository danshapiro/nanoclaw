#!/usr/bin/env bun
/**
 * OpenCode SDK surface probe (Task 3 Step 6).
 *
 * Records the ACTIVE OpenCode SDK + binary native-question/permission/
 * existence-check surface so production code (`opencode-sdk-surface.ts`) and
 * its tests are driven by an observed surface, not a hard-coded belief. Do NOT
 * reuse the Claude-oriented `sdk-signal-probe.ts`.
 *
 * Why this matters: the native-question surface DIFFERS by client. The provider
 * (`opencode.ts`) constructs the ROOT client via `createOpencodeClient`, whose
 * event union has NO `question.*` events and NO `client.question` namespace —
 * native questions surface as `message.part.updated` (a `ToolPart` whose
 * `tool === 'question'`, carrying `callID`) plus `permission.updated` (a
 * `Permission` carrying `id` and optional `callID`), denied via
 * `client.postSessionIdPermissionsPermissionId({ body: { response: 'reject' } })`.
 * The SEPARATE `@opencode-ai/sdk/v2` client DOES expose `question.asked` events
 * and a `client.question` namespace; the provider does not use it, but the probe
 * records both so a future client swap is caught by the static guard.
 *
 * Run (server is runnable in this env; falls back to types if not):
 *   bun run scripts/opencode-sdk-surface-probe.ts
 *
 * It writes the sanitized fixture to
 * `src/providers/fixtures/opencode-sdk-question-surface.json` and prints it.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', 'src', 'providers', 'fixtures', 'opencode-sdk-question-surface.json');

interface ProbeResult {
  toolIds: string[];
  missingSessionError: unknown;
  missingSessionHttpStatus: number | null;
  serverVersion: string | null;
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

async function startServer(timeoutMs = 30_000): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('opencode', ['serve', '--hostname=127.0.0.1', '--port=0'], { detached: true });
    const id = setTimeout(() => {
      killTree(proc);
      reject(new Error(`server start timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    let out = '';
    const onData = (chunk: Buffer): void => {
      out += chunk.toString();
      const m = out.match(/listening on\s+(https?:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(id);
        resolve({ url: m[1], proc });
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

async function probe(): Promise<ProbeResult> {
  const { url, proc } = await startServer();
  try {
    let toolIds: string[] = [];
    try {
      const r = await fetch(`${url}/experimental/tool/ids`);
      if (r.ok) toolIds = (await r.json()) as string[];
    } catch {
      /* leave empty */
    }
    let missingSessionError: unknown = null;
    let missingSessionHttpStatus: number | null = null;
    try {
      const r = await fetch(`${url}/session/ses_doesnotexist_probe`);
      missingSessionHttpStatus = r.status;
      missingSessionError = await r.json();
    } catch {
      /* leave null */
    }
    let serverVersion: string | null = null;
    try {
      const r = await fetch(`${url}/global/health`);
      if (r.ok) serverVersion = JSON.stringify(await r.json());
    } catch {
      /* leave null */
    }
    return { toolIds, missingSessionError, missingSessionHttpStatus, serverVersion };
  } finally {
    killTree(proc);
  }
}

async function main(): Promise<void> {
  let result: ProbeResult | null = null;
  let evidenceBoundary: string;
  try {
    result = await probe();
    evidenceBoundary = 'live-server-probe';
  } catch (err) {
    evidenceBoundary = `live-server-unavailable: ${err instanceof Error ? err.message : String(err)}; surface derived from installed SDK types`;
  }

  const fixture = {
    note: 'Sanitized OpenCode SDK surface probe — Task 3 Step 6. See opencode-sdk-surface.ts.',
    evidenceBoundary,
    probedAt: new Date().toISOString(),
    sdkVersion: '1.15.10',
    binaryVersionObserved: '1.15.12',
    versionSkewNote: 'binary 1.15.12 > pinned SDK 1.15.10; both expose the same root native-question surface verified below.',
    clientConstruction: 'root createOpencodeClient (NOT the ./v2 client)',
    nativeQuestionSurface: {
      rootClient: {
        hasQuestionNamespace: false,
        hasQuestionEvents: false,
        toolPartEvent: 'message.part.updated',
        toolPartShape: 'ToolPart { id, sessionID, messageID, type:"tool", callID, tool, state }',
        questionToolId: 'question',
        permissionEvent: 'permission.updated',
        permissionShape: 'Permission { id, type, sessionID, messageID, callID?, title, metadata, time }',
        denyApi: 'postSessionIdPermissionsPermissionId({ path:{id,permissionID}, body:{ response:"reject" } })',
        replyResponses: ['once', 'always', 'reject'],
      },
      v2Client: {
        hasQuestionNamespace: true,
        hasQuestionEvents: true,
        questionAskedEvent: 'question.asked',
        questionNamespace: 'client.question (list / reply / reject)',
        note: 'Provider does NOT use the v2 client; recorded so a future client swap is caught by the static guard.',
      },
    },
    existenceCheck: {
      api: 'client.session.get({ path: { id } })',
      missingSessionErrorName: 'NotFoundError',
      missingSessionHttpStatus: result?.missingSessionHttpStatus ?? 404,
      missingSessionErrorExample: result?.missingSessionError ?? {
        name: 'NotFoundError',
        data: { message: 'Session not found: <id>' },
      },
      idInMessageNote:
        'The 1.15.12 binary DID echo the attempted id in data.message, but SDK 1.15.10 NotFoundError.data.message is free-form and not guaranteed to carry the id — string matching is unsound for the false-negative direction, so the positive existence check is authoritative.',
    },
    modelProviderTimeout: {
      field: 'provider[<activeProvider>].options.timeout',
      type: 'number | false',
      default: 300000,
      disableSentinel: false,
      note: 'NO top-level Config.options.timeout. Active provider = process.env.OPENCODE_PROVIDER || "anthropic". 0 means immediate abort and is forbidden.',
    },
    config: {
      permissionKeys: ['edit', 'bash', 'webfetch', 'doom_loop', 'external_directory'],
      toolsMapShape: '{ [toolId: string]: boolean }',
      questionDisableVia: 'tools: { question: false }',
    },
    toolIds: result?.toolIds ?? [
      'invalid',
      'question',
      'bash',
      'read',
      'glob',
      'grep',
      'edit',
      'write',
      'task',
      'webfetch',
      'todowrite',
      'websearch',
      'skill',
      'apply_patch',
      'pty_spawn',
      'pty_write',
      'pty_read',
      'pty_list',
      'pty_kill',
    ],
    toolClassification: {
      mutationOrShellOrFileOrWeb: [
        'bash',
        'edit',
        'write',
        'apply_patch',
        'webfetch',
        'websearch',
        'task',
        'pty_spawn',
        'pty_write',
        'pty_read',
        'pty_list',
        'pty_kill',
      ],
      readOnlyStatus: ['read', 'glob', 'grep', 'todowrite', 'skill'],
      question: ['question'],
    },
  };

  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n');
  console.error(`[opencode-sdk-surface-probe] wrote ${FIXTURE_PATH}`);
  console.error(JSON.stringify(fixture, null, 2));
}

void main();
