import type { MessageInRow } from './db/messages-in.js';
import { writeTypingActivity } from './db/session-state.js';
import { currentLaunchLeaseId } from './gws-correlation.js';

export type TypingDestination = { platformId: string; threadId: string | null };

/** Only selected Discord bridge trigger rows represent Discord-origin work. */
function destinationsFor(rows: MessageInRow[]): TypingDestination[] {
  return rows
    .filter((row) => row.kind === 'chat-sdk' && row.trigger === 1 && row.channel_type === 'discord' && row.platform_id)
    .map((row) => ({ platformId: row.platform_id!, threadId: row.thread_id }));
}

export class TypingActivity {
  private readonly inputs = new Map<string, TypingDestination[]>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private failures = 0;
  private readonly publish: ((targets: TypingDestination[]) => void) | undefined;

  constructor(
    publish?: (targets: TypingDestination[]) => void,
    private readonly sessionId: string | null = process.env.NANOCLAW_SESSION_ID ?? null,
  ) {
    const lease = currentLaunchLeaseId();
    this.publish = publish ?? (lease ? (targets) => writeTypingActivity(lease, targets) : undefined);
  }

  private update(): void {
    const unique = new Map<string, TypingDestination>();
    for (const targets of this.inputs.values())
      for (const target of targets) unique.set(JSON.stringify(target), target);
    try {
      this.publish?.([...unique.values()]);
      if (this.failures)
        console.error(
          JSON.stringify({
            severity: 'info',
            event: 'typing_activity_publication_recovered',
            session_id: this.sessionId,
            failures: this.failures,
          }),
        );
      this.failures = 0;
      if (!this.inputs.size && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    } catch (err) {
      this.failures++;
      if (this.failures === 1 || this.failures % 12 === 0)
        console.error(
          JSON.stringify({
            severity: 'warn',
            event: 'typing_activity_publication_failed',
            session_id: this.sessionId,
            destinations: [...unique.values()],
            failures: this.failures,
            error: String(err),
          }),
        );
    }
  }

  select(inputId: string, rows: MessageInRow[]): void {
    const destinations = destinationsFor(rows);
    if (!destinations.length) return;
    this.inputs.set(inputId, destinations);
    this.update();
    if (!this.timer) {
      this.timer = setInterval(() => this.update(), 5000);
      this.timer.unref();
    }
  }

  resolve(inputIds: string[]): void {
    let changed = false;
    for (const id of inputIds) changed = this.inputs.delete(id) || changed;
    if (changed) this.update();
  }

  clear(): void {
    this.resolve([...this.inputs.keys()]);
  }
}
