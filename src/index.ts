/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { DATA_DIR } from './config.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphansVerified } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { cleanupStaleContainerEnvFiles, drainAllContainers } from './container-runner.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import {
  expireAllStaleGwsCorrelations,
  startGwsCorrelationIpcWatcher,
  stopGwsCorrelationIpcWatcher,
} from './gws-correlation-ipc.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });
  // 1b. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphansVerified();
  expireAllStaleGwsCorrelations();
  startGwsCorrelationIpcWatcher();
  // Sweep per-container --env-file leftovers from a previous crash — they hold
  // secret-bearing env values and must not accumulate.
  cleanupStaleContainerEnvFiles();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    function routeInboundForAdapter(
      platformId: string,
      threadId: string | null,
      message: Parameters<ChannelSetup['onInbound']>[2],
      strict: boolean,
    ): Promise<void> | void {
      const route = routeInbound({
        channelType: adapter.channelType,
        platformId,
        threadId,
        message: {
          id: message.id,
          kind: message.kind,
          content: JSON.stringify(message.content),
          timestamp: message.timestamp,
          isMention: message.isMention,
          isGroup: message.isGroup,
        },
      }).catch((err) => {
        log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        if (strict) throw err;
      });
      if (strict) return route;
    }

    return {
      onInbound(platformId, threadId, message) {
        routeInboundForAdapter(platformId, threadId, message, false);
      },
      onInboundStrict(platformId, threadId, message) {
        return routeInboundForAdapter(platformId, threadId, message, true) as Promise<void>;
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  log.info('NanoClaw running');
}

let shutdownInProgress = false;

/**
 * Graceful shutdown. Exported for tests — `exit` is injectable so tests can
 * observe the exit code without killing the test process.
 *
 * Order matters: pollers stop FIRST so nothing re-wakes containers mid-drain,
 * then module shutdown callbacks, then the container drain (docker stop with
 * a real grace period + wait for the `docker run` client processes to exit —
 * otherwise systemd finds them lingering in the cgroup and SIGKILLs the unit
 * into a spurious failure), then channel adapter teardown.
 */
export async function runShutdown(signal: string, exit: (code: number) => void = process.exit): Promise<void> {
  if (shutdownInProgress) {
    log.warn('Repeated shutdown signal — exiting immediately', { signal });
    exit(0);
    return;
  }
  shutdownInProgress = true;
  log.info('Shutdown signal received', { signal });

  // Watchdog: if anything below hangs, exit cleanly before systemd's
  // TimeoutStopSec expires and turns the stop into a unit failure.
  setTimeout(() => exit(0), 60_000).unref();

  // 1. Stop pollers first so nothing re-wakes containers during the drain.
  stopDeliveryPolls();
  stopHostSweep();

  // 2. Module shutdown callbacks.
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }

  // 3. Drain active containers so no docker run clients outlive the process.
  await drainAllContainers(30);

  // 3b. Stop accepting IPC only after drain. This closes transports but never
  // revokes any interval whose container failed to confirm termination.
  stopGwsCorrelationIpcWatcher();

  // 4. Channel adapter teardown.
  await teardownChannelAdapters();
  exit(0);
}

process.on('SIGTERM', () => void runShutdown('SIGTERM'));
process.on('SIGINT', () => void runShutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
