export type RemoteControlCommand = '/remote-control' | '/remote-control-end';

interface ExtractRemoteControlCommandOptions {
  allowNaturalLanguage?: boolean;
}

const REMOTE_CONTROL_PATTERN = /\bremote[- ]control\b/;
const START_REMOTE_CONTROL_PATTERN =
  /\b(?:start|open|enable|launch|begin|create|reopen)\b(?: (?:a|the))?(?: new)?\s+remote[- ]control\b(?: session)?/;
const REQUEST_REMOTE_CONTROL_LINK_PATTERN =
  /\b(?:give|send)\s+me\b.*\bremote[- ]control (?:link|url)\b|\bshare\b.*\bremote[- ]control (?:link|url)\b.*\bwith\s+me\b|\b(?:can|could|would)\s+you\s+(?:give|send|share)\b.*\bremote[- ]control (?:link|url)\b|\b(?:can|could|may)\s+(?:i|we)\s+(?:get|have)\b.*\bremote[- ]control (?:link|url)\b|\b(?:need|want)\b(?: (?:the|a))?\s+remote[- ]control (?:link|url)\b|\bplease\s+(?:give|send|share)\b.*\bremote[- ]control (?:link|url)\b/;
const STOP_VERB_PATTERN = /\b(?:stop|disable|cancel|close)\b/;
const STOP_REMOTE_CONTROL_PATTERN =
  /\b(?:stop|disable|cancel|close)\b(?: (?:the))?\s+remote[- ]control\b(?: session)?|\b(?<!-)end\b(?: (?:the))?\s+remote[- ]control\b(?: session)?|\bremote[- ]control\b(?: session)?\s+(?:off|stop|disable|cancel|close|end)\b/;

function normalizeMessage(content: string): string {
  return content
    .toLowerCase()
    .replace(/[?!.,:;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractRemoteControlCommand(
  content: string,
  triggerPattern: RegExp,
  options: ExtractRemoteControlCommandOptions = {
    allowNaturalLanguage: false,
  },
): RemoteControlCommand | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const withoutTrigger = trimmed.replace(triggerPattern, '').trim();
  if (!withoutTrigger) return null;

  if (
    withoutTrigger === '/remote-control' ||
    withoutTrigger === '/remote-control-end'
  ) {
    return withoutTrigger;
  }

  if (options.allowNaturalLanguage !== true) return null;

  const normalized = normalizeMessage(withoutTrigger);
  const hasRemoteControl = REMOTE_CONTROL_PATTERN.test(normalized);
  if (!hasRemoteControl) return null;

  const wantsStart =
    START_REMOTE_CONTROL_PATTERN.test(normalized) ||
    REQUEST_REMOTE_CONTROL_LINK_PATTERN.test(normalized);
  const hasAmbiguousControlVerbs =
    STOP_VERB_PATTERN.test(normalized) && wantsStart;

  if (hasAmbiguousControlVerbs) return null;

  if (STOP_REMOTE_CONTROL_PATTERN.test(normalized)) {
    return '/remote-control-end';
  }

  if (wantsStart) {
    return '/remote-control';
  }

  return null;
}
