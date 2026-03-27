import { RegisteredGroup, NewMessage } from './types.js';
import {
  extractRemoteControlCommand,
  RemoteControlCommand,
} from './remote-control-command.js';

function looksLikeAssistantEcho(
  content: string,
  assistantName: string,
): boolean {
  return content
    .trim()
    .toLowerCase()
    .startsWith(`${assistantName.toLowerCase()}:`);
}

export function extractInboundRemoteControlCommand(
  msg: NewMessage,
  triggerPattern: RegExp,
  assistantName: string,
  group?: RegisteredGroup,
): RemoteControlCommand | null {
  if (msg.is_bot_message) return null;
  if (msg.is_from_me && looksLikeAssistantEcho(msg.content, assistantName)) {
    return null;
  }

  return extractRemoteControlCommand(msg.content, triggerPattern, {
    allowNaturalLanguage: group?.isMain === true,
  });
}
