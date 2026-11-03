import type { MessageInRow } from './db/messages-in.js';
import { writeTypingActivity } from './db/session-state.js';
import { currentLaunchLeaseId } from './gws-correlation.js';

export type TypingDestination = { platformId: string; threadId: string | null };

export class TypingActivity {
  private readonly inputs = new Map<string, { destinations: TypingDestination[]; messageIds: string[] }>();
  private readonly completed = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private failures = 0;
  private readonly publish: ((targets: TypingDestination[], acknowledgedMessageIds: string[]) => void) | undefined;

  constructor(
    publish?: (targets: TypingDestination[], acknowledgedMessageIds: string[]) => void,
    private readonly sessionId: string | null = process.env.NANOCLAW_SESSION_ID ?? null,
  ) {
    const lease = currentLaunchLeaseId();
    this.publish = publish ?? (lease ? (targets, ids) => writeTypingActivity(lease, targets, ids) : undefined);
  }

  private update(): void {
    const unique = new Map<string, TypingDestination>();
    const now = Date.now();
    for (const [id, completedAt] of this.completed) if (now - completedAt >= 15_000) this.completed.delete(id);
    const acknowledged = new Set(this.completed.keys());
    for (const input of this.inputs.values()) {
      for (const target of input.destinations) unique.set(JSON.stringify(target), target);
      for (const id of input.messageIds) acknowledged.add(id);
    }
    try {
      this.publish?.([...unique.values()], [...acknowledged]);
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
    // Only selected Discord bridge trigger rows represent Discord-origin work.
    const selected = rows.filter(
      (row) => row.kind === 'chat-sdk' && row.trigger === 1 && row.channel_type === 'discord' && row.platform_id,
    );
    if (!selected.length) return;
    this.inputs.set(inputId, {
      destinations: selected.map((row) => ({ platformId: row.platform_id!, threadId: row.thread_id })),
      messageIds: selected.map((row) => row.id),
    });
    this.update();
    if (!this.timer) {
      this.timer = setInterval(() => this.update(), 5000);
      this.timer.unref();
    }
  }

  resolve(inputIds: string[]): void {
    let changed = false;
    for (const id of inputIds) {
      const input = this.inputs.get(id);
      if (!input) continue;
      for (const messageId of input.messageIds) this.completed.set(messageId, Date.now());
      this.inputs.delete(id);
      changed = true;
    }
    if (changed) this.update();
  }

  clear(): void {
    this.resolve([...this.inputs.keys()]);
  }
}
