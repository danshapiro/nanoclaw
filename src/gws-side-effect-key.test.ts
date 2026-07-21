import { generateKeyPairSync } from 'crypto';

import { describe, expect, it } from 'vitest';

import { resolveGwsSideEffectVerifyKey, type GwsKeyTrustFs } from './gws-side-effect-key.js';

function publicValue(): string {
  return generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .subarray(12)
    .toString('base64');
}

function stat(kind: 'file' | 'directory', uid = 0, mode = kind === 'file' ? 0o100644 : 0o40755) {
  return {
    uid,
    mode,
    nlink: 1,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => false,
  };
}

function trustFs(overrides: { fileUid?: number; parentMode?: number; parentSymlink?: boolean } = {}): GwsKeyTrustFs {
  const value = publicValue();
  return {
    open: () => 7,
    fstat: () => stat('file', overrides.fileUid ?? 0),
    lstat: () => ({
      ...stat('directory', 0, overrides.parentMode ?? 0o40755),
      isSymbolicLink: () => overrides.parentSymlink ?? false,
    }),
    read: () => value,
    close: () => {},
  };
}

describe('GWS side-effect public key trust boundary', () => {
  it('accepts a root-owned key through a root-owned non-writable parent chain', () => {
    expect(
      resolveGwsSideEffectVerifyKey({ GWS_SIDE_EFFECT_VERIFY_KEY_FILE: '/run/secrets/gws.pub' }, trustFs()),
    ).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('rejects a host-user-owned key file', () => {
    expect(() =>
      resolveGwsSideEffectVerifyKey(
        { GWS_SIDE_EFFECT_VERIFY_KEY_FILE: '/run/secrets/gws.pub' },
        trustFs({ fileUid: 1000 }),
      ),
    ).toThrow(/owned by root/i);
  });

  it('rejects writable or symlinked directories anywhere in the parent chain', () => {
    expect(() =>
      resolveGwsSideEffectVerifyKey(
        { GWS_SIDE_EFFECT_VERIFY_KEY_FILE: '/run/secrets/gws.pub' },
        trustFs({ parentMode: 0o40775 }),
      ),
    ).toThrow(/parent chain/i);
    expect(() =>
      resolveGwsSideEffectVerifyKey(
        { GWS_SIDE_EFFECT_VERIFY_KEY_FILE: '/run/secrets/gws.pub' },
        trustFs({ parentSymlink: true }),
      ),
    ).toThrow(/parent chain/i);
  });

  it('keeps direct-key configuration hermetic and independent of filesystem metadata', () => {
    const value = publicValue();
    expect(resolveGwsSideEffectVerifyKey({ GWS_SIDE_EFFECT_VERIFY_KEY: value })).toBe(value);
  });

  it('rejects Ed25519 private PKCS8 PEM instead of returning secret-bearing input', () => {
    const privatePem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => resolveGwsSideEffectVerifyKey({ GWS_SIDE_EFFECT_VERIFY_KEY: privatePem })).toThrow(/public.*key/i);
  });

  it('normalizes a public PEM to raw public-only base64', () => {
    const publicPem = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const resolved = resolveGwsSideEffectVerifyKey({ GWS_SIDE_EFFECT_VERIFY_KEY: publicPem });
    expect(resolved).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(resolved).not.toContain('BEGIN');
  });
});
