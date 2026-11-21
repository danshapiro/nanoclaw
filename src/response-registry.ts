/**
 * Response handler + shutdown callback registries.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * or `onShutdown()` at import time don't hit a TDZ error on the const-array
 * declarations. index.ts imports src/modules/index.js for its side effects,
 * which triggers module registrations that would otherwise happen before
 * index.ts's own const initializers have run.
 *
 * Keep this file dependency-free (log.js is fine, but nothing from
 * modules/* or index.ts itself). Any file imported here must not in turn
 * import from src/index.ts, or the cycle returns.
 */

export interface ResponsePayload {
  questionId: string;
  value: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Produced only by an authenticated platform component callback, never agent output. */
  transportReceipt?: { source: 'discord-component'; channelId: string; messageId: string };
}

export type ResponseHandler = (payload: ResponsePayload) => Promise<boolean>;

/** A claimed platform action that must leave the original approval card usable. */
export class RejectedPlatformAction extends Error {}

type PlatformActionPreflight = (payload: ResponsePayload) => boolean | undefined;
const platformActionPreflights: PlatformActionPreflight[] = [];
export function registerPlatformActionPreflight(check: PlatformActionPreflight): void {
  platformActionPreflights.push(check);
}
/** Fast local authorization runs before acknowledging or consuming a platform card. */
export function canDispatchPlatformAction(payload: ResponsePayload): boolean {
  return platformActionPreflights.every((check) => check(payload) !== false);
}

const responseHandlers: ResponseHandler[] = [];

export function registerResponseHandler(handler: ResponseHandler): void {
  responseHandlers.push(handler);
}

export function getResponseHandlers(): readonly ResponseHandler[] {
  return responseHandlers;
}

const startupCallbacks: Array<() => void | Promise<void>> = [];
export function onStartup(callback: () => void | Promise<void>): void {
  startupCallbacks.push(callback);
}
export async function runModuleStartup(): Promise<void> {
  for (const callback of startupCallbacks) await callback();
}

type ShutdownCallback = () => void | Promise<void>;
const shutdownCallbacks: ShutdownCallback[] = [];

export function onShutdown(cb: ShutdownCallback): void {
  shutdownCallbacks.push(cb);
}

export function getShutdownCallbacks(): readonly ShutdownCallback[] {
  return shutdownCallbacks;
}
