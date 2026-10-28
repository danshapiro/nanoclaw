import { Parser } from 'commonmark';

import type { MessageInRow } from './db/messages-in.js';

export type MessageDeliveryMode = 'steer' | 'queue';

function isCompactControl(message: MessageInRow): boolean {
  if (message.kind !== 'chat' && message.kind !== 'chat-sdk') return false;
  try {
    return JSON.parse(message.content)?.text?.trim().toLowerCase() === '/compact';
  } catch {
    return false;
  }
}

const markdown = new Parser();

/** Only parsed emphasis beginning at the first source character matches the marker. */
function hasClosingEmphasis(text: string): boolean {
  const leadingInline = markdown.parse(text).firstChild?.firstChild;
  return leadingInline?.type === 'emph' || leadingInline?.type === 'strong';
}

/** Return a model-facing copy; the durable inbound row keeps the user's text. */
export function prepareMessageDelivery(message: MessageInRow): { message: MessageInRow; mode: MessageDeliveryMode } {
  if ((message.kind !== 'chat' && message.kind !== 'chat-sdk') || message.channel_type === 'agent') {
    return { message, mode: 'queue' };
  }
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(message.content);
  } catch {
    return { message, mode: 'steer' };
  }
  const text = content?.text;
  if (typeof text === 'string' && text.trim().toLowerCase() === '/compact') return { message, mode: 'queue' };
  if (typeof text !== 'string' || !text.startsWith('*') || hasClosingEmphasis(text)) {
    return { message, mode: 'steer' };
  }
  return { message: { ...message, content: JSON.stringify({ ...content, text: text.slice(1) }) }, mode: 'queue' };
}

/** Group delivery policies while retaining the original, host-gated command metadata. */
export function groupMessageDeliveries(
  messages: MessageInRow[],
): Array<{ messages: MessageInRow[]; mode: MessageDeliveryMode }> {
  const groups: Array<{ messages: MessageInRow[]; mode: MessageDeliveryMode }> = [];
  for (const message of messages) {
    const { mode } = prepareMessageDelivery(message);
    const last = groups.at(-1);
    if (last?.mode === mode && !isCompactControl(message) && !last.messages.some(isCompactControl))
      last.messages.push(message);
    else groups.push({ messages: [message], mode });
  }
  return groups;
}
