# Yente Discord Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make files attached by users in registered Discord channels visible to Yente as durable local files inside `/workspace/group`, then roll the tested runtime out to the live Yente deployment on `shapiroserver2`.

**Architecture:** Add a focused Discord attachment materializer at the Discord channel ingress boundary. The channel will download Discord CDN attachments only after the chat is confirmed registered, save them inside the registered group folder that is already mounted at `/workspace/group`, and append explicit success or failure lines to the stored message text. This deliberately does not add a parallel message schema, raw CDN URL exposure, host-side OCR/parsing, new dependencies, or a container mount-model change.

**Tech Stack:** TypeScript ESM, Node 20 global `fetch`/`AbortSignal`, `discord.js`, Vitest, existing NanoClaw group-folder path validation, existing `shapiroserver2` host deployment scripts.

---

## Strategy Gate

The direct user goal is not "teach the agent to parse every file type"; it is "Yente cannot see/download/process Discord message attachments." The immediate bug is that the Discord channel discards attachment bytes and URLs and stores only placeholder text such as `[File: Ryan_Nadel.txt]`. Once the file exists in the group folder and the prompt includes its `/workspace/group/...` path, the existing container mount contract lets the agent inspect it with normal filesystem tools.

The upstream `upstream/main` architecture now has a session/inbox attachment model, but this deployed overlay still uses the older plain-message database, direct router formatting, and `/workspace/group` group mount. Discord support itself is overlay-local in this worktree. Porting the upstream session/inbox pipeline would require broad runtime, DB, delivery, agent-runner, and channel-adapter migration work that is out of proportion to this bug and would increase deploy risk. The clean steady-state shape for this overlay is therefore a narrow ingress materializer that uses the existing durable group boundary.

This preserves upstream updateability better than a broad fork-specific architecture change:

- It touches only Discord-specific code and tests plus deploy-management docs/pin files.
- It does not alter `src/router.ts`, `src/db.ts`, `src/container-runner.ts`, `src/config.ts`, channel loading, auth, or dependencies.
- It follows the upstream convention that attachments become local file paths for the agent, but adapts the path to this overlay's actual mount root: `/workspace/group`.
- It leaves a future upstream rebase free to replace this helper with the upstream session/inbox model when the overlay is intentionally migrated.

## File Structure

- Create `src/channels/discord-attachments.ts`
  - Owns Discord attachment sanitization, download limits, storage path construction, atomic writes, failure formatting, and success-line formatting.
  - Exports one production function: `materializeDiscordAttachments(...)`.
  - Does not import or depend on `discord.js`; accepts a small attachment input shape so it is easy to test.

- Create `src/channels/discord-attachments.test.ts`
  - Unit tests for successful downloads, path formatting, traversal-safe filenames, duplicate filenames, count/size/total limits, failed fetches, timeout reason formatting, partial success, and symlink rejection.

- Modify `src/channels/discord.ts`
  - Move attachment processing until after `registeredGroups()[chatJid]` succeeds.
  - Call `materializeDiscordAttachments(...)` before `opts.onMessage(...)`.
  - Keep `onChatMetadata(...)` behavior for unregistered Discord chats.
  - Keep mention translation, thread-to-parent mapping, reply context, slash commands, typing, and outbound send behavior unchanged.

- Modify `src/channels/discord.test.ts`
  - Replace placeholder-only attachment expectations with local-path attachment expectations.
  - Add ingress tests proving unregistered channels do not download, fetch failures are visible in the message, and `onMessage` is not called until materialization finishes.
  - Mock `resolveGroupFolderPath(...)` to a per-test temp directory so channel tests never write attachment artifacts into the repo's real `groups/` tree.

- Modify `/home/user/code/shapiroserver2/srv/nanoclaw/source.conf` on a `deploy/nanoclaw` worktree
  - Pin the exact tested NanoClaw runtime SHA after the runtime commit is folded onto `overlay/shapiroserver2`.

- Modify `/home/user/code/shapiroserver2/docs/nanoclaw/Deployment.md` on the same `deploy/nanoclaw` worktree after the live deploy succeeds
  - Update the current tested deploy ref and live release state from live metadata.
  - Add a short current-state note that Discord attachments for registered chats are materialized under `shared/groups/<group>/attachments/discord/...` and are covered by the existing shared-state backup scope.

- Modify `/home/user/code/shapiroserver2/changes.md` on the same `deploy/nanoclaw` worktree after the live deploy succeeds
  - Record the user-visible fix and rollout date.

- Likely modify `/home/user/code/shapiroserver2/tests/artifacts/nanoclaw-live/current/**`
  - Refresh proof artifacts with `bash tests/capture-nanoclaw-live-proof.sh` after deploy, as required by the Yente upgrade runbook.

## User-Visible Contract

For a registered Discord channel, a user message with attachments is stored with one extra line per attachment. Successful downloads use this shape:

```text
[File: Ryan_Nadel.txt type=text/plain size=12.4 KB path=/workspace/group/attachments/discord/<message-id>/<attachment-id>-Ryan_Nadel.txt]
```

Image, video, and audio MIME types should use `Image`, `Video`, and `Audio` labels respectively. Unknown or missing MIME types use `File` and `type=unknown`.

Failures are not hidden and are not replaced by raw CDN URLs. A failed attachment line uses this shape:

```text
[Attachment failed: Ryan_Nadel.txt reason=download returned HTTP 403]
```

The agent should always be able to tell whether a file was saved and where, or why it was not saved. Do not inline text-file content into the prompt. Do not summarize PDFs/images/audio/video on the host. The agent can decide how to inspect saved files from `/workspace/group`.

Unregistered Discord channels keep the existing metadata-only behavior and must not download or write attachment files.

## Contracts And Invariants

- Attachment downloads happen only after `opts.registeredGroups()[chatJid]` returns a group.
- Saved files live under the registered group folder resolved by `resolveGroupFolderPath(group.folder)`.
- Container paths always use `/workspace/group/attachments/discord/<safe-message-id>/<safe-attachment-id>-<safe-name>`.
- Host writes must fail closed if any managed attachment directory component already exists as a symlink or non-directory.
- The helper must use a temp file in the final directory, enforce streamed byte limits while writing, `rename` into place atomically, and remove partial temp files on error.
- File and directory names are sanitized to safe basename components. Do not preserve path separators, control characters, `..`, absolute paths, or leading hidden-dot names from user filenames.
- Attachment IDs and message IDs are used in path components to avoid same-filename collisions inside a message.
- Enforce hardcoded production limits in the helper, not environment-driven behavior:
  - `maxCount = 10` attachments per message.
  - `maxBytesPerFile = 25 * 1024 * 1024`.
  - `maxBytesTotal = 50 * 1024 * 1024`.
  - `downloadTimeoutMs = 30_000` per file.
  - `messageDownloadBudgetMs = 60_000` total for one message.
- Check `att.size` before download when present against both the per-file limit and the remaining message-total byte budget. If the remaining total budget is exhausted, or metadata proves the attachment cannot fit, fail that attachment visibly without calling `fetch`.
- Treat all display metadata as untrusted prompt text. Display filenames, MIME types, and failure reasons must be normalized to one safe line and must not contain control characters or bracket characters that can break the `[File: ...]` / `[Attachment failed: ...]` contract.
- Accept only `https:` attachment URLs. Discord CDN attachment URLs should satisfy this. Anything else produces an explicit failure line.
- Do not expose Discord CDN URLs in stored messages or agent prompts.
- Do not add package dependencies.
- Do not change the auth model, mount model, router format, DB schema, channel registration model, or built-in-vs-skill boundary.

## Implementation Notes

Use this public helper shape:

```ts
export interface DiscordAttachmentInput {
  id?: string | null;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  url?: string | null;
}

export interface DiscordAttachmentLimits {
  maxCount: number;
  maxBytesPerFile: number;
  maxBytesTotal: number;
  downloadTimeoutMs: number;
  messageDownloadBudgetMs: number;
  maxFilenameChars: number;
}

export interface MaterializeDiscordAttachmentsArgs {
  messageId: string;
  group: RegisteredGroup;
  attachments: DiscordAttachmentInput[];
  fetchImpl?: typeof fetch;
  groupDir?: string;
  limits?: Partial<DiscordAttachmentLimits>;
}

export async function materializeDiscordAttachments(
  args: MaterializeDiscordAttachmentsArgs,
): Promise<string[]>;
```

`fetchImpl`, `groupDir`, and `limits` are test seams. Production `discord.ts` must pass only `messageId`, `group`, and the mapped Discord attachments.

Use implementation logic equivalent to this:

```ts
const DEFAULT_LIMITS: DiscordAttachmentLimits = {
  maxCount: 10,
  maxBytesPerFile: 25 * 1024 * 1024,
  maxBytesTotal: 50 * 1024 * 1024,
  downloadTimeoutMs: 30_000,
  messageDownloadBudgetMs: 60_000,
  maxFilenameChars: 120,
};

export async function materializeDiscordAttachments(
  args: MaterializeDiscordAttachmentsArgs,
): Promise<string[]> {
  const limits = { ...DEFAULT_LIMITS, ...args.limits };
  const fetchAttachment = args.fetchImpl ?? fetch;
  const groupDir = args.groupDir ?? resolveGroupFolderPath(args.group.folder);
  const messageSegment = sanitizePathSegment(args.messageId, 'message');
  const startedAt = Date.now();
  const lines: string[] = [];
  let totalBytes = 0;

  for (const [index, attachment] of args.attachments.entries()) {
    const displayName = sanitizeDisplayName(attachment.name, `attachment-${index + 1}`);

    if (index >= limits.maxCount) {
      lines.push(formatAttachmentFailure(displayName, `message has more than ${limits.maxCount} attachments`));
      continue;
    }

    let timeoutMs = limits.downloadTimeoutMs;
    try {
      const elapsedMs = Date.now() - startedAt;
      const remainingBudgetMs = limits.messageDownloadBudgetMs - elapsedMs;
      if (remainingBudgetMs <= 0) {
        throw new Error(`message attachment download budget exceeded after ${formatDuration(limits.messageDownloadBudgetMs)}`);
      }
      const remainingTotalBytes = limits.maxBytesTotal - totalBytes;
      if (remainingTotalBytes <= 0) {
        throw new Error(`message attachment byte budget exceeded after ${formatBytes(limits.maxBytesTotal)}`);
      }
      const maxBytes = Math.min(limits.maxBytesPerFile, remainingTotalBytes);
      if (attachment.size !== null && attachment.size !== undefined && attachment.size > maxBytes) {
        throw new Error(`attachment size ${formatBytes(attachment.size)} exceeds remaining limit ${formatBytes(maxBytes)}`);
      }
      timeoutMs = Math.min(limits.downloadTimeoutMs, remainingBudgetMs);

      const result = await downloadOneAttachment({
        attachment,
        index,
        displayName,
        groupDir,
        messageSegment,
        fetchAttachment,
        timeoutMs,
        maxBytes,
        maxFilenameChars: limits.maxFilenameChars,
      });

      totalBytes += result.bytes;
      lines.push(formatAttachmentSuccess(result));
    } catch (error) {
      const reason = formatDownloadError(error, timeoutMs ?? limits.downloadTimeoutMs);
      logger.warn({ err: error, messageId: args.messageId, attachment: displayName }, 'Discord attachment materialization failed');
      lines.push(formatAttachmentFailure(displayName, reason));
    }
  }

  return lines;
}
```

The final code should not copy this blindly if tests reveal a cleaner local expression, but it must preserve these semantics. In particular, do not use `response.arrayBuffer()`; stream the response so the byte limit is enforced before the entire file is resident in memory.

## Cutover And Regression Risk

- Main behavioral regression risk: delaying `onMessage` while downloads happen. Keep bounded timeouts and a total message budget, and verify `onMessage` waits only until materialization finishes or fails.
- Security regression risk: the group folder is writable by agents, so pre-existing symlinks under `attachments/` must fail closed instead of letting the host write through them.
- Operational risk: attachments add durable group state and backup volume. Keep strict limits, store only registered-channel attachments, and document the new storage location.
- Deployment risk: `shapiroserver2` currently has known pin/doc drift around the latest overlay state. Treat `/srv/nanoclaw/current/deploy-metadata.json` as live truth, then reconcile `source.conf`, `Deployment.md`, and proof artifacts after the new cutover.
- Testing gap: there is no safe automated way to create a real Discord non-bot user message from the bot token. Cover Discord ingress with unit/integration tests, then use live deployed helper/mount smoke plus the standard Yente host smoke. If a human-operated Discord client is already available during execution, run the real attachment acceptance test too, but do not block rollout on unsafe user-token automation.

---

### Task 1: Attachment Materializer Tests And Helper

**Files:**
- Create: `src/channels/discord-attachments.ts`
- Create: `src/channels/discord-attachments.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create `src/channels/discord-attachments.test.ts` with tests that use a temp `groupDir`, a fake `fetchImpl`, and no real network. Cover these cases:

```ts
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { materializeDiscordAttachments } from './discord-attachments.js';
import { RegisteredGroup } from '../types.js';

let tmpRoot: string;
let groupDir: string;

const group: RegisteredGroup = {
  name: 'Test Server #general',
  folder: 'test-server',
  trigger: '@Andy',
  added_at: '2026-04-25T00:00:00.000Z',
};

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nanoclaw-discord-attachments-'));
  groupDir = path.join(tmpRoot, 'group');
  await fsp.mkdir(groupDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});
```

Required assertions:

- Successful text file saves bytes under `attachments/discord/msg_001/att1-report.txt` and returns a line containing `path=/workspace/group/attachments/discord/msg_001/att1-report.txt`.
- Image MIME returns an `Image` label; video/audio MIME returns `Video`/`Audio`; unknown MIME returns `File`.
- Two attachments with the same original filename save to distinct paths because their attachment IDs are part of the filename.
- A filename like `../../secret.txt` or `..\\secret.txt` never creates or returns a path containing `..`, `/secret.txt` outside the message dir, or a host escape.
- If an attachment has metadata `size` greater than `maxBytesPerFile`, `fetchImpl` is not called and the returned line is `[Attachment failed: ...]`.
- If streamed bytes exceed the limit despite small metadata, the temp file is removed and the returned line is `[Attachment failed: ...]`.
- If cumulative saved bytes would exceed `maxBytesTotal`, the over-budget attachment fails visibly and is not fetched or written.
- If the fetch aborts on `AbortSignal.timeout(...)`, the returned failure reason is normalized to a user-readable timeout such as `download timed out after 30s`.
- If the first attachment succeeds and the second fetch returns HTTP 403, the helper returns one success line and one visible failure line.
- If `attachments` already exists as a symlink to another temp directory, the helper fails the attachment and writes nothing through the symlink.
- If there are more than 10 attachments, only the first 10 are eligible for fetch and the excess entries get explicit failure lines.
- If `url` is missing or non-HTTPS, the helper returns an explicit failure line and does not call `fetchImpl`.
- A filename containing newlines or bracket characters is still rendered as exactly one safe bracketed line and cannot inject a fake attachment line or fake `path=`.

Use `new Response('contents', { status: 200, headers: { 'content-length': '8' } })` for successful fake fetches. Use an HTTPS-looking URL such as `https://cdn.discord.test/report.txt`; the fake fetch prevents network access.

- [ ] **Step 2: Run helper tests to verify they fail**

Run:

```bash
npx vitest run src/channels/discord-attachments.test.ts
```

Expected: FAIL because `./discord-attachments.js` does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/channels/discord-attachments.ts` with the public interfaces in the Implementation Notes. Use these concrete implementation requirements:

- Imports:

```ts
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';

import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
```

- Directory creation:
  - Build `attachments/discord/<messageSegment>` relative to the resolved group dir.
  - Iterate each path component with `lstat`.
  - If missing, create it with `fsp.mkdir(componentPath, { mode: 0o700 })`, then `lstat` it. If a concurrent writer creates the same directory first and `mkdir` returns `EEXIST`, retry `lstat` instead of treating that as a download failure.
  - If existing and `isSymbolicLink()` or not `isDirectory()`, throw `Unsafe attachment storage path: <relative path>`.
  - After the directory exists, compare `await fsp.realpath(dir)` with `await fsp.realpath(groupDir)` and fail if it escapes.

- File writing:
  - Build final filename as `<safeAttachmentId>-<safeFilename>`.
  - Build temp filename as `.${finalFilename}.${process.pid}.${Date.now()}.tmp`.
  - Use `fsp.open(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)`.
  - Stream `response.body` through `Readable.fromWeb(response.body)` and increment bytes before each write.
  - If bytes exceed `maxBytes`, throw a user-friendly size error and remove the temp file.
  - Close the file handle in `finally`.
  - `await fsp.rename(tempPath, finalPath)` only after the stream completes.

- URL and response validation:
  - Parse `attachment.url` with `new URL(...)`.
  - Reject any protocol other than `https:`.
  - Call `fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })`.
  - Reject non-2xx responses with `download returned HTTP <status>`.
  - Reject a missing body with `download response did not include a body`.
  - If `content-length` is present and greater than `maxBytes`, reject before writing.

- Formatting:
  - `formatAttachmentSuccess(...)` must produce exactly one single-line bracketed message with original-display filename, MIME type or `unknown`, human-readable saved byte size, and the container path.
  - `formatAttachmentFailure(...)` must produce exactly one single-line bracketed message with sanitized display filename and a clear reason.
  - `formatDownloadError(...)` must normalize timeout/abort failures to `download timed out after 30s` when the per-file timeout was 30 seconds.

- Sanitization:
  - Normalize backslashes to `/`, take `path.basename(...)`, trim, replace control characters and `[`/`]` with safe spacing or punctuation, cap display names, and fall back to `attachment-<n>` if empty.
  - Normalize MIME values to a conservative single-line token such as `text/plain`; use `unknown` if the value is missing or contains whitespace, control characters, brackets, or other prompt-structural punctuation.
  - Path filenames should be stricter than display names: replace every character outside `[A-Za-z0-9._-]` with `_`, collapse repeated `_`, reject `.`/`..`, prefix names that start with `.`, and cap to `maxFilenameChars` while preserving a short extension when possible.
  - Path segments for message/attachment IDs should allow only `[A-Za-z0-9_-]`; replace other characters with `_`, cap length, and fall back to `message`/`attachment-<n>`.

- [ ] **Step 4: Run helper tests to verify they pass**

Run:

```bash
npx vitest run src/channels/discord-attachments.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify helper quality**

Tighten helper names and assertions without weakening tests. Then run:

```bash
npm run typecheck
npx vitest run src/channels/discord-attachments.test.ts
```

Expected: both PASS.

- [ ] **Step 6: Commit helper**

Run:

```bash
git add src/channels/discord-attachments.ts src/channels/discord-attachments.test.ts
git commit -m "fix: materialize discord attachments"
```

### Task 2: Discord Ingress Wiring

**Files:**
- Modify: `src/channels/discord.ts`
- Modify: `src/channels/discord.test.ts`

- [ ] **Step 1: Write failing Discord channel tests**

In `src/channels/discord.test.ts`, update `createMessage(...)` attachment fixtures so test attachments include `id`, `url`, `name`, `contentType`, and `size`.

Add temp group-folder isolation before importing `DiscordChannel`:

```ts
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

const mockGroupsRoot = vi.hoisted(() => ({ value: '' }));

vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => {
    if (!mockGroupsRoot.value) {
      throw new Error('mock group root was not initialized');
    }
    return `${mockGroupsRoot.value}/${folder}`;
  }),
}));
```

In the existing `beforeEach`, create a temp root and assign `mockGroupsRoot.value`. In the existing `afterEach`, remove that temp root and reset the value:

```ts
let tmpRoot: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'nanoclaw-discord-channel-'));
  mockGroupsRoot.value = tmpRoot;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
  mockGroupsRoot.value = '';
});
```

If this requires changing the existing `beforeEach`/`afterEach` callbacks to `async`, do that. Use `vi.spyOn(globalThis, 'fetch')` for fetch stubs so `vi.restoreAllMocks()` cleans them up. Do not use the repo's real `groups/` directory in these tests; `git status --short -- groups` must remain empty after the test run.

Add or update tests under `describe('attachments', ...)`:

- `stores downloaded attachment paths for registered channels`
  - Stub global `fetch` to return `new Response('hello file', { status: 200, headers: { 'content-length': '10' } })`.
  - Trigger a registered message with `report.txt`.
  - Assert `opts.onMessage` content is:

```text
Check this out
[File: report.txt type=text/plain size=10 B path=/workspace/group/attachments/discord/msg_001/att1-report.txt]
```

- `does not download attachments for unregistered channels`
  - Stub global `fetch`.
  - Trigger an unregistered channel with an attachment.
  - Assert `fetch` and `opts.onMessage` were not called, while `opts.onChatMetadata` still was called.

- `keeps partial success and visible failure lines`
  - First fake fetch returns `ok`.
  - Second fake fetch returns `new Response('nope', { status: 403 })`.
  - Assert message content contains one `path=/workspace/group/...` line and one `[Attachment failed: ... reason=download returned HTTP 403]` line.

- `waits for materialization before delivering the message`
  - Use a deferred fake fetch promise.
  - Start `const trigger = triggerMessage(msg)` without awaiting it.
  - Assert `opts.onMessage` has not been called.
  - Resolve fake fetch with `new Response(...)`, then `await trigger`.
  - Assert `opts.onMessage` was called once with a saved path line.

Existing placeholder tests should be changed to assert the new path-bearing contract. Do not delete coverage for image/video/audio/file labels; update it to check labels plus `path=`.

- [ ] **Step 2: Run Discord channel tests to verify they fail**

Run:

```bash
npx vitest run src/channels/discord.test.ts
```

Expected: FAIL because `discord.ts` still stores placeholder-only attachment labels and downloads before neither registered check nor helper wiring.

- [ ] **Step 3: Wire helper into `discord.ts`**

Make these changes:

- Import the helper:

```ts
import { materializeDiscordAttachments } from './discord-attachments.js';
```

- Remove the old block that maps attachments directly to `[Image: name]`, `[Video: name]`, `[Audio: name]`, or `[File: name]`.
- Keep bot ignore, thread parent mapping, chat identity, mention translation, and chat metadata behavior as-is.
- Call `this.opts.onChatMetadata(...)` before the registered-group check, preserving group discovery.
- Move the registered-group check before attachment materialization.
- After the group check succeeds, fetch reply context as before.
- Then materialize attachments:

```ts
const attachmentLines =
  message.attachments.size > 0
    ? await materializeDiscordAttachments({
        messageId: msgId,
        group,
        attachments: [...message.attachments.values()].map((att) => ({
          id: att.id,
          name: att.name,
          contentType: att.contentType,
          size: att.size,
          url: att.url,
        })),
      })
    : [];

if (attachmentLines.length > 0) {
  content = content
    ? `${content}\n${attachmentLines.join('\n')}`
    : attachmentLines.join('\n');
}
```

Do not catch and drop helper failures at the channel level unless the helper API itself throws an unexpected fatal error. If an unexpected fatal error can escape, convert it to one visible failure line per attachment and log it; do not let the event handler silently lose the message.

- [ ] **Step 4: Run Discord channel tests to verify they pass**

Run:

```bash
npx vitest run src/channels/discord.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify Discord path**

Run:

```bash
npx vitest run src/channels/discord-attachments.test.ts src/channels/discord.test.ts
npm run typecheck
```

Expected: both PASS. If formatting changed, run `npm run format -- src/channels/discord.ts src/channels/discord-attachments.ts src/channels/discord.test.ts src/channels/discord-attachments.test.ts` or just `npm run format`.

- [ ] **Step 6: Commit ingress wiring**

Run:

```bash
git add src/channels/discord.ts src/channels/discord.test.ts src/channels/discord-attachments.ts src/channels/discord-attachments.test.ts
git commit -m "fix: expose discord attachment paths to agents"
```

### Task 3: Full NanoClaw Verification

**Files:**
- May modify formatting only in files touched by Tasks 1-2.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npx vitest run src/channels/discord-attachments.test.ts src/channels/discord.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run project checks**

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: all PASS. If `npm test` reveals unrelated failures, investigate enough to distinguish real regression from pre-existing issue; do not weaken valid tests.

- [ ] **Step 3: Verify no forbidden architecture changes**

Run:

```bash
BASE_RUNTIME_SHA="$(git merge-base overlay/shapiroserver2 HEAD)"
git diff --stat "$BASE_RUNTIME_SHA"..HEAD
git diff --name-only "$BASE_RUNTIME_SHA"..HEAD
git diff "$BASE_RUNTIME_SHA"..HEAD -- package.json package-lock.json src/router.ts src/db.ts src/container-runner.ts src/config.ts
git status --short -- groups
```

Expected:

- Only `docs/plans/2026-04-25-yente-discord-attachments.md`, `src/channels/discord.ts`, `src/channels/discord.test.ts`, `src/channels/discord-attachments.ts`, and `src/channels/discord-attachments.test.ts` changed.
- No changes to dependencies, DB schema, router, container runner, config, auth, or channel loader.
- No untracked or modified files under `groups/`; attachment tests must use temp directories only.

- [ ] **Step 4: Commit any formatting-only cleanup**

If format/lint changed tracked files after the previous commits, run:

```bash
git add src/channels/discord.ts src/channels/discord.test.ts src/channels/discord-attachments.ts src/channels/discord-attachments.test.ts
git commit -m "chore: format discord attachment handling"
```

If there are no changes, skip this commit.

### Task 4: Fold Runtime Onto The Long-Lived Overlay

**Files:**
- No file edits expected.

- [ ] **Step 1: Reconfirm upstream comparison and local branch state**

Run:

```bash
git fetch upstream origin
git status --short --branch
git log --oneline --decorate -5

BASE_RUNTIME_SHA="$(git merge-base overlay/shapiroserver2 HEAD)"
git diff --stat "$BASE_RUNTIME_SHA"..HEAD
git diff --name-only "$BASE_RUNTIME_SHA"..HEAD
git diff --name-only "$BASE_RUNTIME_SHA"..HEAD -- package.json package-lock.json src/router.ts src/db.ts src/container-runner.ts src/config.ts src/channels/index.ts

# Upstream-policy review only. This overlay already has intentional differences
# from upstream/main in deployment-sensitive files, so do not use this as the
# isolation check for the new bug fix.
git diff --stat upstream/main...HEAD -- src/channels/discord.ts src/channels/discord-attachments.ts src/router.ts src/db.ts src/container-runner.ts src/config.ts package.json package-lock.json
```

Expected:

- Working tree clean.
- The `$BASE_RUNTIME_SHA..HEAD` diff contains only the plan file and Discord attachment implementation/test files.
- The sensitive-file diff against `$BASE_RUNTIME_SHA` prints nothing except `src/channels/discord.ts` if Task 2 has already landed.
- The `upstream/main...HEAD` diff may show existing overlay divergence in `package.json`, `src/config.ts`, `src/db.ts`, and `src/container-runner.ts`; use it to confirm this task did not add new core-runtime drift beyond the Discord-specific files already reviewed in the overlay diff.

- [ ] **Step 2: Fast-forward `overlay/shapiroserver2` to the tested runtime**

Use the existing `overlay/shapiroserver2` worktree if another agent has it checked out; otherwise switch this implementation worktree onto the overlay branch and fast-forward it:

```bash
OVERLAY_WT="$(
  git worktree list --porcelain |
    awk '
      $1 == "worktree" { path=$2 }
      $1 == "branch" && $2 == "refs/heads/overlay/shapiroserver2" { print path }
    ' |
    head -n1
)"

if [ -n "$OVERLAY_WT" ] && [ "$OVERLAY_WT" != "$(pwd)" ]; then
  cd "$OVERLAY_WT"
  git status --short --branch
else
  git switch overlay/shapiroserver2
fi

git merge --ff-only trycycle/yente-discord-attachments
```

Expected: `overlay/shapiroserver2` now points at the exact tested runtime commit.

If `overlay/shapiroserver2` moved independently, stop only long enough to inspect the conflicting commits and re-run the focused tests after replaying this change. Do not overwrite another agent's overlay work.

- [ ] **Step 3: Re-run focused runtime checks on `overlay/shapiroserver2`**

Run:

```bash
npx vitest run src/channels/discord-attachments.test.ts src/channels/discord.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Record the runtime SHA**

Run:

```bash
RUNTIME_SHA="$(git rev-parse HEAD)"
printf '%s\n' "$RUNTIME_SHA"
```

Expected: This exact SHA is the value to pin in `shapiroserver2/srv/nanoclaw/source.conf`.

### Task 5: Update The Deploy-Management Worktree

**Files:**
- Modify: `/home/user/code/shapiroserver2/srv/nanoclaw/source.conf`
- Later in Task 8, modify: `/home/user/code/shapiroserver2/docs/nanoclaw/Deployment.md`
- Later in Task 8, modify: `/home/user/code/shapiroserver2/changes.md`
- Later in Task 8, likely modify: `/home/user/code/shapiroserver2/tests/artifacts/nanoclaw-live/current/**`

- [ ] **Step 1: Create or reuse a clean `shapiroserver2` deploy worktree**

Run:

```bash
cd /home/user/code/shapiroserver2
mkdir -p .worktrees
DEPLOY_WT="$(
  git worktree list --porcelain |
    awk '
      $1 == "worktree" { path=$2 }
      $1 == "branch" && $2 == "refs/heads/deploy/nanoclaw" { print path }
    ' |
    head -n1
)"
if [ -z "$DEPLOY_WT" ]; then
  DEPLOY_WT="/home/user/code/shapiroserver2/.worktrees/yente-discord-attachments-deploy"
  git worktree add "$DEPLOY_WT" deploy/nanoclaw
fi
cd "$DEPLOY_WT"
git status --short --branch
```

Expected: worktree is on `deploy/nanoclaw` and clean. In the current workstation state, this should reuse `/home/user/code/shapiroserver2/.worktrees/trycycle-reconcile-deploy-canonical`; do not try to add a second worktree for `deploy/nanoclaw` while that branch is already checked out. Use this selected path as `<DEPLOY_WT>` in later deploy-repo steps. If this worktree is dirty with another agent's changes, inspect before proceeding and do not overwrite or revert them.

- [ ] **Step 2: Capture live truth before editing docs**

Run:

```bash
ssh shapiroserver2-lan '
  set -euo pipefail
  sudo systemctl is-active nanoclaw
  readlink -f /srv/nanoclaw/current
  readlink -f /srv/nanoclaw/previous
  sudo cat /srv/nanoclaw/current/deploy-metadata.json
'
```

Expected: command succeeds. Use this output to reconcile any existing drift in `Deployment.md`; do not assume the checked-in source pin is live truth.

- [ ] **Step 3: Update `source.conf`**

Edit `srv/nanoclaw/source.conf` so it pins the Task 4 `RUNTIME_SHA`:

```text
repo=/home/user/code/nanoclaw
ref=<RUNTIME_SHA>
```

- [ ] **Step 4: Run deploy repo validation before deploy**

Run:

```bash
bash tests/validate.sh
```

Expected: PASS.

- [ ] **Step 5: Commit deploy-management prep**

Run:

```bash
git add srv/nanoclaw/source.conf
git commit -m "deploy: pin nanoclaw discord attachment fix"
```

### Task 6: Deploy To Yente

**Files:**
- No direct edits expected during deploy.

- [ ] **Step 1: Deploy through the canonical host path**

From `<DEPLOY_WT>`, run:

```bash
bash srv/nanoclaw/deploy-host.sh
```

Expected:

- Release builds under `/srv/nanoclaw/releases/<RUNTIME_SHA>/`.
- `/srv/nanoclaw/current` switches only after checks pass.
- `/srv/nanoclaw/previous` points at the prior release.

- [ ] **Step 2: Verify release pointers and service state**

Run:

```bash
ssh shapiroserver2-lan '
  set -euo pipefail
  sudo systemctl is-active nanoclaw
  readlink -f /srv/nanoclaw/current
  readlink -f /srv/nanoclaw/previous
  sudo cat /srv/nanoclaw/current/deploy-metadata.json
'
```

Expected:

- Service is `active`.
- Current release path ends with `<RUNTIME_SHA>`.
- `deploy-metadata.json.releaseSha` is `<RUNTIME_SHA>`.

- [ ] **Step 3: Re-sync service-owned skills**

Run:

```bash
bash srv/nanoclaw/deploy-skills.sh
```

Expected: PASS.

- [ ] **Step 4: Run standard post-deploy checks**

Run:

```bash
ssh shapiroserver2-lan \
  'sudo /srv/nanoclaw/run-agent-smoke.sh prompt --expect Yente "Reply with only your configured assistant name."'

bash tests/test-nanoclaw-cross-repo-steady-state.sh live
bash tests/test-agent-smoke-boundary.sh
bash tests/test-skill-deploy.sh
bash tests/test-webfetch-e2e.sh
bash tests/test-gws-e2e.sh
```

Expected: all PASS.

### Task 7: Attachment-Specific Live Acceptance

**Files:**
- No runtime file edits expected.
- May refresh `/home/user/code/shapiroserver2/tests/artifacts/nanoclaw-live/current/**` in the next task.

- [ ] **Step 1: Identify the live group folder for `yente-chava`**

Run:

```bash
ssh shapiroserver2-lan "
  sudo sqlite3 /srv/nanoclaw/shared/store/messages.db \\
    \"select rg.jid, c.name, rg.folder from registered_groups rg left join chats c on c.jid = rg.jid where c.name like '%chava%' or rg.folder like '%chava%';\"
"
```

Expected: one registered Discord row for the `yente-chava` group. Record its `folder`; use `<GROUP_FOLDER>` below.

- [ ] **Step 2: Run deployed helper smoke against live shared group storage**

This validates the deployed helper code and live filesystem permissions without using a Discord user token.

Run:

```bash
ssh shapiroserver2-lan "
  set -euo pipefail
  GROUP_FOLDER='<GROUP_FOLDER>'
  sudo -u nanoclaw -H env GROUP_FOLDER=\"\$GROUP_FOLDER\" /usr/bin/node --input-type=module <<'NODE'
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

const releaseDir = await fs.realpath('/srv/nanoclaw/current');
const { materializeDiscordAttachments } = await import(
  pathToFileURL(path.join(releaseDir, 'dist/channels/discord-attachments.js')).href
);

const groupFolder = process.env.GROUP_FOLDER;
const groupDir = path.join('/srv/nanoclaw/shared/groups', groupFolder);
const lines = await materializeDiscordAttachments({
  messageId: 'live-smoke-discord-attachments',
  group: {
    name: groupFolder,
    folder: groupFolder,
    trigger: '@Yente',
    added_at: new Date().toISOString(),
  },
  groupDir,
  attachments: [
    {
      id: 'att1',
      name: 'discord-attachment-smoke.txt',
      contentType: 'text/plain',
      size: 19,
      url: 'https://cdn.discord.test/discord-attachment-smoke.txt',
    },
  ],
  fetchImpl: async () => new Response('YENTE_ATTACHMENT_OK', {
    status: 200,
    headers: { 'content-length': '19' },
  }),
});

console.log(lines.join('\\n'));
if (!lines[0]?.includes('path=/workspace/group/attachments/discord/live-smoke-discord-attachments/att1-discord-attachment-smoke.txt')) {
  throw new Error('helper did not return expected container path');
}
NODE
"
```

Expected: prints one success line with the `/workspace/group/attachments/discord/...` path.

- [ ] **Step 3: Verify the deployed agent can read that saved file through the normal container path**

Run:

```bash
ssh shapiroserver2-lan \
  "sudo /srv/nanoclaw/run-agent-smoke.sh prompt --group-folder '<GROUP_FOLDER>' --contains YENTE_ATTACHMENT_OK 'Read /workspace/group/attachments/discord/live-smoke-discord-attachments/att1-discord-attachment-smoke.txt and reply with its exact content.'"
```

Expected: PASS and the JSON report result contains `YENTE_ATTACHMENT_OK`.

- [ ] **Step 4: Remove the helper-smoke artifact**

Before any optional real Discord acceptance, remove the helper-smoke artifact so the live group does not retain test-only files:

```bash
ssh shapiroserver2-lan \
  "sudo -u nanoclaw rm -rf '/srv/nanoclaw/shared/groups/<GROUP_FOLDER>/attachments/discord/live-smoke-discord-attachments'"
```

Expected: command succeeds. The preceding agent-smoke already proved the file was readable through `/workspace/group`.

- [ ] **Step 5: Run real Discord acceptance if a human-operated Discord client is available**

Do not use a Discord user token or bot-authored message to fake this; bot-authored messages are intentionally ignored by `discord.ts`.

If a normal user Discord client is already available during execution, send a message in `yente-chava` with a small text attachment containing `YENTE_DISCORD_REAL_OK` and ask Yente to read the attached file. Expected result: Yente replies with the file content or a correct summary and references the `/workspace/group/attachments/discord/...` path.

If no safe human-operated client is available, record this as a residual manual gap in the final implementation report; do not block rollout after Steps 2-3 and unit ingress tests pass.

### Task 8: Refresh Proof Artifacts And Finish Deploy Repo

**Files:**
- Modify: `/home/user/code/shapiroserver2/tests/artifacts/nanoclaw-live/current/**`
- Modify: `/home/user/code/shapiroserver2/docs/nanoclaw/Deployment.md`
- Modify: `/home/user/code/shapiroserver2/changes.md`

- [ ] **Step 1: Refresh live proof artifacts**

From `<DEPLOY_WT>`, run:

```bash
bash tests/capture-nanoclaw-live-proof.sh
```

Expected: PASS and proof artifacts under `tests/artifacts/nanoclaw-live/current/` reflect the new release SHA.

- [ ] **Step 2: Finalize deployment docs and change log from live metadata**

Run:

```bash
ssh shapiroserver2-lan '
  set -euo pipefail
  readlink -f /srv/nanoclaw/current
  readlink -f /srv/nanoclaw/previous
  sudo cat /srv/nanoclaw/current/deploy-metadata.json
'
```

In `docs/nanoclaw/Deployment.md`:

- Update "Current tested NanoClaw deploy ref", "Live release symlink after redeploy", "Live rollback symlink", and the verification date/release text from the live metadata.
- Add a current-state bullet near the Discord control surface note:

```markdown
- Discord attachment contract: for registered Discord chats, inbound attachments are downloaded at ingress into `/srv/nanoclaw/shared/groups/<group>/attachments/discord/<message-id>/` and surfaced to agents as `/workspace/group/attachments/discord/<message-id>/<attachment-id>-<safe-name>` paths. Failed downloads are stored as explicit message text failures; raw Discord CDN URLs are not exposed to agents.
```

In `changes.md`, add a dated entry for April 25, 2026 stating that Yente now materializes registered Discord attachments into group storage, appends explicit file paths/failures to message text, and was redeployed after validation.

Do not update `docs/nanoclaw/Upgrade.md` unless the implementation actually changes the operator procedure. This plan does not intend to change it.

- [ ] **Step 3: Run final deploy repo validation**

Run:

```bash
bash tests/validate.sh
git status --short
```

Expected: validation PASS; only intentional docs/source/proof artifact changes are present.

- [ ] **Step 4: Commit deploy proof updates**

Run:

```bash
git add docs/nanoclaw/Deployment.md changes.md tests/artifacts/nanoclaw-live/current
git commit -m "docs: refresh nanoclaw live proof"
```

If Step 1 did not change proof artifacts and Step 2 did not change docs, skip this commit.

### Task 9: Final Repository State And Rollback Readiness

**Files:**
- No file edits expected.

- [ ] **Step 1: Verify NanoClaw long-lived branch and tested SHA**

Run:

```bash
cd /home/user/code/nanoclaw/.worktrees/yente-discord-attachments
git status --short --branch
git rev-parse --short HEAD
git branch --points-at HEAD
```

Expected: clean tree; `overlay/shapiroserver2` points at the deployed runtime SHA.

- [ ] **Step 2: Verify `shapiroserver2` deploy branch**

Run:

```bash
cd "<DEPLOY_WT>"
git status --short --branch
git log --oneline -3
cat srv/nanoclaw/source.conf
```

Expected: clean tree; `deploy/nanoclaw` contains the new source pin and docs/proof commits.

- [ ] **Step 3: Verify live rollback pointer**

Run:

```bash
ssh shapiroserver2-lan '
  set -euo pipefail
  sudo systemctl is-active nanoclaw
  readlink -f /srv/nanoclaw/current
  readlink -f /srv/nanoclaw/previous
'
```

Expected: current is the new runtime SHA; previous is the pre-deploy release. If validation failed after cutover, use the rollback section in `/home/user/code/shapiroserver2/docs/nanoclaw/Deployment.md`.

- [ ] **Step 4: Final implementation report**

Report:

- Runtime commit SHA deployed.
- `shapiroserver2` deploy commit SHA.
- Focused and full tests run.
- Standard live checks run.
- Attachment-specific live smoke result.
- Whether a real human Discord attachment acceptance message was run or was unavailable without unsafe user-token automation.
