/**
 * Pure builders shared by the Codex provider, kept out of codex.ts so the
 * event-shape logic is unit-testable under vitest. All upstream types are
 * imported `import type` (erased at runtime), so this module loads without the
 * in-fork runtime registry.
 */
import type { ProviderCapabilities, ProviderEvent, ProviderSideEffect } from './types.js';
import type { CodexLiveness } from './codex-turn-timing.js';

// Return the bare `ProviderEvent`, NOT `Extract<ProviderEvent, { type:
// 'notice' }>`. The two `types.ts` differ: the IN-FORK type (widened by patch
// 044) has a literal `'notice'` member, but the looser OVERLAY stub has only the
// `{ type: string; [key: string]: unknown }` catch-all — so `Extract<…,
// 'notice'>` resolves to the real member in-fork yet collapses to `never`
// against the stub (and an object literal can't be returned as `never`). A bare
// `ProviderEvent` is assignable under BOTH, so this compiles everywhere. Mirrors
// OpenCode, which yields the identical literal inline (opencode-container.ts:941).
export function buildInactivityNotice(inputId: string, liveness: CodexLiveness): ProviderEvent {
  return {
    type: 'notice',
    inputId,
    classification: 'inactivity',
    severity: 'info',
    fallbackUserMessage: "I'm still working on your request.",
    liveness,
  };
}

interface CodexItem { id?: string; type?: string; }

/**
 * The Codex app-server item types that represent COMPLETED TOOL ACTIVITY — the
 * only items that are real, recovery-seedable side-effects (matching OpenCode's
 * "captured completed tool activity" semantics, opencode-container.ts:1302). This
 * is an explicit ALLOWLIST, NOT a denylist: an `agentMessage`-only exclusion
 * would also capture non-tool protocol items (`reasoning`, `todoList`,
 * `tokenCount`/usage, `error`, …) as if they were completed tools, corrupting the
 * recovery seed with phantom tool work. An allowlist fails SAFE — an unrecognized
 * type is simply not seeded (no corruption), at worst missing one tool's recovery
 * hint.
 *
 * ⚠️ LOAD-BEARING (confirm during F2 vendoring): these strings must match the
 * EXACT item-type discriminants the vendored `codex-container.ts` (from 5e76b9d7)
 * parses off the app-server stream. Grep the vendored file's item handling and
 * reconcile this set (e.g. the camelCase discriminants the existing
 * `item.type === 'agentMessage'` check implies). Add any tool type the protocol
 * defines that is missing here; do NOT widen to a denylist.
 */
const CODEX_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'patchApply',
]);

/**
 * A completed TOOL item (allowlisted type, with an id) is a deduplicable
 * side-effect. Field shape mirrors OpenCode's `captureToolSideEffect`
 * (opencode-container.ts:1302): `{ id, inputId, kind: 'tool_completed', label,
 * evidence: { … }, occurredAt }`. The extra keys are admitted by
 * `ProviderSideEffect`'s `[key: string]: unknown` index signature (the optional
 * top-level `tool?` is left unset, exactly as OpenCode leaves it — the tool name
 * rides in `evidence.tool`). Non-tool items (agentMessage, reasoning, …) and
 * id-less items return null.
 */
export function buildToolSideEffect(item: CodexItem, inputId: string, occurredAtMs: number): ProviderSideEffect | null {
  if (!item || !item.id || !item.type || !CODEX_TOOL_ITEM_TYPES.has(item.type)) return null;
  return {
    id: `codex-item-${item.id}`,
    inputId,
    kind: 'tool_completed',
    label: item.type,
    evidence: { tool: item.type, item_id: item.id },
    occurredAt: new Date(occurredAtMs).toISOString(),
  };
}

/**
 * The per-turn dedup step `runOneTurn` actually uses: build a side-effect for a
 * completed item and return it ONLY if it's new (mutating `seen`). Sharing this
 * one function between the wiring and the unit test means the test exercises the
 * real dedup logic, not a copy of it. Returns null for non-side-effect items
 * (agentMessage / no-id) and for already-seen ids.
 */
export function dedupeCodexSideEffect(
  item: CodexItem, inputId: string, occurredAtMs: number, seen: Set<string>,
): ProviderSideEffect | null {
  const se = buildToolSideEffect(item, inputId, occurredAtMs);
  if (!se || seen.has(se.id as string)) return null;
  seen.add(se.id as string);
  return se;
}

// Mirrors OpenCode's capabilities getter (opencode-container.ts:667). We
// intentionally omit `defaultRelayDeadlineMs` (OpenCode sets it from a tuned
// env knob); the Codex relay uses the poll-loop's default deadline, so the two
// keys the poll-loop reads — `supportsSeparateRelayRuntime` + `relayToolPolicy`
// — are the contract here.
export function codexCapabilities(): ProviderCapabilities {
  return { supportsSeparateRelayRuntime: true, relayToolPolicy: 'status_only' };
}

/**
 * The sandbox a turn runs under. RELAY turns narrate status only and MUST be
 * read-only so a relay/recovery turn can never mutate the workspace even if the
 * model tries — this is the safety mechanism behind the separate-relay
 * capability. `query()` uses this for its thread params (Task B5), and the unit
 * test drives this same function (not a copy), so the read-only guarantee is
 * actually protected.
 */
export function codexThreadSandbox(relayMode: boolean): 'read-only' | 'danger-full-access' {
  return relayMode ? 'read-only' : 'danger-full-access';
}
