import fs from 'node:fs';
import { deleteHostQuestionRender, setHostQuestionRender } from '../../channels/ask-question.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import {
  onShutdown,
  onStartup,
  registerPlatformActionPreflight,
  registerResponseHandler,
  RejectedPlatformAction,
} from '../../response-registry.js';
import { hostCorrelationPath } from '../../session-manager.js';
import { notifyAgent } from '../approvals/primitive.js';
import { BrowseControlClient } from './broker.js';
import { DATA_DIR } from '../../config.js';
import { BrowseRecordStore } from './records.js';
import {
  BrowseApprovalService,
  resolveBrowseRequester,
  validateBrowseRequest,
  type BrowseRequester,
} from './service.js';

const title = 'Chrome browser session';
const records = new BrowseRecordStore(DATA_DIR);
const service = new BrowseApprovalService({
  broker: new BrowseControlClient(),
  getSession,
  now: Date.now,
  writeRecord(session, record) {
    records.write(session, record);
    log.info('Browse session state changed', {
      sessionId: session.id,
      requestId: record.requestId,
      status: record.status,
    });
  },
  async sendCard(_session, id, question, options, requester) {
    const adapter = getDeliveryAdapter();
    if (!adapter) throw new Error('Discord delivery is unavailable for browser approval.');
    const messageId = await adapter.deliver(
      requester.channelType,
      requester.platformId,
      requester.threadId,
      'chat-sdk',
      JSON.stringify({ type: 'ask_question', questionId: id, title, question, options }),
    );
    if (!messageId) throw new Error('Browser approval card was not acknowledged by Discord.');
    return { ...requester, messageId };
  },
  saveRender(id, options) {
    setHostQuestionRender(id, { title, options });
  },
  deleteRender: deleteHostQuestionRender,
  notify: notifyAgent,
});

registerDeliveryAction('request_browse_session', async (content, session, inDb) => {
  let requester: BrowseRequester | undefined;
  try {
    const request = validateBrowseRequest(content);
    const pointerPath = hostCorrelationPath(session.agent_group_id, session.id);
    let pointer = null;
    try {
      pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    requester = resolveBrowseRequester(inDb, session, request, pointer);
    await service.request(session, request, requester);
  } catch (error) {
    log.warn('Browse session request failed', {
      sessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    });
    notifyAgent(
      session,
      `Browse could not request approval: ${error instanceof Error ? error.message : String(error)} Browser access remains blocked.`,
      requester,
    );
  }
});
registerDeliveryAction('close_browse_session', async (content, session) => {
  if (typeof content.requestId !== 'string' || !content.requestId) {
    await service.endPending(session, typeof content.hostInputId === 'string' ? content.hostInputId : '');
    return;
  }
  await service.end(session, content.requestId);
});
registerPlatformActionPreflight((payload) =>
  payload.questionId.startsWith('browse-') ? service.canRespond(payload) : undefined,
);
registerResponseHandler(async (payload) => {
  const result = await service.respond(payload);
  if (result === 'rejected') throw new RejectedPlatformAction('Browse approval does not match a live human request.');
  return result;
});
let sweepTimer: NodeJS.Timeout | undefined;
let sweeping = false;
onStartup(async () => {
  const invalidated = records.invalidateAfterRestart();
  log.info('Previous-process Browse access files invalidated', { count: invalidated });
  try {
    await service.initialize();
  } catch (error) {
    log.warn('Browse approval control is unavailable; new requests remain blocked', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  sweepTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void service
      .sweepInactiveSessions()
      .catch((error) =>
        log.error('Browse inactive-session revocation failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        sweeping = false;
      });
  }, 1000);
  sweepTimer.unref();
});
onShutdown(() => {
  clearInterval(sweepTimer);
  return service.shutdown();
});
