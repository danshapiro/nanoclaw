import { createPublicKey } from 'crypto';
import fs from 'fs';
import path from 'path';

function validatePublicKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('GWS side-effect public verification key is empty');
  let key;
  try {
    if (trimmed.includes('BEGIN')) {
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
  return trimmed;
}

/** Resolve the host-only verification-key file while keeping direct value
 * support for hermetic tests. The path is never forwarded to a container. */
export function resolveGwsSideEffectVerifyKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env.GWS_SIDE_EFFECT_VERIFY_KEY?.trim();
  const filePath = env.GWS_SIDE_EFFECT_VERIFY_KEY_FILE?.trim();
  if (direct && filePath) {
    throw new Error('set only one of GWS_SIDE_EFFECT_VERIFY_KEY_FILE or GWS_SIDE_EFFECT_VERIFY_KEY');
  }
  if (direct) return validatePublicKey(direct);
  if (!filePath) return undefined;
  if (!path.isAbsolute(filePath)) throw new Error('GWS_SIDE_EFFECT_VERIFY_KEY_FILE must be an absolute path');
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) {
      throw new Error('GWS_SIDE_EFFECT_VERIFY_KEY_FILE must be a non-writable, single-link regular file');
    }
    if (typeof process.getuid === 'function' && stat.uid !== 0 && stat.uid !== process.getuid()) {
      throw new Error('GWS_SIDE_EFFECT_VERIFY_KEY_FILE must be owned by root or the NanoClaw host user');
    }
    return validatePublicKey(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}
