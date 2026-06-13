import { describe, expect, it } from 'vitest';

import {
  agentMailSenderAuthPoliciesFromEnv,
  buildAgentMailInboundContent,
  defaultAgentMailRouteFile,
  evaluateAgentMailSenderAuthPolicy,
  htmlToPlainText,
  nanoThreadIdForAgentMailMessage,
  normalizedAgentMailHeaders,
  resolveAgentMailRoutes,
} from './agentmail-config.js';

describe('AgentMail route config', () => {
  it('defines exactly the three Yente free-tier inbox routes', () => {
    const file = defaultAgentMailRouteFile();
    expect(file.routes.map((route) => route.localPart)).toEqual(['yente', 'yente-threads', 'yente-aidy']);
    expect(file.routes).toHaveLength(3);
  });

  it('expands local parts with AGENTMAIL_DOMAIN and routes all boxes to main', () => {
    const routes = resolveAgentMailRoutes(defaultAgentMailRouteFile(), { AGENTMAIL_DOMAIN: 'agentmail.to' });
    expect(routes.map((route) => route.inboxId)).toEqual([
      'yente@agentmail.to',
      'yente-threads@agentmail.to',
      'yente-aidy@agentmail.to',
    ]);
    expect(routes.map((route) => route.agentGroupFolder)).toEqual(['main', 'main', 'main']);
    expect(routes.every((route) => route.sessionMode === 'per-thread')).toBe(true);
  });

  it('rejects more than three configured routes', () => {
    const file = defaultAgentMailRouteFile();
    expect(() =>
      resolveAgentMailRoutes(
        { ...file, routes: [...file.routes, { ...file.routes[0]!, localPart: 'extra' }] },
        { AGENTMAIL_DOMAIN: 'agentmail.to' },
      ),
    ).toThrow(/exactly three AgentMail routes/);
  });

  it('parses sender auth policies from the AgentMail greenlist env', () => {
    const policies = agentMailSenderAuthPoliciesFromEnv({
      AGENTMAIL_SENDER_GREENLIST: JSON.stringify({
        'Dan@DanShapiro.com': { spf: 'none', dkim: 'pass-aligned', dmarc: 'none' },
      }),
    });

    expect(policies.get('dan@danshapiro.com')).toEqual({
      spf: 'none',
      dkim: 'pass-aligned',
      dmarc: 'none',
    });
  });

  it('requires every greenlisted sender to carry explicit SPF, DKIM, and DMARC policy', () => {
    expect(() =>
      agentMailSenderAuthPoliciesFromEnv({
        AGENTMAIL_SENDER_GREENLIST: 'dan@danshapiro.com',
      }),
    ).toThrow(/must be a JSON object/);
    expect(() =>
      agentMailSenderAuthPoliciesFromEnv({
        AGENTMAIL_SENDER_GREENLIST: JSON.stringify({
          'dan@danshapiro.com': { spf: 'none', dkim: 'pass-aligned' },
        }),
      }),
    ).toThrow(/dmarc must be a string/);
  });

  it('accepts Dan mail when SPF is none, DKIM is pass-aligned, and DMARC is none', () => {
    expect(
      evaluateAgentMailSenderAuthPolicy(
        {
          inboxId: 'yente@agentmail.to',
          messageId: 'm1',
          from_: 'Dan Shapiro <dan@danshapiro.com>',
          headers: {
            'Authentication-Results':
              'amazonses.com; spf=none smtp.mailfrom=danshapiro.com; dkim=pass header.i=@danshapiro.com; dmarc=none header.from=danshapiro.com',
          },
        },
        'dan@danshapiro.com',
        { spf: 'none', dkim: 'pass-aligned', dmarc: 'none' },
        new Set(['amazonses.com']),
      ),
    ).toEqual({ allowed: true, authservId: 'amazonses.com' });
  });

  it('rejects Dan mail when a DKIM pass is not aligned to the sender domain', () => {
    const result = evaluateAgentMailSenderAuthPolicy(
      {
        inboxId: 'yente@agentmail.to',
        messageId: 'm1',
        from_: 'Dan Shapiro <dan@danshapiro.com>',
        headers: {
          'Authentication-Results':
            'amazonses.com; spf=none smtp.mailfrom=danshapiro.com; dkim=pass header.i=@attacker.example; dmarc=none header.from=danshapiro.com',
        },
      },
      'dan@danshapiro.com',
      { spf: 'none', dkim: 'pass-aligned', dmarc: 'none' },
      new Set(['amazonses.com']),
    );

    expect(result).toMatchObject({
      allowed: false,
      reason: 'sender_auth_failed:dan@danshapiro.com:dkim_pass-aligned_required',
      authservId: 'amazonses.com',
    });
  });

  it('ignores untrusted Authentication-Results headers', () => {
    const result = evaluateAgentMailSenderAuthPolicy(
      {
        inboxId: 'yente@agentmail.to',
        messageId: 'm1',
        from_: 'Dan Shapiro <dan@danshapiro.com>',
        headers: {
          'Authentication-Results':
            'attacker.example; spf=none smtp.mailfrom=danshapiro.com; dkim=pass header.i=@danshapiro.com; dmarc=none header.from=danshapiro.com',
        },
      },
      'dan@danshapiro.com',
      { spf: 'none', dkim: 'pass-aligned', dmarc: 'none' },
      new Set(['amazonses.com']),
    );

    expect(result).toMatchObject({
      allowed: false,
      reason: 'sender_auth_failed:dan@danshapiro.com:authentication_results_missing',
    });
  });

  it('derives stable NanoClaw thread ids without treating yente-threads as email-thread semantics', () => {
    const route = resolveAgentMailRoutes(defaultAgentMailRouteFile(), { AGENTMAIL_DOMAIN: 'agentmail.to' })[1]!;
    expect(route.localPart).toBe('yente-threads');
    expect(
      nanoThreadIdForAgentMailMessage(route, {
        inboxId: route.inboxId,
        messageId: 'msg-1',
        threadId: 'thr-123',
        from: 'ci@example.com',
        subject: 'QA run',
      }),
    ).toBe('agentmail:yente-threads:thr-123');
  });

  it('falls back from missing text to extractedText, extracted_text, and readable html', () => {
    const content = buildAgentMailInboundContent(
      { localPart: 'yente', inboxId: 'yente@agentmail.to', purpose: 'general' },
      {
        inboxId: 'yente@agentmail.to',
        messageId: 'm1',
        threadId: 't1',
        from: 'person@example.com',
        subject: 'Hello',
        extractedText: 'new reply',
        html: '<p>old reply</p>',
      },
    );

    expect(content.text).toContain('Email body:\nnew reply');
    expect(content.extractedText).toBe('new reply');

    expect(htmlToPlainText('<div>Hello&nbsp;<b>Yente</b><br>Line 2</div>')).toBe('Hello Yente\nLine 2');
  });

  it('renders subject and full headers into the agent-visible text', () => {
    const content = buildAgentMailInboundContent(
      { localPart: 'yente-threads', inboxId: 'yente-threads@agentmail.to', purpose: 'qa-internal' },
      {
        inboxId: 'yente-threads@agentmail.to',
        messageId: 'm-headers',
        threadId: 't-headers',
        from_: 'CI Bot <ci@example.com>',
        to: ['Yente Threads <yente-threads@agentmail.to>'],
        cc: ['Observer <observer@example.com>'],
        subject: 'QA header visibility',
        text: 'please inspect the headers',
        headers: {
          Received: ['from mx1.example.test', 'by inbound.agentmail.test'],
          'X-Custom-Trace': 'abc123',
        },
      },
    );

    expect(
      normalizedAgentMailHeaders({
        inboxId: 'yente-threads@agentmail.to',
        messageId: 'm-headers',
        threadId: 't-headers',
        from_: 'CI Bot <ci@example.com>',
        to: ['Yente Threads <yente-threads@agentmail.to>'],
        cc: ['Observer <observer@example.com>'],
        subject: 'QA header visibility',
        text: 'please inspect the headers',
        headers: {
          Received: ['from mx1.example.test', 'by inbound.agentmail.test'],
          'X-Custom-Trace': 'abc123',
        },
      }),
    ).toEqual({
      From: 'CI Bot <ci@example.com>',
      To: 'Yente Threads <yente-threads@agentmail.to>',
      Cc: 'Observer <observer@example.com>',
      Subject: 'QA header visibility',
      Received: ['from mx1.example.test', 'by inbound.agentmail.test'],
      'X-Custom-Trace': 'abc123',
    });
    expect((content as Record<string, unknown>).headers).toBeUndefined();
    expect(content.text).toContain('Email headers:\n');
    expect(content.text).toContain('Subject: QA header visibility');
    expect(content.text).toContain('Received: from mx1.example.test\nReceived: by inbound.agentmail.test');
    expect(content.text).toContain('X-Custom-Trace: abc123');
    expect(content.text).toContain('Email body:\nplease inspect the headers');
  });

  it('uses provider header values without duplicating standard top-level fields', () => {
    expect(
      normalizedAgentMailHeaders({
        inboxId: 'yente@agentmail.to',
        messageId: 'm1',
        threadId: 't1',
        from: 'person@example.com',
        subject: 'Top-level subject',
        headers: {
          Subject: 'Provider subject',
          From: 'Provider Sender <provider@example.com>',
        },
      }),
    ).toEqual({
      From: 'Provider Sender <provider@example.com>',
      Subject: 'Provider subject',
    });
  });
});
