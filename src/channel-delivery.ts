import type { OutboundFile } from './channels/adapter.js';
import { getChannelAdapter, getChannelStartStates } from './channels/channel-registry.js';
import { DeliveryUnavailableError } from './delivery-errors.js';

/** Dispatch a message or fail explicitly before any platform request. */
export async function deliverToChannel(
  channelType: string,
  platformId: string,
  threadId: string | null,
  kind: string,
  content: string,
  files?: OutboundFile[],
): Promise<string | undefined> {
  const adapter = getChannelAdapter(channelType);
  if (!adapter) {
    const state = getChannelStartStates().get(channelType)?.status;
    throw new DeliveryUnavailableError(
      `No active adapter for ${channelType} (state: ${state ?? 'unconfigured'})`,
      state === 'starting' || state === 'retrying',
    );
  }
  return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
}
