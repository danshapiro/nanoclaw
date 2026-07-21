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
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'crypto';
import fs from 'fs';

import { describe, it, expect } from 'vitest';

import {
  canonicalSideEffectPayload,
  classifyAndSanitize,
  verifyGwsSideEffectSignature,
  type GwsVerifyResult,
} from './side-effects-verify.js';

interface CorpusPayload {
  schema_version: number;
  audit_id: string;
  profile: string;
  account_label: string;
  account_email: string;
  input_id: string;
  route_key: string;
  service: string;
  method: string;
  request_class: string;
  api_effect: boolean;
  operation_succeeded: boolean;
  occurred_at: string;
  result_digest: string;
}

interface SchemaV2Corpus {
  payload: CorpusPayload;
  canonical: string;
  unicode_payload: CorpusPayload;
  unicode_canonical: string;
  seed_base64: string;
  adversarial: Array<{ field: keyof CorpusPayload; value: string | boolean }>;
  non_gmail_payload: CorpusPayload;
}

function schemaV2Corpus(): SchemaV2Corpus {
  return JSON.parse(
    fs.readFileSync(new URL('./side-effect-schema-v2-corpus.json', import.meta.url), 'utf8'),
  ) as SchemaV2Corpus;
}

function fixedCorpusPrivateKey(corpus: SchemaV2Corpus) {
  const seed = Buffer.from(corpus.seed_base64, 'base64');
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

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
    schema_version: 2,
    audit_id: 'abc123',
    profile: 'nanoclaw',
    account_label: 'personal',
    account_email: 'dan@danshapiro.com',
    input_id: 'in-1',
    route_key: 'route-1',
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
    schema_version: 2,
    audit_id: 'abc123',
    profile: 'nanoclaw',
    account_label: 'personal',
    account_email: 'dan@danshapiro.com',
    input_id: 'in-1',
    route_key: 'route-1',
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
  it('uses the shared schema-v2 golden bytes and rejects every adversarial substitution', () => {
    const corpus = schemaV2Corpus();
    const key = fixedCorpusPrivateKey(corpus);
    const publicKey = createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString();
    const canonical = canonicalSideEffectPayload(corpus.payload);
    expect(canonical).toBe(corpus.canonical);
    expect(canonicalSideEffectPayload(corpus.unicode_payload)).toBe(corpus.unicode_canonical);
    const signature = edSign(null, Buffer.from(canonical), key).toString('base64');
    expect(verifyGwsSideEffectSignature(canonical, signature, publicKey)).toBe('valid');
    for (const substitution of corpus.adversarial) {
      const mutated = canonicalSideEffectPayload({
        ...corpus.payload,
        [substitution.field]: substitution.value,
      });
      expect(verifyGwsSideEffectSignature(mutated, signature, publicKey), substitution.field).toBe('invalid');
    }
  });

  it('rejects validly signed reads and plausible unknown operations outside the exact 154-write artifact', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    for (const [service, method] of [
      ['gmail', 'users.messages.list'],
      ['gmail', 'users.drafts.archiveForever'],
    ]) {
      const value = {
        ...schemaV2Corpus().payload,
        audit_id: `audit-${method}`,
        service,
        method,
      };
      const payload = canonicalSideEffectPayload(value);
      const signature = edSign(null, Buffer.from(payload), privateKey).toString('base64');
      const validated = classifyAndSanitize(
        {
          kind: 'gws_mutation_completed',
          payload_schema_version: 2,
          audit_id: value.audit_id,
          profile: value.profile,
          account_label: value.account_label,
          account_email: value.account_email,
          input_id: value.input_id,
          route_key: value.route_key,
          operation: `${service} ${method}`,
          occurred_at: value.occurred_at,
          payload,
          signature,
        },
        { gwsPublicKey: pem },
      );
      expect(validated?.validation.authoritative, method).toBe(false);
      expect(validated?.validation.reason, method).toBe('gws_operation_not_exact_guarded_write');
    }
  });

  it('requires exact signed account/correlation/operation duplicates and derives non-Gmail kind from signed operation', () => {
    const corpus = schemaV2Corpus();
    const key = fixedCorpusPrivateKey(corpus);
    const publicKey = createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString();
    const canonical = canonicalSideEffectPayload(corpus.payload);
    const signature = edSign(null, Buffer.from(canonical), key).toString('base64');
    const validRecord = {
      kind: 'gmail_draft_created',
      payload_schema_version: 2,
      audit_id: corpus.payload.audit_id,
      profile: corpus.payload.profile,
      account_label: corpus.payload.account_label,
      account_email: corpus.payload.account_email,
      input_id: corpus.payload.input_id,
      route_key: corpus.payload.route_key,
      response_input_id: corpus.payload.input_id,
      response_route_key: corpus.payload.route_key,
      response_service: corpus.payload.service,
      response_method: corpus.payload.method,
      operation: `${corpus.payload.service} ${corpus.payload.method}`,
      occurred_at: corpus.payload.occurred_at,
      payload: canonical,
      signature,
    };
    const valid = classifyAndSanitize(validRecord, { gwsPublicKey: publicKey });
    expect(valid?.validation.authoritative).toBe(true);
    expect(valid?.accountLabel).toBe('personal');
    expect(valid?.accountEmail).toBe('dan@danshapiro.com');

    for (const changed of [
      { account_label: 'glowforge' },
      { account_email: 'dan@glowforge.com' },
      { input_id: 'other-input' },
      { route_key: 'other-route' },
      { operation: 'drive files.create' },
    ]) {
      expect(
        classifyAndSanitize({ ...validRecord, ...changed }, { gwsPublicKey: publicKey })?.validation.authoritative,
      ).toBe(false);
    }

    const drivePayload = canonicalSideEffectPayload(corpus.non_gmail_payload);
    const driveSignature = edSign(null, Buffer.from(drivePayload), key).toString('base64');
    const drive = classifyAndSanitize(
      {
        ...validRecord,
        kind: 'gmail_draft_created',
        payload_schema_version: 2,
        audit_id: corpus.non_gmail_payload.audit_id,
        account_label: corpus.non_gmail_payload.account_label,
        account_email: corpus.non_gmail_payload.account_email,
        input_id: corpus.non_gmail_payload.input_id,
        route_key: corpus.non_gmail_payload.route_key,
        response_input_id: corpus.non_gmail_payload.input_id,
        response_route_key: corpus.non_gmail_payload.route_key,
        response_service: corpus.non_gmail_payload.service,
        response_method: corpus.non_gmail_payload.method,
        operation: 'drive files.create',
        occurred_at: corpus.non_gmail_payload.occurred_at,
        payload: drivePayload,
        signature: driveSignature,
      },
      { gwsPublicKey: publicKey },
    );
    expect(drive?.validation.authoritative).toBe(true);
    expect(drive?.kind).toBe('gws_mutation_completed');
    expect(drive?.operation).toBe('drive files.create');
  });

  it('never promotes unversioned legacy evidence even when its old validation claimed authoritative', () => {
    const legacy = classifyAndSanitize({ kind: 'gmail_draft_created', audit_id: 'legacy-1' });
    expect(legacy?.payloadSchemaVersion).toBe(1);
    expect(legacy?.validation.authoritative).toBe(false);
    expect(legacy?.validation.reason).toContain('legacy');
    expect(legacy?.accountLabel).toBeNull();
    expect(legacy?.accountEmail).toBeNull();
  });

  it('verifies/rejects each shared vector exactly', () => {
    for (const v of buildCrossCheckVectors()) {
      const got = verifyGwsSideEffectSignature(v.payload, v.signatureB64, v.publicKey);
      expect(got, v.name).toBe(v.expected);
    }
  });

  it('canonical payload bytes match the Go/TS cross-language contract', () => {
    const canonical = canonicalSideEffectPayload({
      schema_version: 2,
      audit_id: 'abc123',
      profile: 'nanoclaw',
      account_label: 'personal',
      account_email: 'dan@danshapiro.com',
      input_id: 'in-1',
      route_key: 'route-1',
      service: 'gmail',
      method: 'users.drafts.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-05-29T00:00:00.000Z',
      result_digest: 'deadbeef',
    });
    expect(canonical).toBe(
      '{"schema_version":2,"audit_id":"abc123","profile":"nanoclaw","account_label":"personal","account_email":"dan@danshapiro.com","input_id":"in-1","route_key":"route-1","service":"gmail","method":"users.drafts.create","request_class":"api","api_effect":true,"operation_succeeded":true,"occurred_at":"2026-05-29T00:00:00.000Z","result_digest":"deadbeef"}',
    );
  });

  it('rejects an audit_id-rebinding: a valid signature over payload audit_id:"X" attached to a record audit_id:"Y" is NOT authoritative', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

    // Genuine signature over a payload whose embedded audit_id is "X".
    const signedPayloadX = canonicalSideEffectPayload({
      schema_version: 2,
      audit_id: 'X',
      profile: 'nanoclaw',
      account_label: 'personal',
      account_email: 'dan@danshapiro.com',
      input_id: 'in-1',
      route_key: 'route-1',
      service: 'gmail',
      method: 'users.drafts.create',
      request_class: 'api',
      api_effect: true,
      operation_succeeded: true,
      occurred_at: '2026-05-29T00:00:00.000Z',
      result_digest: 'r-abc',
    });
    const sigOverX = edSign(null, Buffer.from(signedPayloadX, 'utf8'), privateKey).toString('base64');
    const duplicateFields = {
      payload_schema_version: 2,
      profile: 'nanoclaw',
      account_label: 'personal',
      account_email: 'dan@danshapiro.com',
      input_id: 'in-1',
      route_key: 'route-1',
      response_input_id: 'in-1',
      response_route_key: 'route-1',
      response_service: 'gmail',
      response_method: 'users.drafts.create',
      operation: 'gmail users.drafts.create',
      occurred_at: '2026-05-29T00:00:00.000Z',
    };

    // The PURE verify still passes — the signature genuinely covers these bytes.
    expect(verifyGwsSideEffectSignature(signedPayloadX, sigOverX, pem)).toBe('valid');

    // …but binding it to a record whose own audit_id (idempotency key) is "Y"
    // must downgrade to NOT authoritative, so a genuine past signature cannot be
    // replayed under a different idempotency key.
    const rebound = classifyAndSanitize(
      {
        kind: 'gmail_draft_created',
        ...duplicateFields,
        audit_id: 'Y',
        signature: sigOverX,
        payload: signedPayloadX,
        evidence: { draft_id: 'r-abc' },
      },
      { gwsPublicKey: pem },
    );
    expect(rebound?.id).toBe('Y');
    expect(rebound?.validation.authoritative).toBe(false);
    expect(rebound?.validation.reason).toBe('gws_binding_invalid');

    // Control: the same signature attached to the MATCHING record audit_id "X"
    // IS authoritative, proving only the rebinding (not the signature) was rejected.
    const matched = classifyAndSanitize(
      {
        kind: 'gmail_draft_created',
        ...duplicateFields,
        audit_id: 'X',
        signature: sigOverX,
        payload: signedPayloadX,
        evidence: { draft_id: 'r-abc' },
      },
      { gwsPublicKey: pem },
    );
    expect(matched?.validation.authoritative).toBe(true);
  });
});
