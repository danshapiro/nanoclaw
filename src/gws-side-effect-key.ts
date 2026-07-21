import { createPublicKey } from 'crypto';
import fs from 'fs';
import path from 'path';

function validatePublicKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('GWS side-effect public verification key is empty');
  if (/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(trimmed)) {
    throw new Error('GWS side-effect public verification key must not contain private key material');
  }
  let key;
  try {
    if (trimmed.includes('BEGIN')) {
      if (!trimmed.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('expected PUBLIC KEY PEM');
      key = createPublicKey({ key: trimmed, format: 'pem' });
    } else {
      const raw = Buffer.from(trimmed, 'base64');
      const der = raw.length === 32 ? Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]) : raw;
      if (der.length !== 44) throw new Error('unexpected raw key length');
      key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
  } catch (err) {
    throw new Error('GWS side-effect public verification key is invalid', { cause: err });
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('GWS side-effect public verification key must be Ed25519');
  }
  const publicDer = key.export({ format: 'der', type: 'spki' });
  const ed25519Prefix = Buffer.from('302a300506032b6570032100', 'hex');
  if (publicDer.length !== 44 || !publicDer.subarray(0, ed25519Prefix.length).equals(ed25519Prefix)) {
    throw new Error('GWS side-effect public verification key has an unexpected encoding');
  }
  // The only value allowed to cross into a container is the normalized raw
  // public key. Never return caller-supplied PEM bytes.
  return publicDer.subarray(ed25519Prefix.length).toString('base64');
}

interface TrustedStat {
  uid: number;
  mode: number;
  nlink: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface GwsKeyTrustFs {
  open(filePath: string): number;
  fstat(fd: number): TrustedStat;
  lstat(filePath: string): TrustedStat;
  read(fd: number): string;
  close(fd: number): void;
}

const realTrustFs: GwsKeyTrustFs = {
  open: (filePath) => fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
  fstat: (fd) => fs.fstatSync(fd),
  lstat: (filePath) => fs.lstatSync(filePath),
  read: (fd) => fs.readFileSync(fd, 'utf8'),
  close: (fd) => fs.closeSync(fd),
};

/** Resolve the host-only verification-key file while keeping direct value
 * support for hermetic tests. The path is never forwarded to a container. */
export function resolveGwsSideEffectVerifyKey(
  env: NodeJS.ProcessEnv = process.env,
  trustFs: GwsKeyTrustFs = realTrustFs,
): string | undefined {
  const direct = env.GWS_SIDE_EFFECT_VERIFY_KEY?.trim();
  const filePath = env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE?.trim();
  if (direct && filePath) {
    throw new Error('set only one of GWS_SIDE_EFFECT_VERIFY_KEY_FILE or GWS_SIDE_EFFECT_VERIFY_KEY');
  }
  if (direct) return validatePublicKey(direct);
  if (!filePath) return undefined;
  if (!path.isAbsolute(filePath)) throw new Error('GWS_SIDE_EFFECT_VERIFY_KEY_FILE must be an absolute path');
  let current = path.dirname(filePath);
  while (true) {
    const parent = trustFs.lstat(current);
    if (parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) {
      throw new Error('GWS_SIDE_EFFECT_VERIFY_KEY_FILE parent chain must be root-owned, non-symlink, and non-writable');
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }

  const fd = trustFs.open(filePath);
  try {
    const stat = trustFs.fstat(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
      throw new Error('GWS_SIDE_EFFECT_VERIFY_KEY_FILE must be a non-writable, single-link regular file');
    }
    if (stat.uid !== 0) {
      throw new Error('GWS_SIDE_EFFECT_VERIFY_KEY_FILE must be owned by root');
    }
    return validatePublicKey(trustFs.read(fd));
  } finally {
    trustFs.close(fd);
  }
}
