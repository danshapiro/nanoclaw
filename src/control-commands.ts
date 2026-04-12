export const DISCORD_CONTROL_COMMANDS = [
  {
    name: 'help',
    description: 'Show Yente command help and usage',
  },
  {
    name: 'status',
    description: 'Show model, tokens, uptime, and failing services',
  },
  {
    name: 'new',
    description: 'Start a fresh Yente session',
  },
  {
    name: 'clear',
    description: 'Clear the current session (same as /new)',
  },
  {
    name: 'compact',
    description: 'Compact the current Yente session',
  },
] as const;

export type ControlCommand = (typeof DISCORD_CONTROL_COMMANDS)[number]['name'];

const CONTROL_COMMAND_SET = new Set<ControlCommand>(
  DISCORD_CONTROL_COMMANDS.map((command) => command.name),
);

export function extractTextControlCommand(
  content: string,
): ControlCommand | null {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return null;
  if (!CONTROL_COMMAND_SET.has(normalized as ControlCommand)) return null;
  return normalized as ControlCommand;
}

export function toSessionSlashCommand(
  command: Extract<ControlCommand, 'new' | 'clear' | 'compact'>,
): '/new' | '/clear' | '/compact' {
  return `/${command}`;
}

export function getHelpText(): string {
  return [
    'Yente commands',
    '',
    '/help or help',
    'Show this help.',
    '',
    '/status or status',
    'Show the current model, tokens, uptime, and failing services.',
    '',
    '/new or new',
    'Start a fresh session.',
    '',
    '/clear or clear',
    'Clear the current session. Same as /new.',
    '',
    '/compact or compact',
    'Compact the current session.',
    '',
    'Ask Yente to do real work in normal prose.',
  ].join('\n');
}
