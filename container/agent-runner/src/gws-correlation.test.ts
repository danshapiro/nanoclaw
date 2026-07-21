import { describe, expect, it } from 'bun:test';

import { canonicalGwsCorrelationAuthPayload } from './gws-correlation.js';

describe('GWS correlation authentication contract', () => {
  it('serializes the host protocol tuple in the fixed cross-boundary order', () => {
    const payload = canonicalGwsCorrelationAuthPayload({
      schemaVersion: 2,
      action: 'bind',
      requestId: '11111111-1111-4111-8111-111111111111',
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      providerName: 'opencode',
      leaseId: 'lease-1',
      claimToken: 'claim-1',
      sequence: 4,
      providerAcceptance: {
        event: 'input-accepted',
        scope: 'followup',
        acceptedAt: '2026-05-29T00:00:02.000Z',
      },
      originalAcceptedAt: '2026-05-29T00:00:01.000Z',
      inputId: 'in-1',
      routeKey: 'opencode|discord|chan-1|dm:mg-1',
      messageIds: ['m-2', 'm-1'],
      mac: '',
    });
    expect(payload).toBe(
      '["nanoclaw-gws-correlation-v2","bind","11111111-1111-4111-8111-111111111111","ag-1","sess-1","opencode","lease-1","claim-1",4,"in-1","opencode|discord|chan-1|dm:mg-1",["m-1","m-2"],"2026-05-29T00:00:01.000Z","input-accepted","followup","2026-05-29T00:00:02.000Z"]',
    );
  });
});
