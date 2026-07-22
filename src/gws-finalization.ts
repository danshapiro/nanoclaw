import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const CONTROL_PATH = '/v1/correlations/seal-and-drain';
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface GwsFinalizationReceipt {
  inputId: string;
  routeKey: string;
  sealed: true;
  drained: true;
}

function canonicalCorrelation(value: string, label: string): string {
  if (!value || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(`GWS finalization ${label} is invalid`);
  }
  return value;
}

function absolutePath(value: string, label: string): string {
  if (!value || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`GWS finalization ${label} must be an absolute path`);
  }
  return value;
}

function isProtectedSystemdCredential(
  resolved: string,
  stat: fs.Stats,
  credentialDirectory: string | undefined,
): boolean {
  if (!credentialDirectory || (stat.mode & 0o777) !== 0o440) return false;
  const directory = absolutePath(credentialDirectory, 'credential directory');
  if (path.dirname(resolved) !== directory || fs.realpathSync(directory) !== directory) return false;
  const directoryStat = fs.lstatSync(directory);
  return (
    directoryStat.isDirectory() &&
    !directoryStat.isSymbolicLink() &&
    trustedOwner(directoryStat.uid) &&
    directoryStat.uid === stat.uid &&
    directoryStat.gid === stat.gid &&
    (directoryStat.mode & 0o050) === 0o050 &&
    (directoryStat.mode & 0o027) === 0
  );
}

function readCredential(tokenFile: string, credentialDirectory?: string): string {
  const resolved = absolutePath(tokenFile, 'credential file');
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('GWS finalization credential must be a single-link regular file, not a symlink');
  }
  if ((stat.mode & 0o077) !== 0 && !isProtectedSystemdCredential(resolved, stat, credentialDirectory)) {
    throw new Error('GWS finalization credential permissions must deny group and other access');
  }
  if (!trustedOwner(stat.uid)) {
    throw new Error('GWS finalization credential owner is not trusted');
  }
  if (stat.size <= 0 || stat.size > 4096) throw new Error('GWS finalization credential size is invalid');
  const token = fs.readFileSync(resolved, 'utf8').trim();
  if (token.length < 32 || token.length > 512 || !/^[\x20-\x7e]+$/.test(token)) {
    throw new Error('GWS finalization credential contents are invalid');
  }
  return token;
}

function trustedOwner(uid: number): boolean {
  return uid === 0 || uid === process.geteuid?.();
}

function accessibleServiceGroup(gid: number): boolean {
  return gid === process.getegid?.() || (process.getgroups?.() ?? []).includes(gid);
}

function validateSocket(socketPath: string): string {
  const resolved = absolutePath(socketPath, 'control socket');
  const directory = fs.lstatSync(path.dirname(resolved));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o777) !== 0o710 ||
    !trustedOwner(directory.uid) ||
    !accessibleServiceGroup(directory.gid)
  ) {
    throw new Error('GWS finalization control directory does not match the restricted host-service boundary');
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error('GWS finalization control path is not a Unix socket');
  if ((stat.mode & 0o777) !== 0o660 || !trustedOwner(stat.uid) || !accessibleServiceGroup(stat.gid)) {
    throw new Error('GWS finalization control socket does not match root:host-service mode 0660');
  }
  return resolved;
}

export function resolveGwsFinalizationConfig(env: NodeJS.ProcessEnv = process.env): {
  socketPath: string;
  tokenFile: string;
  credentialDirectory?: string;
} {
  const socketPath = env.GWS_CONTROL_SOCKET ?? '';
  const credentialDirectory = env.CREDENTIALS_DIRECTORY?.trim();
  const credentialFallback = credentialDirectory ? path.join(credentialDirectory, 'gws-finalize-token') : '';
  const tokenFile = env.GWS_FINALIZE_TOKEN_FILE ?? credentialFallback;
  const resolvedTokenFile = absolutePath(tokenFile, 'credential file');
  const resolvedCredentialDirectory = credentialDirectory
    ? absolutePath(credentialDirectory, 'credential directory')
    : undefined;
  return {
    socketPath: absolutePath(socketPath, 'control socket'),
    tokenFile: resolvedTokenFile,
    ...(resolvedCredentialDirectory && path.dirname(resolvedTokenFile) === resolvedCredentialDirectory
      ? { credentialDirectory: resolvedCredentialDirectory }
      : {}),
  };
}

export async function sealAndDrainGwsCorrelation(opts: {
  inputId: string;
  routeKey: string;
  socketPath: string;
  tokenFile: string;
  credentialDirectory?: string;
  timeoutMs?: number;
}): Promise<GwsFinalizationReceipt> {
  const inputId = canonicalCorrelation(opts.inputId, 'input_id');
  const routeKey = canonicalCorrelation(opts.routeKey, 'route_key');
  const socketPath = validateSocket(opts.socketPath);
  const token = readCredential(opts.tokenFile, opts.credentialDirectory);
  const body = Buffer.from(JSON.stringify({ input_id: inputId, route_key: routeKey }));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error('GWS finalization timeout is invalid');
  }

  const response = await new Promise<{ status: number; contentType: string; body: Buffer }>((resolve, reject) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(deadline);
      return true;
    };
    const request = http.request(
      {
        socketPath,
        path: CONTROL_PATH,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let total = 0;
        incoming.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('GWS finalization response exceeded the size limit'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        incoming.on('end', () => {
          if (finish()) {
            resolve({
              status: incoming.statusCode ?? 0,
              contentType: String(incoming.headers['content-type'] ?? ''),
              body: Buffer.concat(chunks),
            });
          }
        });
      },
    );
    const deadline = setTimeout(() => {
      request.destroy(new Error('GWS proxy seal-and-drain timed out'));
    }, timeoutMs);
    request.once('error', (error) => {
      if (finish()) reject(error);
    });
    request.end(body);
  });

  if (response.status !== 200) throw new Error(`GWS proxy seal-and-drain returned HTTP ${response.status}`);
  if (response.contentType.toLowerCase().split(';', 1)[0].trim() !== 'application/json') {
    throw new Error('GWS proxy seal-and-drain returned a non-JSON receipt');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body.toString('utf8'));
  } catch (error) {
    throw new Error('GWS proxy seal-and-drain returned a malformed receipt', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('GWS proxy seal-and-drain returned an invalid receipt');
  }
  const receipt = parsed as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(['drained', 'input_id', 'route_key', 'sealed']) ||
    receipt.input_id !== inputId ||
    receipt.route_key !== routeKey ||
    receipt.sealed !== true ||
    receipt.drained !== true
  ) {
    throw new Error('GWS proxy seal-and-drain receipt did not prove the exact correlation was drained');
  }
  return { inputId, routeKey, sealed: true, drained: true };
}
