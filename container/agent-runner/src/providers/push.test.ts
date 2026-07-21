import { describe, expect, it, mock } from 'bun:test';

import { CodexProvider } from './codex.js';
import { MockProvider } from './mock.js';
import type { ProviderEvent } from './types.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Pull the next event of a given type off a single, persistent provider event
 * iterator. Awaiting forces the generator body to run, which is exactly what
 * drives input-accepted/result emission in the synchronous-ish providers
 * (Mock, Claude). OpenCode/Codex need a runtime seam (Task 3) before this
 * works, which is why Task 1 asserts the event contract on Mock and Claude
 * only.
 */
async function nextEvent(iter: AsyncIterator<ProviderEvent>, type: ProviderEvent['type']): Promise<ProviderEvent> {
  for (;;) {
    const { value, done } = await iter.next();
    if (done) throw new Error(`stream ended before a '${type}' event`);
    if (value.type === type) return value;
  }
}

describe('provider input-accepted/result contract', () => {
  it('mock provider echoes inputId on input-accepted and resolves it on result', async () => {
    const provider = new MockProvider({}, (prompt) => `seen: ${prompt}`);
    const query = provider.query({ inputId: 'initial-1', acceptInput: async () => {}, prompt: 'hello', cwd: '/tmp' });
    const iter = query.events[Symbol.asyncIterator]();

    await expect(nextEvent(iter, 'input-accepted')).resolves.toMatchObject({
      type: 'input-accepted',
      inputId: 'initial-1',
      scope: 'initial',
    });

    // Resolve the initial input first, then push a follow-up.
    await expect(nextEvent(iter, 'result')).resolves.toMatchObject({
      type: 'result',
      inputId: 'initial-1',
      resolvedInputIds: ['initial-1'],
    });

    query.push({ inputId: 'followup-1', acceptInput: async () => {}, prompt: 'later' });
    await expect(nextEvent(iter, 'input-accepted')).resolves.toMatchObject({
      type: 'input-accepted',
      inputId: 'followup-1',
      scope: 'followup',
    });

    await expect(nextEvent(iter, 'result')).resolves.toMatchObject({
      type: 'result',
      inputId: 'followup-1',
      resolvedInputIds: ['followup-1'],
    });
    query.end();
  });

  it('claude provider emits input-accepted with the matching inputId when the SDK stream accepts the prompt', async () => {
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: string } }> }) =>
        (async function* () {
          let count = 0;
          for await (const _msg of prompt) {
            count++;
            if (count >= 1) {
              yield { type: 'result', result: 'ok' };
              return;
            }
          }
        })(),
    }));

    const { ClaudeProvider } = await import('./claude.js');
    const provider = new ClaudeProvider();
    const query = provider.query({
      inputId: 'claude-initial',
      acceptInput: async () => {},
      prompt: 'hello',
      cwd: '/tmp',
    });
    const iter = query.events[Symbol.asyncIterator]();

    const accepted = await nextEvent(iter, 'input-accepted');
    expect(accepted).toMatchObject({ type: 'input-accepted', inputId: 'claude-initial', scope: 'initial' });
    query.end();
  });

  it('claude does not emit input acceptance when the SDK never consumes the queued prompt', async () => {
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: () =>
        (async function* () {
          return;
        })(),
    }));
    const { ClaudeProvider } = await import('./claude.js');
    const query = new ClaudeProvider().query({
      inputId: 'claude-unconsumed',
      acceptInput: async () => {},
      prompt: 'hello',
      cwd: '/tmp',
    });
    const events: ProviderEvent[] = [];
    for await (const event of query.events) events.push(event);
    expect(events.some((event) => event.type === 'input-accepted')).toBe(false);
  });

  it('claude provider translates compact boundaries as progress without resolving input', async () => {
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: string } }> }) =>
        (async function* () {
          for await (const _msg of prompt) {
            yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 165000 } };
            yield { type: 'result', result: 'ok' };
            return;
          }
        })(),
    }));

    const { ClaudeProvider } = await import('./claude.js');
    const provider = new ClaudeProvider();
    const query = provider.query({
      inputId: 'claude-compact',
      acceptInput: async () => {},
      prompt: 'hello',
      cwd: '/tmp',
    });
    const iter = query.events[Symbol.asyncIterator]();

    await expect(nextEvent(iter, 'input-accepted')).resolves.toMatchObject({
      type: 'input-accepted',
      inputId: 'claude-compact',
      scope: 'initial',
    });
    await expect(nextEvent(iter, 'progress')).resolves.toMatchObject({
      type: 'progress',
      inputId: 'claude-compact',
      message: 'Context compacted (165,000 tokens compacted).',
    });
    await expect(nextEvent(iter, 'result')).resolves.toMatchObject({
      type: 'result',
      inputId: 'claude-compact',
      resolvedInputIds: ['claude-compact'],
    });
    query.end();
  });

  it('claude blocks prompt consumption and PreToolUse until the exact host gate acknowledges', async () => {
    let sdkOptions: any;
    let promptConsumed = false;
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: unknown }) => {
        sdkOptions = options;
        return (async function* () {
          for await (const _message of prompt) {
            promptConsumed = true;
            yield { type: 'result', result: 'ok' };
            return;
          }
        })();
      },
    }));
    const gate = deferred<void>();
    const { ClaudeProvider } = await import('./claude.js');
    const query = new ClaudeProvider().query({
      inputId: 'claude-gated',
      acceptInput: () => gate.promise,
      prompt: 'do work',
      cwd: '/tmp',
    });
    const iter = query.events[Symbol.asyncIterator]();
    const accepted = nextEvent(iter, 'input-accepted');
    await Promise.resolve();
    const preTool = sdkOptions.hooks.PreToolUse[0].hooks[0];
    let toolContinued = false;
    const tool = preTool(
      { tool_name: 'Bash', tool_input: {}, tool_use_id: 'tool-before-first-event' },
      'tool-before-first-event',
      { signal: new AbortController().signal },
    ).then((value: unknown) => {
      toolContinued = true;
      return value;
    });
    await Promise.resolve();
    expect(promptConsumed).toBe(false);
    expect(toolContinued).toBe(false);

    gate.resolve();
    await expect(accepted).resolves.toMatchObject({ type: 'input-accepted', inputId: 'claude-gated' });
    await expect(tool).resolves.toMatchObject({ continue: true });
    query.abort();
  });

  it('claude does not replace an accepted pointer while an older tool lease is active', async () => {
    let sdkOptions: any;
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: unknown }) => {
        sdkOptions = options;
        return (async function* () {
          for await (const _message of prompt) yield { type: 'assistant', message: { content: [] } };
        })();
      },
    }));
    const { ClaudeProvider } = await import('./claude.js');
    const query = new ClaudeProvider().query({
      inputId: 'claude-old',
      acceptInput: async () => {},
      prompt: 'first',
      cwd: '/tmp',
    });
    const iter = query.events[Symbol.asyncIterator]();
    await nextEvent(iter, 'input-accepted');
    const preTool = sdkOptions.hooks.PreToolUse[0].hooks[0];
    const postTool = sdkOptions.hooks.PostToolUse[0].hooks[0];
    await preTool({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'old-tool' }, 'old-tool', {
      signal: new AbortController().signal,
    });
    let followupGateCalled = false;
    query.push({
      inputId: 'claude-new',
      acceptInput: async () => {
        followupGateCalled = true;
      },
      prompt: 'second',
    });
    const followupAccepted = nextEvent(iter, 'input-accepted');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(followupGateCalled).toBe(false);

    await postTool({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'old-tool' }, 'old-tool', {
      signal: new AbortController().signal,
    });
    await expect(followupAccepted).resolves.toMatchObject({ inputId: 'claude-new', scope: 'followup' });
    expect(followupGateCalled).toBe(true);
    query.abort();
  });

  it('claude cancels prompt consumption when the trusted bind fails', async () => {
    let promptConsumed = false;
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
        (async function* () {
          for await (const _message of prompt) {
            promptConsumed = true;
            yield { type: 'result', result: 'must not run' };
          }
        })(),
    }));
    const { ClaudeProvider } = await import('./claude.js');
    const query = new ClaudeProvider().query({
      inputId: 'claude-rejected',
      acceptInput: async () => {
        throw new Error('host bind rejected');
      },
      prompt: 'do not run',
      cwd: '/tmp',
    });
    await expect(nextEvent(query.events[Symbol.asyncIterator](), 'input-accepted')).rejects.toThrow(
      'host bind rejected',
    );
    expect(promptConsumed).toBe(false);
  });
});

describe('provider push attachment compatibility', () => {
  it('mock provider accepts structured follow-up turns and ignores attachments', async () => {
    const provider = new MockProvider({}, (prompt) => `seen: ${prompt}`);
    const query = provider.query({ inputId: 'mock-first', acceptInput: async () => {}, prompt: 'first', cwd: '/tmp' });
    const results: Array<string | null> = [];

    setTimeout(
      () =>
        query.push({
          inputId: 'mock-second',
          acceptInput: async () => {},
          prompt: 'second',
          attachments: [fixtureAttachment()],
        }),
      10,
    );
    setTimeout(() => query.end(), 20);

    for await (const event of query.events) {
      if (event.type === 'result') results.push(event.text);
    }

    expect(results).toEqual(['seen: first', 'seen: second']);
  });

  it('codex provider accepts structured follow-up turns before its event stream starts', () => {
    const provider = new CodexProvider();
    const query = provider.query({ inputId: 'codex-first', acceptInput: async () => {}, prompt: 'first', cwd: '/tmp' });

    expect(() =>
      query.push({
        inputId: 'codex-second',
        acceptInput: async () => {},
        prompt: 'second',
        attachments: [fixtureAttachment()],
      }),
    ).not.toThrow();
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
    const query = provider.query({
      inputId: 'claude-first',
      acceptInput: async () => {},
      prompt: 'first',
      cwd: '/tmp',
    });
    const drain = (async () => {
      for await (const _event of query.events) {
        // Drain until the mocked SDK returns.
      }
    })();

    query.push({
      inputId: 'claude-second',
      acceptInput: async () => {},
      prompt: 'second',
      attachments: [fixtureAttachment()],
    });
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
