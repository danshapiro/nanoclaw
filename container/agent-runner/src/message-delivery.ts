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

/** Match the opening emphasis delimiter, not unrelated stars later in the text. */
function hasClosingEmphasis(text: string): boolean {
  const opening = text.match(/^\*+/)?.[0].length ?? 0;
  if (!opening || /\s/.test(text[opening] ?? ' ')) return false;
  const delimiters = [{ count: opening, originalCount: opening, canClose: false }];
  for (let index = opening; index < text.length; index++) {
    if (text[index] === '\\') {
      index++;
      continue;
    }
    // Stars inside inline code cannot close Markdown emphasis.
    if (text[index] === '`') {
      let count = 1;
      while (text[index + count] === '`') count++;
      const closing = text.indexOf('`'.repeat(count), index + count);
      if (closing >= 0) {
        index = closing + count - 1;
        continue;
      }
    }
    if (text[index] !== '*') continue;
    let count = 1;
    while (text[index + count] === '*') count++;
    const previous = text[index - 1];
    const next = text[index + count] ?? ' ';
    const beforeSpace = /\s/.test(previous);
    const afterSpace = /\s/.test(next);
    const beforePunctuation = /[\p{P}\p{S}]/u.test(previous);
    const afterPunctuation = /[\p{P}\p{S}]/u.test(next);
    const canClose = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
    const canOpen = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
    let remaining = count;
    if (canClose) {
      while (remaining > 0) {
        let opener = delimiters.length - 1;
        // CommonMark's rule of three prevents an intraword ** from closing
        // the initial * in '*foo**bar**' (and the inverse for bold text).
        while (opener >= 0) {
          const candidate = delimiters[opener];
          const ambiguous = canOpen || candidate.canClose;
          const ruleOfThree =
            ambiguous &&
            (candidate.originalCount + count) % 3 === 0 &&
            (candidate.originalCount % 3 !== 0 || count % 3 !== 0);
          if (!ruleOfThree) break;
          opener--;
        }
        if (opener < 0) break;
        const matched = delimiters[opener].count >= 2 && remaining >= 2 ? 2 : 1;
        delimiters[opener].count -= matched;
        remaining -= matched;
        if (opener === 0 && delimiters[opener].count === 0) return true;
        // Unmatched delimiters inside this matched span become literal text.
        delimiters.length = opener + (delimiters[opener].count > 0 ? 1 : 0);
      }
    }
    if (canOpen && remaining > 0) delimiters.push({ count: remaining, originalCount: count, canClose });
    index += count - 1;
  }
  return false;
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

/** Keep each contiguous delivery group distinct so a queue marker cannot capture a correction. */
export function groupMessageDeliveries(
  messages: MessageInRow[],
): Array<{ messages: MessageInRow[]; mode: MessageDeliveryMode }> {
  const groups: Array<{ messages: MessageInRow[]; mode: MessageDeliveryMode }> = [];
  for (const message of messages) {
    const delivery = prepareMessageDelivery(message);
    const last = groups.at(-1);
    if (last?.mode === delivery.mode && !isCompactControl(delivery.message) && !last.messages.some(isCompactControl))
      last.messages.push(delivery.message);
    else groups.push({ messages: [delivery.message], mode: delivery.mode });
  }
  return groups;
}
