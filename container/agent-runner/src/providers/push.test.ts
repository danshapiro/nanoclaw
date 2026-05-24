import { describe, expect, it, mock } from 'bun:test';

import { CodexProvider } from './codex.js';
import { MockProvider } from './mock.js';

describe('provider push attachment compatibility', () => {
  it('mock provider accepts structured follow-up turns and ignores attachments', async () => {
    const provider = new MockProvider({}, (prompt) => `seen: ${prompt}`);
    const query = provider.query({ prompt: 'first', cwd: '/tmp' });
    const results: Array<string | null> = [];

    setTimeout(() => query.push({ prompt: 'second', attachments: [fixtureAttachment()] }), 10);
    setTimeout(() => query.end(), 20);

    for await (const event of query.events) {
      if (event.type === 'result') results.push(event.text);
    }

    expect(results).toEqual(['seen: first', 'seen: second']);
  });

  it('codex provider accepts structured follow-up turns before its event stream starts', () => {
    const provider = new CodexProvider();
    const query = provider.query({ prompt: 'first', cwd: '/tmp' });

    expect(() => query.push({ prompt: 'second', attachments: [fixtureAttachment()] })).not.toThrow();
    query.abort();
  });

  it('claude provider accepts structured follow-up turns and sends only prompt text to the SDK stream', async () => {
    const pushed: string[] = [];
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: string } }> }) =>
        (async function* () {
          for await (const msg of prompt) {
            pushed.push(msg.message.content);
            if (pushed.length >= 2) return;
          }
        })(),
    }));

    const { ClaudeProvider } = await import('./claude.js');
    const provider = new ClaudeProvider();
    const query = provider.query({ prompt: 'first', cwd: '/tmp' });
    const drain = (async () => {
      for await (const _event of query.events) {
        // Drain until the mocked SDK returns.
      }
    })();

    query.push({ prompt: 'second', attachments: [fixtureAttachment()] });
    await drain;

    expect(pushed).toEqual(['first', 'second']);
  });
});

function fixtureAttachment() {
  return {
    path: '/workspace/agent/tmp/fixture.png',
    filename: 'fixture.png',
    mime: 'image/png',
    sizeBytes: 8,
  };
}
