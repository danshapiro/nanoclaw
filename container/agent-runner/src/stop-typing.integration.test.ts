import { expect, it } from 'bun:test';
import { runStopTypingScenario } from './stop-typing.test-scenario.js';

it('keeps cancelled activity stopped during delayed provider cleanup and leaves later work pending', async () => {
  const result = await runStopTypingScenario();
  expect({
    afterStopSnapshots: result.afterStopSnapshots,
    pendingLater: result.pendingLater,
    pushedId: result.pushedId,
  }).toEqual({
    afterStopSnapshots: [],
    pendingLater: true,
    pushedId: 'input-pushed',
  });
  expect(result.bound).toEqual(['input-initial', 'input-pushed']);
  expect(result.released.sort()).toEqual(['input-initial', 'input-pushed']);
  expect(result.completed).toEqual(['initial', 'pending', 'pushed', 'stop']);
  expect(result.recoveryCount).toBe(0);
  expect(result.clearBeforeAck).toBe(true);
}, 15000);
