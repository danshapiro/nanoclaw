export type RemoteControlCommand = '/remote-control' | '/remote-control-end';

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

  const normalized = normalizeMessage(withoutTrigger);
  const hasRemoteControl = /\bremote[- ]control\b/.test(normalized);
  if (!hasRemoteControl) return null;

  const wantsStop = /\b(stop|end|disable|close|cancel)\b/.test(normalized);
  if (wantsStop) return '/remote-control-end';

  const wantsStartVerb = /\b(start|open|enable|launch|begin|create)\b/.test(
    normalized,
  );
  const wantsDeliveryVerb = /\b(get|give|send|share)\b/.test(normalized);
  const wantsLink = /\b(link|url|session)\b/.test(normalized);
  const namesLinkDirectly =
    /\bremote[- ]control (link|url|session)\b/.test(normalized) ||
    /\b(link|url|session) for remote[- ]control\b/.test(normalized);

  if (
    wantsStartVerb ||
    (wantsDeliveryVerb && wantsLink) ||
    namesLinkDirectly
  ) {
    return '/remote-control';
  }

  return null;
}
