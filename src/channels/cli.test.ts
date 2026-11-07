import { describe, expect, it } from 'vitest';
import { createCliAdapter } from './cli.js';

describe('CLI delivery', () => {
  it('retains messages for retry when no terminal is connected', async () => {
    const adapter = createCliAdapter();
    await expect(adapter.deliver('local', null, { kind: 'chat', content: { text: 'hello' } })).rejects.toMatchObject({
      name: 'DeliveryUnavailableError',
      retryable: true,
    });
  });

  it('rejects invalid destinations before attempting a send', async () => {
    const adapter = createCliAdapter();
    await expect(adapter.deliver('invalid', null, { kind: 'chat', content: { text: 'hello' } })).rejects.toMatchObject({
      name: 'DeliveryUnavailableError',
      retryable: false,
    });
  });
});
