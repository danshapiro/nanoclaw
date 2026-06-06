/**
 * Actionable terminal error classifier.
 *
 * When a provider (OpenCode) reports a `session.error`, the raw error text is
 * logged but the user must see a *sanitized*, *actionable* message that tells
 * them what happened, whether they can retry, and who needs to fix it.
 *
 * Contract:
 *   - Never embed raw provider text, secrets, URLs, stack traces, or paths.
 *   - Only classify errors we have high confidence about.
 *   - Unrecognized errors fall back to a generic "something went wrong".
 *   - Messages are written for Discord — short, clear, and human.
 *
 * The classification is produced purely from the provider-side error shape so
 * the poll loop and recovery logic do not need to parse it again.
 */

export type ActionableErrorKind =
  | 'insufficient-balance'
  | 'rate-limit'
  | 'auth-failure'
  | 'provider-unavailable'
  | 'model-overloaded'
  | 'unknown';

export interface ActionableError {
  /** Machine-readable kind. */
  kind: ActionableErrorKind;
  /** Short label for the classification — safe for structured logs. */
  label: string;
  /** Message shown to the user in Discord. No raw provider text. */
  userMessage: string;
  /** True if the user can usefully retry the same request. */
  retryable: boolean;
  /** True if an operator (not the user) needs to fix things. */
  operatorActionRequired: boolean;
}

/**
 * Known patterns for "Insufficient balance" from OpenCode.
 * These are exact substrings we look for in the error text.
 */
const INSUFFICIENT_BALANCE_PATTERNS = [
  'insufficient balance',
  'manage your billing',
  'billing',
];

/**
 * Known patterns for rate limit failures.
 */
const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'ratelimit',
  'too many requests',
  '429',
];

/**
 * Known patterns for authentication failures.
 */
const AUTH_FAILURE_PATTERNS = [
  'unauthorized',
  'invalid api key',
  'authentication failed',
  'auth failed',
  'api key invalid',
];

/**
 * Known patterns for provider unavailability / outage.
 */
const PROVIDER_UNAVAILABLE_PATTERNS = [
  'service temporarily unavailable',
  'temporarily unavailable',
  'service unavailable',
  '503',
  'bad gateway',
  '502',
  'gateway timeout',
  '504',
];

/**
 * Known patterns for model overload / capacity.
 */
const MODEL_OVERLOADED_PATTERNS = [
  'model is overloaded',
  'overloaded',
  'capacity',
  'server is busy',
];

function matchesAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/**
 * Extract a human-readable error string from an unknown OpenCode error value.
 * This is only used for *classification* (pattern matching), never for display.
 */
function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const data = (err as { data?: { message?: string } }).data;
    if (data && typeof data.message === 'string') return data.message;
    const message = (err as { message?: string }).message;
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(err);
    } catch {
      return '[unserializable error]';
    }
  }
  return String(err);
}

const FALLBACK_GENERIC: ActionableError = {
  kind: 'unknown',
  label: 'session-error-unknown',
  userMessage:
    'Something went wrong on this turn. Your request is preserved — ask me to continue.',
  retryable: true,
  operatorActionRequired: false,
};

const ERROR_CATALOG: Array<{
  kind: ActionableErrorKind;
  label: string;
  patterns: string[];
  userMessage: string;
  retryable: boolean;
  operatorActionRequired: boolean;
}> = [
  {
    kind: 'insufficient-balance',
    label: 'session-error-insufficient-balance',
    patterns: INSUFFICIENT_BALANCE_PATTERNS,
    userMessage:
      'The AI service account has run out of balance, so I cannot complete your request right now. This affects all Yente agents — an operator needs to add funds. Your request is preserved; you can retry once billing is restored.',
    retryable: true,
    operatorActionRequired: true,
  },
  {
    kind: 'rate-limit',
    label: 'session-error-rate-limit',
    patterns: RATE_LIMIT_PATTERNS,
    userMessage:
      'The AI service is rate-limiting requests right now. Your request is preserved — ask me to continue in a moment and I will retry.',
    retryable: true,
    operatorActionRequired: false,
  },
  {
    kind: 'auth-failure',
    label: 'session-error-auth-failure',
    patterns: AUTH_FAILURE_PATTERNS,
    userMessage:
      'The AI service rejected the API credentials. This is an operator configuration issue. Your request is preserved, but retrying will not help until the credentials are fixed.',
    retryable: false,
    operatorActionRequired: true,
  },
  {
    kind: 'provider-unavailable',
    label: 'session-error-provider-unavailable',
    patterns: PROVIDER_UNAVAILABLE_PATTERNS,
    userMessage:
      'The AI service is temporarily unavailable. Your request is preserved — ask me to continue and I will retry once it recovers.',
    retryable: true,
    operatorActionRequired: false,
  },
  {
    kind: 'model-overloaded',
    label: 'session-error-model-overloaded',
    patterns: MODEL_OVERLOADED_PATTERNS,
    userMessage:
      'The AI model is overloaded right now. Your request is preserved — ask me to continue in a moment and I will retry.',
    retryable: true,
    operatorActionRequired: false,
  },
];

/**
 * Classify a raw OpenCode session error into an actionable, user-facing result.
 *
 * @param error - The raw `error` value from an OpenCode `session.error` event.
 * @returns An `ActionableError` with a sanitized, human-readable message.
 */
export function classifyActionableError(error: unknown): ActionableError {
  const text = errorText(error);
  for (const entry of ERROR_CATALOG) {
    if (matchesAny(text, entry.patterns)) {
      return {
        kind: entry.kind,
        label: entry.label,
        userMessage: entry.userMessage,
        retryable: entry.retryable,
        operatorActionRequired: entry.operatorActionRequired,
      };
    }
  }
  return FALLBACK_GENERIC;
}

/**
 * Build the provider-side `agentMessage` (for recovery / internal context).
 * This should be short and describe what the provider observed.
 */
export function buildAgentMessage(classification: ActionableError): string {
  const base = 'The model reported an error on this turn and I stopped before finishing. Your request is preserved.';
  if (classification.operatorActionRequired) {
    return `${base} (${classification.label}: operator action required.)`;
  }
  if (!classification.retryable) {
    return `${base} (${classification.label}: not retryable.)`;
  }
  return base;
}
