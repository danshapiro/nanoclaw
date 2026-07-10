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

/**
 * True when the error is a deterministic client error (HTTP 4xx).
 *
 * 429 (rate limit) is excluded: it is transient -- Discord's retry_after is
 * typically sub-second, well within the delivery retry backoff (>=250ms), so
 * a retry succeeds where a "permanent" classification would silently drop
 * the message.
 */
export function isNonRetryableDeliveryError(err: unknown): boolean {
  const status = extractHttpStatusFromError(err);
  return status !== null && status >= 400 && status < 500 && status !== 429;
}
