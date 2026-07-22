export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /**
   * Optional provider-owned scope for stored continuation ids. Providers whose
   * session ids are tied to runtime config should return a stable value derived
   * from that config so model/provider flips start fresh instead of resuming an
   * incompatible prior session.
   */
  readonly continuationScope?: string;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   *
   * `attemptedContinuation` is the continuation id the provider tried to
   * resume. It is REQUIRED metadata: a transport error with no attempted
   * continuation can never be stale-session proof. This is a diagnostic /
   * trigger predicate only — the authoritative continuation clears live in
   * the poll loop (explicit clear-continuation, positive existence check, or
   * the bounded zombie path).
   */
  isSessionInvalid(err: unknown, opts: { attemptedContinuation?: string }): boolean;
}

import type { MessageInRow } from '../db/messages-in.js';

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
}

export interface QueryAttachment {
  path: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}

export interface QueryTurnInput {
  /**
   * Correlation id for this prompt. The poll loop generates one per top-level
   * prompt and per follow-up push, and treats a prompt as accepted only after
   * the provider emits an `input-accepted` for the matching id. Required: every
   * provider turn carries an inputId so results resolve to exact rows.
   */
  inputId: string;

  /**
   * Exact trusted acceptance barrier for THIS queued turn/batch. Providers
   * must await it before exposing the prompt to model-controlled execution.
   * It is intentionally attached per turn because accumulated batches may
   * reuse one inputId while carrying different host claim tokens/message IDs.
   */
  acceptInput: () => Promise<void>;

  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /** Validated files for this provider turn. Providers may ignore them. */
  attachments?: QueryAttachment[];

  /**
   * Original inbound message rows that produced this prompt. Providers may use
   * this to inspect raw message metadata (e.g., to detect slash commands that
   * the formatter wrapped in XML because the provider does not handle them
   * natively).
   */
  messages?: MessageInRow[];

  /**
   * Canonical destination name for the active route. Providers can use it to
   * synthesize properly addressed `<message>` blocks without re-deriving the
   * current destination.
   */
  visibleDestinationName?: string;
}

export interface QueryInput extends QueryTurnInput {
  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };

  /**
   * Relay mode: a separate restricted runtime used only for bounded
   * Yente-authored status relays during long work. Mutation/shell/file/web/
   * question tools are denied; only the route-locked send_message is exposed.
   */
  relayMode?: boolean;
  relayDeadlineMs?: number;
  toolPolicy?: 'normal' | 'status_only';
}

export type ProviderInputScope = 'initial' | 'followup' | 'relay';
export type ProviderContinuationPolicy = 'preserve' | 'clear' | 'unknown';
export type ProviderNoticeSeverity = 'info' | 'warn' | 'error';

export interface ProviderLivenessMetadata {
  configuredTimeoutMs?: number;
  elapsedMs?: number;
  lastEventType?: string;
  lastMeaningfulEventAt?: string | null;
}

export interface ProviderInputResolution {
  inputId?: string;
  resolvedInputIds: string[];
  supersededInputIds?: string[];
}

export interface ProviderInterruption {
  inputId: string;
  classification: string;
  severity: ProviderNoticeSeverity;
  terminal: boolean;
  agentMessage: string;
  fallbackUserMessage: string;
  continuationPolicy: ProviderContinuationPolicy;
  attemptedContinuation?: string;
  liveness?: ProviderLivenessMetadata;
  recoverySeed?: {
    observations?: string[];
    safeToolState?: string;
    sideEffects?: ProviderSideEffect[];
  };
}

export interface ProviderSideEffect {
  id: string;
  inputId: string;
  kind:
    | 'gmail_draft_created'
    | 'gws_mutation_completed'
    | 'summarize_dnd_recording_cached'
    | 'summarize_dnd_summary_artifact'
    | 'tool_completed'
    | 'other';
  label: string;
  payloadSchemaVersion?: number;
  accountLabel?: string | null;
  accountEmail?: string | null;
  evidence: Record<string, string | number | boolean | null>;
  occurredAt: string;
}

/**
 * Capability metadata for a provider. Used by the poll loop to decide whether
 * a separate-runtime relay can carry an inactivity status message during long
 * work, and what relay tool policy/deadline applies.
 */
export interface ProviderCapabilities {
  supportsSeparateRelayRuntime: boolean;
  defaultRelayDeadlineMs?: number;
  relayToolPolicy?: 'status_only';
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export class ProviderQuiescenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderQuiescenceError';
  }
}

/**
 * The provider finished the useful turn and all observable SDK/tool callbacks,
 * but cannot prove that a daemonized descendant did not escape its process
 * group. The runner must retain accepted correlation and exit successfully;
 * the host revokes correlation only after Docker proves the whole container is
 * stopped. Unlike a generic quiescence failure, this is an intentional clean
 * lifecycle handoff and does not turn an already-resolved input into recovery.
 */
export class ProviderContainerStopRequired extends ProviderQuiescenceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderContainerStopRequired';
  }
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(input: string | QueryTurnInput): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /**
   * Force-stop the query and resolve only after every provider process, SDK
   * operation, and admitted tool is quiescent. A rejection is a fatal
   * lifecycle fault: callers must retain accepted correlation for host-side
   * stop/recovery rather than releasing it optimistically.
   */
  abort(): Promise<void>;
}

export function normalizeQueryTurnInput(input: string | QueryTurnInput): QueryTurnInput {
  // A bare-string push (legacy callers, tests) is not ledger-tracked by the
  // poll loop, so it gets a synthetic inputId. The poll loop always passes a
  // structured QueryTurnInput with its own ledger inputId.
  return typeof input === 'string'
    ? {
        inputId: `synthetic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        prompt: input,
        acceptInput: async () => {
          throw new Error('legacy string provider input has no trusted acceptance gate');
        },
      }
    : input;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'input-accepted'; inputId: string; scope: ProviderInputScope }
  | ({ type: 'result'; text: string | null; errorText?: string } & ProviderInputResolution)
  | { type: 'progress'; inputId?: string; message: string }
  | {
      type: 'notice';
      inputId: string;
      classification: string;
      severity: ProviderNoticeSeverity;
      agentMessage?: string;
      fallbackUserMessage: string;
      relayRecommended?: boolean;
      liveness?: ProviderLivenessMetadata;
    }
  | ({ type: 'interruption' } & ProviderInterruption)
  | { type: 'side-effect'; sideEffect: ProviderSideEffect }
  | { type: 'clear-continuation'; inputId: string; reason: string; attemptedContinuation?: string }
  | {
      type: 'activity';
      inputId?: string;
      source?: 'sdk_event' | 'sdk_keepalive' | 'provider_wait_tick' | 'provider_internal';
      liveness?: ProviderLivenessMetadata;
    };
