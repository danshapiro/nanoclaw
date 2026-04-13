const DEFAULT_ASSISTANT_NAME = 'Andy';

export function personalizeClaudeMd(
  content: string,
  assistantName: string,
): string {
  if (assistantName === DEFAULT_ASSISTANT_NAME) {
    return content;
  }

  return content
    .replace(/^# Andy$/gm, () => `# ${assistantName}`)
    .replace(/You are Andy/g, () => `You are ${assistantName}`)
    .replace(/@Andy\b/g, () => `@${assistantName}`);
}
