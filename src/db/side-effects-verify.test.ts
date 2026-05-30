/**
 * Cross-language / cross-copy verification check for the signed side-effect
 * channel (Task 4B).
 *
 * This HOST half feeds the byte-identical HOST copy of `side-effects-verify.ts`
 * a shared set of signed / forged / tampered / unsigned vectors and asserts the
 * verify/reject result for each. The CONTAINER half (in
 * `container/agent-runner/src/db/session-state.test.ts`) runs the SAME vectors
 * through the CONTAINER copy. Because the two `side-effects-verify.ts` files are
 * kept literally byte-identical (proven by a diff in the verification step), an
 * identical-vectors/identical-results pair across the two test files is the
 * cross-copy guarantee.
 *
 * The signing here uses an EPHEMERAL in-process Ed25519 test keypair
 * (`crypto.generateKeyPairSync('ed25519')`), never the production key.
 */
import { generateKeyPairSync, sign as edSign } from 'crypto';

import { describe, it, expect } from 'vitest';

import {
  canonicalSideEffectPayload,
  verifyGwsSideEffectSignature,
  type GwsVerifyResult,
} from './side-effects-verify.js';

/**
 * Shared cross-copy vectors. Keep this function in sync with the container half
 * in session-state.test.ts. It produces a payload string, a base64 detached
 * signature, the PEM public key, and a base64 raw public key so both key-format
 * acceptances are exercised.
 */
export interface VerifyVector {
  name: string;
  payload: string;
  signatureB64: string | undefined;
  publicKey: string | undefined;
  expected: GwsVerifyResult;
}

export function buildCrossCheckVectors(): VerifyVector[] {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const { publicKey: otherPublic } = generateKeyPairSync('ed25519');

  const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const rawB64 = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  const otherPem = otherPublic.export({ format: 'pem', type: 'spki' }).toString();

  const canonical = canonicalSideEffectPayload({
    audit_id: 'abc123',
    service: 'gmail',
    method: 'users.drafts.create',
    request_class: 'api',
    api_effect: true,
    operation_succeeded: true,
    occurred_at: '2026-05-29T00:00:00.000Z',
    result_digest: 'deadbeef',
  });
  const goodSig = edSign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');

  // Tampered payload: a different draft id (result_digest) the genuine signature
  // does not cover.
  const tamperedCanonical = canonicalSideEffectPayload({
    audit_id: 'abc123',
    service: 'gmail',
    method: 'users.drafts.create',
    request_class: 'api',
    api_effect: true,
    operation_succeeded: true,
    occurred_at: '2026-05-29T00:00:00.000Z',
    result_digest: 'cafef00d',
  });

  // Forged signature: signed by an attacker key (the agent does NOT hold the
  // real private key, so this models an agent-fabricated entry).
  const { privateKey: attackerKey } = generateKeyPairSync('ed25519');
  const forgedSig = edSign(null, Buffer.from(canonical, 'utf8'), attackerKey).toString('base64');

  return [
    { name: 'valid (pem key)', payload: canonical, signatureB64: goodSig, publicKey: pem, expected: 'valid' },
    { name: 'valid (raw b64 key)', payload: canonical, signatureB64: goodSig, publicKey: rawB64, expected: 'valid' },
    {
      name: 'tampered payload',
      payload: tamperedCanonical,
      signatureB64: goodSig,
      publicKey: pem,
      expected: 'invalid',
    },
    { name: 'forged signature', payload: canonical, signatureB64: forgedSig, publicKey: pem, expected: 'invalid' },
    { name: 'wrong public key', payload: canonical, signatureB64: goodSig, publicKey: otherPem, expected: 'invalid' },
    { name: 'no signature', payload: canonical, signatureB64: undefined, publicKey: pem, expected: 'unvalidated' },
    {
      name: 'no public key (feature inactive)',
      payload: canonical,
      signatureB64: goodSig,
      publicKey: undefined,
      expected: 'unvalidated',
    },
    {
      name: 'garbage signature',
      payload: canonical,
      signatureB64: 'not-base64-!!!',
      publicKey: pem,
      expected: 'invalid',
    },
  ];
}

describe('side-effects-verify cross-check (host copy)', () => {
  it('verifies/rejects each shared vector exactly', () => {
    for (const v of buildCrossCheckVectors()) {
      const got = verifyGwsSideEffectSignature(v.payload, v.signatureB64, v.publicKey);
      expect(got, v.name).toBe(v.expected);
    }
  });

  it('canonical payload bytes match the Go/TS cross-language contract', () => {
    const canonical = canonicalSideEffectPayload({
      audit_id: 'abc123',
      service: 'gmail',
      method: 'users.drafts.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-05-29T00:00:00.000Z',
      result_digest: 'deadbeef',
    });
    expect(canonical).toBe(
      '{"audit_id":"abc123","service":"gmail","method":"users.drafts.create","request_class":"api","api_effect":true,"operation_succeeded":true,"occurred_at":"2026-05-29T00:00:00.000Z","result_digest":"deadbeef"}',
    );
  });
});
