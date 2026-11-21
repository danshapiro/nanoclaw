import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NormalizedOption } from '../../channels/ask-question.js';
import type { ResponsePayload } from '../../response-registry.js';
import type { Session } from '../../types.js';
import { log } from '../../log.js';

export interface BrowseRequest {
  requestId: string;
  purpose: string;
  url: string;
  browser: string;
  hostInputId: string;
  routeKey: string;
}
export interface BrowseRequester {
  userId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  messagingGroupId: string | null;
  isGroup: 0 | 1 | null;
}
export interface BrowseGrant {
  token: string;
  sessionId: string;
  requestId: string;
  browser: string;
  expiresAt: string;
  maximumExpiresAt: string;
}
export interface BrowseRecord {
  status: 'pending' | 'approved' | 'stopping' | 'revocation_failed' | 'cancelled' | 'expired' | 'ended';
  requestId: string;
  purpose: string;
  url: string;
  browser: string;
  token?: string;
  expiresAt?: string;
}
export interface BrowseDependencies {
  broker: {
    grant(request: { sessionId: string; requestId: string; browser: string }): Promise<BrowseGrant>;
    revoke(sessionId: string): Promise<void>;
    reset(): Promise<void>;
  };
  getSession(id: string): Session | undefined;
  writeRecord(session: Session, record: BrowseRecord): void;
  sendCard(
    session: Session,
    id: string,
    question: string,
    options: NormalizedOption[],
    requester: BrowseRequester,
  ): Promise<{
    channelType: string;
    platformId: string;
    threadId: string | null;
    messageId: string;
  }>;
  saveRender(id: string, options: NormalizedOption[]): void;
  deleteRender(id: string): void;
  notify(session: Session, text: string, requester: BrowseRequester): void;
  now(): number;
}
interface State {
  session: Session;
  request: BrowseRequest;
  requester: BrowseRequester;
  questionId: string;
  status: 'pending' | 'granting' | 'approved' | 'stopping' | 'revocation_failed' | 'cancelled' | 'expired' | 'ended';
  pendingDeadline: number;
  nextRevokeAt?: number;
  requestedEndStatus?: 'cancelled' | 'expired' | 'ended';
  card?: { channelType: string; platformId: string; threadId: string | null; messageId: string };
  timer?: NodeJS.Timeout;
}
const options = (active: boolean): NormalizedOption[] =>
  active
    ? [{ label: 'Stop', selectedLabel: 'Stopping browser access…', value: 'stop' }]
    : [
        { label: 'Allow session', selectedLabel: 'Starting browser access…', value: 'allow' },
        { label: 'Cancel', selectedLabel: 'Browser access cancelled', value: 'cancel' },
      ];
const identifier = (value: string): string => value.split(':').at(-1) ?? value;

export function validateBrowseRequest(content: Record<string, unknown>): BrowseRequest {
  for (const key of ['requestId', 'purpose', 'url', 'browser', 'hostInputId', 'routeKey']) {
    if (
      typeof content[key] !== 'string' ||
      !content[key].trim() ||
      content[key].length > (key === 'purpose' ? 1000 : 2048)
    ) {
      throw new Error(`Browse session requires a valid ${key}.`);
    }
  }
  const url = new URL(content.url as string);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Browse starting URL must be an HTTP(S) page without embedded credentials.');
  }
  return Object.fromEntries(
    ['requestId', 'purpose', 'url', 'browser', 'hostInputId', 'routeKey'].map((key) => [key, content[key]]),
  ) as unknown as BrowseRequest;
}

export function resolveBrowseRequester(
  db: Database.Database,
  session: Session,
  request: BrowseRequest,
  pointer: { inputId?: unknown; routeKey?: unknown; sessionId?: unknown } | null,
): BrowseRequester {
  if (
    pointer &&
    (pointer.sessionId !== session.id ||
      pointer.inputId !== request.hostInputId ||
      pointer.routeKey !== request.routeKey)
  ) {
    throw new Error('Browse approval requires the current host input and route.');
  }
  if (!pointer) {
    const latest = db
      .prepare(
        `SELECT host_accepted_input_id AS inputId, host_accepted_route_key AS routeKey, host_accepted_at AS acceptedAt FROM messages_in WHERE host_accepted_input_id IS NOT NULL AND kind IN ('chat','chat-sdk') AND channel_type='discord' AND trigger=1 ORDER BY host_accepted_at DESC, seq DESC LIMIT 1`,
      )
      .get() as { inputId: string; routeKey: string; acceptedAt: string } | undefined;
    if (
      !latest ||
      latest.inputId !== request.hostInputId ||
      latest.routeKey !== request.routeKey ||
      !Number.isFinite(Date.parse(latest.acceptedAt)) ||
      Date.now() - Date.parse(latest.acceptedAt) > 600000
    )
      throw new Error('Browse approval requires the current recently host-accepted human request.');
  }
  const rows = db
    .prepare(
      `SELECT content, channel_type, platform_id, thread_id, messaging_group_id, is_group, host_acceptance_ended_at, host_accepted_at FROM messages_in
    WHERE host_accepted_input_id = ? AND host_accepted_route_key = ?
      AND kind IN ('chat', 'chat-sdk') AND channel_type = 'discord' AND trigger = 1 ORDER BY seq DESC`,
    )
    .all(request.hostInputId, request.routeKey) as Array<{
    content: string;
    channel_type: string;
    platform_id: string;
    thread_id: string | null;
    messaging_group_id: string | null;
    is_group: 0 | 1 | null;
    host_acceptance_ended_at: string | null;
    host_accepted_at: string | null;
  }>;
  for (const row of rows) {
    if (
      row.host_acceptance_ended_at &&
      (!row.host_accepted_at || Date.now() - Date.parse(row.host_accepted_at) > 600000)
    )
      continue;
    const body = JSON.parse(row.content) as { senderId?: unknown; author?: { isMe?: boolean; isBot?: boolean } };
    if (typeof body.senderId !== 'string' || !body.senderId || body.author?.isMe || body.author?.isBot) continue;
    return {
      userId: body.senderId,
      channelType: row.channel_type,
      platformId: row.platform_id,
      threadId: row.thread_id,
      messagingGroupId: row.messaging_group_id,
      isGroup: row.is_group,
    };
  }
  throw new Error(
    'Browse approval requires a live host-accepted human Discord request. Scheduled or agent messages cannot approve browser access.',
  );
}

/** The agent can request a card; only an actual matching platform click can grant a permit. */
export class BrowseApprovalService {
  private states = new Map<string, State>();
  private initialization?: Promise<void>;
  constructor(private deps: BrowseDependencies) {}
  initialize(): Promise<void> {
    if (!this.initialization)
      this.initialization = this.deps.broker.reset().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    return this.initialization;
  }
  questionId(sessionId: string): string | undefined {
    return this.states.get(sessionId)?.questionId;
  }
  private record(state: State, status: BrowseRecord['status'], grant?: BrowseGrant): void {
    const { requestId, purpose, url, browser } = state.request;
    this.deps.writeRecord(state.session, {
      status,
      requestId,
      purpose,
      url,
      browser,
      ...(grant ? { token: grant.token, expiresAt: grant.expiresAt } : {}),
    });
  }
  private isCurrent(state: State): boolean {
    return this.states.get(state.session.id) === state;
  }
  private arm(state: State, milliseconds: number): void {
    clearTimeout(state.timer);
    state.timer = setTimeout(
      () => {
        void this.finish(state, 'expired').catch((error) => {
          log.error('Browse expiry could not revoke the broker permit', {
            sessionId: state.session.id,
            requestId: state.request.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      Math.max(1, milliseconds),
    );
    state.timer.unref();
  }
  private async revoke(operation: () => Promise<void>, sessionId: string): Promise<void> {
    let failure: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await operation();
        return;
      } catch (error) {
        failure = error;
        log.warn('Browse broker revocation attempt failed', {
          sessionId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw failure;
  }
  private async finish(state: State, status: 'cancelled' | 'expired' | 'ended'): Promise<void> {
    if (!this.isCurrent(state)) return;
    state.status = 'stopping';
    state.requestedEndStatus = status;
    clearTimeout(state.timer);
    this.record(state, 'stopping');
    try {
      await this.revoke(() => this.deps.broker.revoke(state.session.id), state.session.id);
    } catch (error) {
      state.status = 'revocation_failed';
      state.nextRevokeAt = this.deps.now() + 30000;
      this.record(state, 'revocation_failed');
      this.deps.saveRender(state.questionId, options(true));
      try {
        state.card = await this.deps.sendCard(
          state.session,
          state.questionId,
          'Browser access could not be stopped because the approval service is unavailable. Access may still be active. Do not continue browsing; use Stop to retry.',
          options(true),
          state.requester,
        );
      } catch (cardError) {
        log.error('Could not show failed Browse stop control', {
          sessionId: state.session.id,
          error: cardError instanceof Error ? cardError.message : String(cardError),
        });
      }
      this.deps.notify(
        state.session,
        'Browse stop failed. Browser access may still be active; do not continue. No new browsing task can be approved until stopping succeeds.',
        state.requester,
      );
      throw error;
    }
    state.status = status;
    this.deps.deleteRender(state.questionId);
    this.record(state, status);
    this.states.delete(state.session.id);
    try {
      await this.deps.sendCard(
        state.session,
        state.questionId,
        `Browser access ${status}. A new browsing task needs fresh approval.`,
        [],
        state.requester,
      );
    } catch (error) {
      log.warn('Could not show completed Browse stop', {
        sessionId: state.session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.deps.notify(
      state.session,
      `Browse session ${status}. A new browsing task needs fresh human approval.`,
      state.requester,
    );
  }
  async request(session: Session, request: BrowseRequest, requester: BrowseRequester): Promise<void> {
    await this.initialize();
    if (session.status !== 'active') throw new Error('Browse session is not active.');
    const old = this.states.get(session.id);
    if (old?.request.requestId === request.requestId) {
      if (old.status === 'revocation_failed' || old.status === 'stopping')
        throw new Error('Previous browser access has not been confirmed stopped.');
      return;
    }
    if (old && !['cancelled', 'expired', 'ended'].includes(old.status)) await this.finish(old, 'ended');
    else await this.revoke(() => this.deps.broker.revoke(session.id), session.id);
    const state: State = {
      session,
      request,
      requester,
      questionId: `browse-${randomUUID().replaceAll('-', '')}`,
      status: 'pending',
      pendingDeadline: this.deps.now() + 600000,
    };
    this.states.set(session.id, state);
    this.record(state, 'pending');
    this.deps.saveRender(state.questionId, options(false));
    try {
      state.card = await this.deps.sendCard(
        session,
        state.questionId,
        `Allow browser access for this task?\n\n${request.purpose}\nStarting page: ${request.url}\nBrowser: ${request.browser}\n\nThis session can use existing signed-in accounts. It does not authorize purchases or other unrelated actions. Access ends when stopped, after ten minutes idle, or after one hour.`,
        options(false),
        requester,
      );
      this.arm(state, 600000);
    } catch (error) {
      await this.finish(state, 'cancelled');
      throw error;
    }
  }
  canRespond(payload: ResponsePayload): boolean {
    const state = [...this.states.values()].find((entry) => entry.questionId === payload.questionId);
    const receipt = payload.transportReceipt;
    return (
      !!state &&
      !!state.card &&
      (state.status !== 'pending' || this.deps.now() < state.pendingDeadline) &&
      ['pending', 'approved', 'revocation_failed'].includes(state.status) &&
      this.deps.getSession(state.session.id)?.status === 'active' &&
      receipt?.source === 'discord-component' &&
      payload.channelType === 'discord' &&
      identifier(payload.userId ?? '') === identifier(state.requester.userId) &&
      receipt.channelId === identifier(state.card.threadId ?? state.card.platformId) &&
      receipt.messageId === identifier(state.card.messageId) &&
      (state.status === 'pending' ? ['allow', 'cancel'].includes(payload.value) : payload.value === 'stop')
    );
  }
  async respond(payload: ResponsePayload): Promise<boolean | 'rejected'> {
    if (!payload.questionId.startsWith('browse-')) return false;
    const state = [...this.states.values()].find((entry) => entry.questionId === payload.questionId);
    if (!state || !state.card || !['pending', 'approved', 'revocation_failed'].includes(state.status))
      return 'rejected';
    const receipt = payload.transportReceipt;
    if (
      !receipt ||
      receipt.source !== 'discord-component' ||
      payload.channelType !== 'discord' ||
      identifier(payload.userId ?? '') !== identifier(state.requester.userId) ||
      receipt.channelId !== identifier(state.card.threadId ?? state.card.platformId) ||
      receipt.messageId !== identifier(state.card.messageId)
    )
      return 'rejected';
    if (this.deps.getSession(state.session.id)?.status !== 'active') {
      await this.finish(state, 'expired');
      return 'rejected';
    }
    if (state.status === 'pending' && this.deps.now() >= state.pendingDeadline) {
      await this.finish(state, 'expired');
      return 'rejected';
    }
    if (state.status === 'pending' && payload.value === 'cancel') {
      await this.finish(state, 'cancelled');
      return true;
    }
    if (['approved', 'revocation_failed'].includes(state.status) && payload.value === 'stop') {
      await this.finish(state, 'ended');
      return true;
    }
    if (state.status !== 'pending' || payload.value !== 'allow') return 'rejected';
    state.status = 'granting';
    clearTimeout(state.timer);
    try {
      const grant = await this.deps.broker.grant({
        sessionId: state.session.id,
        requestId: state.request.requestId,
        browser: state.request.browser,
      });
      if (
        !this.isCurrent(state) ||
        state.status !== 'granting' ||
        this.deps.getSession(state.session.id)?.status !== 'active'
      ) {
        await this.revoke(() => this.deps.broker.revoke(state.session.id), state.session.id);
        return 'rejected';
      }
      if (
        grant.sessionId !== state.session.id ||
        grant.requestId !== state.request.requestId ||
        grant.browser !== state.request.browser ||
        !grant.token ||
        !Number.isFinite(Date.parse(grant.maximumExpiresAt))
      )
        throw new Error('Browse broker returned an invalid session grant.');
      state.status = 'approved';
      this.record(state, 'approved', grant);
      this.deps.saveRender(state.questionId, options(true));
      state.card = await this.deps.sendCard(
        state.session,
        state.questionId,
        `Browse session active: ${state.request.purpose}\nBrowser: ${state.request.browser}\nUse Stop to end browser access.`,
        options(true),
        state.requester,
      );
      this.arm(state, Date.parse(grant.maximumExpiresAt) - this.deps.now());
      this.deps.notify(
        state.session,
        'Browse session approved by the requesting human. The current task can continue; finish with browse end.',
        state.requester,
      );
      return true;
    } catch (error) {
      await this.finish(state, 'ended');
      throw error;
    }
  }
  async end(session: Session, requestId: string): Promise<void> {
    const state = this.states.get(session.id);
    if (state?.request.requestId === requestId) await this.finish(state, 'ended');
  }
  async endPending(session: Session, hostInputId: string): Promise<void> {
    const state = this.states.get(session.id);
    if (state?.status === 'pending' && state.request.hostInputId === hostInputId) await this.finish(state, 'ended');
  }
  async sweepInactiveSessions(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.status === 'revocation_failed' && this.deps.now() >= (state.nextRevokeAt ?? 0)) {
        await this.finish(state, state.requestedEndStatus ?? 'ended');
        continue;
      }
      if (
        ['pending', 'granting', 'approved'].includes(state.status) &&
        this.deps.getSession(state.session.id)?.status !== 'active'
      ) {
        await this.finish(state, 'ended');
      }
    }
  }
  async shutdown(): Promise<void> {
    for (const state of this.states.values()) {
      clearTimeout(state.timer);
      this.record(state, 'stopping');
    }
    try {
      await this.revoke(() => this.deps.broker.reset(), 'all');
    } catch (error) {
      for (const state of this.states.values()) {
        state.status = 'revocation_failed';
        this.record(state, 'revocation_failed');
      }
      throw error;
    }
    for (const state of this.states.values()) {
      this.deps.deleteRender(state.questionId);
      this.record(state, 'ended');
    }
    this.states.clear();
    this.initialization = undefined;
  }
}
