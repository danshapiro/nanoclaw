/**
 * Classification of channel-delivery errors by HTTP status.
 *
 * Deterministic client errors (4xx — unknown message, unknown emoji, bad
 * request) fail identically on every retry; retrying them just delays the
 * inevitable and spams the log. Transient errors (5xx, network) keep the
 * normal retry behavior.
 *
 * @chat-adapter/discord (4.26.0) wraps REST failures in a NetworkError whose
 * message embeds the status: "Discord API error: <status> <body>" (or
 * "Failed to post message: <status> <body>"). There is no structured status
 * property on the error, so we parse the message with patterns anchored on
 * the adapter's wording — Discord's JSON error codes in the body (e.g.
 * 10008 Unknown Message) are 5 digits and never match. A numeric `status`
 * or `statusCode` property is honored first in case another adapter
 * surfaces one.
 */

const STATUS_MESSAGE_PATTERNS = [
  /API error:?\s*(\d{3})\b/i, // @chat-adapter/discord discordFetch
  /Failed to post message:\s*(\d{3})\b/i, // @chat-adapter/discord postMessage
];

/** Extract an HTTP status from an adapter error, or null if none found. */
export function extractHttpStatusFromError(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown };
  for (const v of [e.status, e.statusCode]) {
    if (typeof v === 'number' && v >= 100 && v <= 599) return v;
  }
  if (typeof e.message === 'string') {
    for (const pattern of STATUS_MESSAGE_PATTERNS) {
      const m = e.message.match(pattern);
      if (m) {
        const status = Number(m[1]);
        if (status >= 100 && status <= 599) return status;
      }
    }
  }
  return null;
}

/** Provider retry_after is seconds; keep it as a minimum persisted delay. */
export function extractRateLimitDelayMs(err: unknown): number | null {
  if (extractHttpStatusFromError(err) !== 429 || !err || typeof err !== 'object') return null;
  const error = err as { retry_after?: unknown; message?: unknown };
  let value = error.retry_after;
  if (value === undefined && typeof error.message === 'string') {
    const body = error.message.trim().match(/(?:API error:?|Failed to post message:)\s*429\s+(\{.*\})$/is);
    if (body) {
      try {
        value = (JSON.parse(body[1]) as { retry_after?: unknown }).retry_after;
      } catch {
        return null;
      }
    }
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const delay = Math.ceil(value * 1000);
  return Number.isSafeInteger(delay) && delay <= 8.64e15 - Date.now() ? delay : null;
}

/**
 * True when the error is a deterministic client error (HTTP 4xx).
 *
 * 429 (rate limit) is transient. Safe single-reaction retries honor its
 * retry_after minimum; ambiguous or multipart sends retain reconciliation.
 */
export function isNonRetryableDeliveryError(err: unknown): boolean {
  const status = extractHttpStatusFromError(err);
  return status !== null && status >= 400 && status < 500 && status !== 429;
}

/** No platform request was made. A temporarily starting channel may be retried. */
export class DeliveryUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DeliveryUnavailableError';
  }
}
