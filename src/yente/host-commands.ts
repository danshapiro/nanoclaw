import { gateCommand } from '../command-gate.js';
import { rollActiveSession, type SessionMode } from '../session-manager.js';
import type { AgentGroup, MessagingGroup, Session } from '../types.js';

export type YenteHostCommandName = 'help' | 'status' | 'new' | 'clear' | 'compact';

export interface YenteHostCommandContext {
  content: string;
  userId: string | null;
  agentGroup: AgentGroup;
  messagingGroup: MessagingGroup;
  session: Session;
  sessionMode: SessionMode;
}

export type YenteHostCommandResult =
  | { handled: false }
  | { handled: true; outboundText: string; sessionForOutbound: Session };

const COMMANDS = new Set<YenteHostCommandName>(['help', 'status', 'new', 'clear', 'compact']);
const STARTED_AT = Date.now();

export function parseYenteHostCommandFromContent(content: string): YenteHostCommandName | null {
  const text = extractText(content).trim();
  if (!text) return null;

  if (text.startsWith('/')) {
    const command = text.slice(1).split(/\s+/)[0]?.toLowerCase();
    return isYenteCommand(command) ? command : null;
  }

  const bare = text.toLowerCase();
  return isYenteCommand(bare) ? bare : null;
}

export function handleYenteHostCommand(context: YenteHostCommandContext): YenteHostCommandResult {
  const command = parseYenteHostCommandFromContent(context.content);
  if (!command) return { handled: false };

  if (command === 'help') {
    return {
      handled: true,
      sessionForOutbound: context.session,
      outboundText: [
        'Yente commands:',
        '/help - show this help.',
        '/status - show current runtime status.',
        '/new - start a fresh session for this conversation.',
        '/clear - start a fresh session for this conversation.',
        '/compact - compact the active session.',
      ].join('\n'),
    };
  }

  if (command === 'status') {
    return {
      handled: true,
      sessionForOutbound: context.session,
      outboundText: [
        'Yente status:',
        `Uptime: ${formatDuration(Date.now() - STARTED_AT)}`,
        `Session: ${context.session.id}`,
        `Token availability: ${tokenAvailabilitySummary()}`,
        'Service health: host command path is responsive.',
      ].join('\n'),
    };
  }

  if (command === 'compact') {
    const gate = gateCommand('/compact', context.userId, context.agentGroup.id);
    if (gate.action === 'deny') {
      return denied(command, context.session);
    }
    return { handled: false };
  }

  const gate = gateCommand('/clear', context.userId, context.agentGroup.id);
  if (gate.action === 'deny') {
    return denied(command, context.session);
  }

  const fresh = rollActiveSession({
    agentGroupId: context.agentGroup.id,
    messagingGroupId: context.messagingGroup.id,
    threadId: context.session.thread_id,
    sessionMode: context.sessionMode,
  });

  return {
    handled: true,
    sessionForOutbound: fresh,
    outboundText: `Started a fresh session: ${fresh.id}`,
  };
}

function denied(command: YenteHostCommandName, session: Session): YenteHostCommandResult {
  return {
    handled: true,
    sessionForOutbound: session,
    outboundText: `Permission denied: /${command} requires admin access.`,
  };
}

function isYenteCommand(command: string | undefined): command is YenteHostCommandName {
  return command !== undefined && COMMANDS.has(command as YenteHostCommandName);
}

function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch (err) {
    if (err instanceof SyntaxError) {
      return content;
    }
    throw err;
  }
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function tokenAvailabilitySummary(): string {
  const known = [
    'ONECLI_API_KEY',
    'GWS_PROXY_KEY',
    'MSGVAULT_PROXY_KEY',
    'FAMILIAR_PROXY_KEY',
    'NYNE_PROXY_KEY',
  ].filter((key) => Boolean(process.env[key]));
  if (known.length === 0) return 'unknown';
  return `${known.length} configured`;
}
