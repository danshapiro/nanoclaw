/**
 * OpenCode SDK surface helpers (Task 3 Step 6).
 *
 * The native-question/permission/existence-check surface is DRIVEN BY THE
 * PROBE FIXTURE (`fixtures/opencode-sdk-question-surface.json`,
 * `scripts/opencode-sdk-surface-probe.ts`), not a hard-coded belief. The
 * provider (`opencode.ts`) constructs the ROOT client via
 * `createOpencodeClient`, whose event union has NO `question.*` events and NO
 * `client.question` namespace. So in production we detect/deny native questions
 * through the ROOT surface:
 *   - a `message.part.updated` whose `part` is a `ToolPart` with `tool ===
 *     'question'` (the real probed question tool id) carries the `callID`;
 *   - the matching `permission.updated` carries `Permission.id` (+ optional
 *     `callID`) and is denied via the root client's
 *     `postSessionIdPermissionsPermissionId(..., { body: { response: 'reject' } })`.
 *
 * This module is also the ONLY place (besides the probe script + this comment)
 * permitted by the Task 7 static guard to NAME the v2 `question.asked` /
 * `client.question` surface — recorded so a future client swap is caught rather
 * than silently mis-handled. The guard greps general provider/poll-loop logic
 * for those identifiers; keeping them confined here keeps that guard clean.
 */

/** Tool id the OpenCode runtime uses for native interactive questions. */
export const NATIVE_QUESTION_TOOL_ID = 'question';

/** SDK 1.15.10 `Config.permission` keys — the ONLY real permission keys. */
export const REAL_PERMISSION_KEYS = ['edit', 'bash', 'webfetch', 'doom_loop', 'external_directory'] as const;
export type RealPermissionKey = (typeof REAL_PERMISSION_KEYS)[number];

/**
 * Probed real OpenCode tool ids (root binary 1.15.12 / SDK 1.15.10). Mutation/
 * shell/file/web tools that relay mode must DENY, plus the read-only status
 * tools relay mode keeps available. The fixture is the source of record; this
 * list mirrors it so production code does not read JSON at runtime.
 */
export const MUTATION_SHELL_FILE_WEB_TOOL_IDS = [
  'bash',
  'edit',
  'write',
  'apply_patch',
  'webfetch',
  'websearch',
  'task',
  'pty_spawn',
  'pty_write',
  'pty_read',
  'pty_list',
  'pty_kill',
] as const;

export const READ_ONLY_STATUS_TOOL_IDS = ['read', 'glob', 'grep', 'todowrite', 'skill'] as const;

/**
 * Real SDK ids that relay mode disables in the `tools` map (mutation/shell/file/
 * web + the native question). Read-only status tools are left enabled; the only
 * write surface is the route-locked NanoClaw `send_message` MCP tool.
 */
export function relayDeniedNativeToolIds(): string[] {
  return [...MUTATION_SHELL_FILE_WEB_TOOL_IDS, NATIVE_QUESTION_TOOL_ID];
}

/** Minimal shape of the root-client `message.part.updated` event we read. */
export interface OpenCodePartUpdatedShape {
  type: 'message.part.updated';
  properties: {
    part?: {
      type?: string;
      tool?: string;
      callID?: string;
      sessionID?: string;
      messageID?: string;
      state?: { input?: Record<string, unknown>; title?: string } & Record<string, unknown>;
    };
    delta?: string;
  };
}

/** Minimal shape of the root-client `permission.updated` event we read. */
export interface OpenCodePermissionUpdatedShape {
  type: 'permission.updated';
  properties: {
    id?: string;
    callID?: string;
    sessionID?: string;
    messageID?: string;
    title?: string;
    type?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface NativeQuestionPart {
  callID: string;
  sessionID?: string;
  questionText: string;
}

/**
 * Detect a native OpenCode question from a `message.part.updated` event. The
 * probed surface is a `ToolPart` (`type === 'tool'`) whose `tool` equals the
 * native question tool id. Returns its `callID` and best-effort question text.
 */
export function detectNativeQuestionPart(event: { type?: string; properties?: unknown }): NativeQuestionPart | null {
  if (event.type !== 'message.part.updated') return null;
  const props = event.properties as OpenCodePartUpdatedShape['properties'] | undefined;
  const part = props?.part;
  if (!part || part.type !== 'tool' || part.tool !== NATIVE_QUESTION_TOOL_ID) return null;
  if (!part.callID) return null;
  return {
    callID: part.callID,
    sessionID: part.sessionID,
    questionText: extractQuestionText(part),
  };
}

/**
 * Detect a permission request that corresponds to a native question, by call
 * id. The root-client `permission.updated` carries `Permission.id` (the id used
 * to reply) and optionally `Permission.callID` (links it to the question tool
 * part). Returns the permission id to deny and the call id when present.
 */
export function detectNativeQuestionPermission(
  event: { type?: string; properties?: unknown },
  knownQuestionCallIds: ReadonlySet<string>,
): { permissionId: string; callID?: string; sessionID?: string; title?: string } | null {
  if (event.type !== 'permission.updated') return null;
  const props = event.properties as OpenCodePermissionUpdatedShape['properties'] | undefined;
  if (!props?.id) return null;
  // A permission is question-linked when its callID matches a seen question
  // tool part, or its type/title names the question tool.
  const callLinked = props.callID !== undefined && knownQuestionCallIds.has(props.callID);
  const typeLinked = props.type === NATIVE_QUESTION_TOOL_ID;
  if (!callLinked && !typeLinked) return null;
  return { permissionId: props.id, callID: props.callID, sessionID: props.sessionID, title: props.title };
}

/** Best-effort extraction of human-readable question text from a question tool part. */
function extractQuestionText(part: OpenCodePartUpdatedShape['properties']['part']): string {
  const state = part?.state;
  if (state && typeof state === 'object') {
    const input = (state as { input?: Record<string, unknown> }).input;
    if (input && typeof input === 'object') {
      const candidate = input.question ?? input.prompt ?? input.text ?? input.title;
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    const title = (state as { title?: unknown }).title;
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  return 'a question that requires your input';
}

/**
 * STATIC GUARD: a defensive check that the surface we implement still matches a
 * known client kind. The provider passes `'root'`; if a future change swaps in
 * the v2 client (which exposes `question.asked` events and a `client.question`
 * namespace) the native-question handling here would silently no-op, so we throw
 * to force an explicit surface update rather than ship a broken deny path.
 */
export function assertSupportedQuestionClient(kind: 'root' | string): void {
  if (kind !== 'root') {
    throw new Error(
      `Unsupported OpenCode client surface for native-question handling: "${kind}". ` +
        'The provider uses the root createOpencodeClient surface (message.part.updated + permission.updated). ' +
        'Update opencode-sdk-surface.ts and re-run the probe before changing the client.',
    );
  }
}
