import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const applyManagedRepos: McpToolDefinition = {
  tool: {
    name: 'apply_managed_repos',
    description:
      'Ask the host to reconcile host-declared managed repos into /workspace/repos, refresh /workspace/local-skills, and apply group context. Main agent only; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async handler() {
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'apply_managed_repos',
        requestId,
      }),
    });

    log(`apply_managed_repos: ${requestId}`);
    return ok('Managed repo reconcile requested. You will receive a system message when it completes.');
  },
};

export const pushManagedRepo: McpToolDefinition = {
  tool: {
    name: 'push_managed_repo',
    description:
      'Ask the host to push a clean, allowPush=true managed repo using host credentials, then reconcile managed repos. Main agent only; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        repoId: {
          type: 'string',
          description:
            'Managed repo id from /workspace/repos/.managed/status.json, such as yente-context or local-skills.',
        },
      },
      required: ['repoId'],
    },
  },
  async handler(args) {
    const repoId = args.repoId as string;
    if (!repoId || !REPO_ID_RE.test(repoId)) return err('repoId must be a managed repo id');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'push_managed_repo',
        requestId,
        repoId,
      }),
    });

    log(`push_managed_repo: ${requestId} → ${repoId}`);
    return ok(`Managed repo push requested for ${repoId}. You will receive a system message when it completes.`);
  },
};

registerTools([applyManagedRepos, pushManagedRepo]);
