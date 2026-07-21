import { registerProvider } from './provider-registry.js';
import {
  normalizeQueryTurnInput,
  type AgentProvider,
  type AgentQuery,
  type ProviderEvent,
  type ProviderOptions,
  type QueryInput,
} from './types.js';

/**
 * Mock provider for testing. Returns canned responses.
 * Supports push() — queued messages produce additional results.
 */
export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private responseFactory: (prompt: string) => string;

  constructor(_options: ProviderOptions = {}, responseFactory?: (prompt: string) => string) {
    this.responseFactory = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
  }

  isSessionInvalid(_err: unknown, _opts: { attemptedContinuation?: string } = {}): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const pending: Array<{ inputId: string; prompt: string; acceptInput: () => Promise<void> }> = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const responseFactory = this.responseFactory;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: `mock-session-${Date.now()}` };

        // Process initial prompt — accept synchronously, then resolve it.
        if (input.inputId) {
          await input.acceptInput();
          yield { type: 'input-accepted', inputId: input.inputId, scope: 'initial' };
        }
        yield { type: 'activity' };
        yield {
          type: 'result',
          text: responseFactory(input.prompt),
          inputId: input.inputId,
          resolvedInputIds: input.inputId ? [input.inputId] : [],
        };

        // Process any pushed follow-ups
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            if (msg.inputId) {
              await msg.acceptInput();
              yield { type: 'input-accepted', inputId: msg.inputId, scope: 'followup' };
            }
            yield {
              type: 'result',
              text: responseFactory(msg.prompt),
              inputId: msg.inputId,
              resolvedInputIds: msg.inputId ? [msg.inputId] : [],
            };
            continue;
          }
          // Wait for push() or end()
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        // Drain remaining
        while (pending.length > 0) {
          const msg = pending.shift()!;
          if (msg.inputId) {
            await msg.acceptInput();
            yield { type: 'input-accepted', inputId: msg.inputId, scope: 'followup' };
          }
          yield {
            type: 'result',
            text: responseFactory(msg.prompt),
            inputId: msg.inputId,
            resolvedInputIds: msg.inputId ? [msg.inputId] : [],
          };
        }
      },
    };

    return {
      push(message) {
        const turn = normalizeQueryTurnInput(message);
        pending.push({ inputId: turn.inputId, prompt: turn.prompt, acceptInput: turn.acceptInput });
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events,
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }
}

registerProvider('mock', (opts) => new MockProvider(opts));
