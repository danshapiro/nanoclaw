# 1 GiB Inbound Attachment Streaming Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh implementer and a specification-plus-quality review after every task. Track progress with the checkbox steps below.

## User Request

### Requested result
Implement 1 GiB inbound file attachments in NanoClaw by streaming downloads to disk and handing file paths internally, so large Word documents reach the agent.

### Explicit constraints
- Use the-usual and keep the plan simple, avoiding overbuild.
- Include testing and deployment in the plan.
- Work in a dedicated worktree and commit changes.
- Use the NanoClaw `overlay/shapiroserver2` source branch.
- Do not deploy to production without explicit authorization.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** A Discord Word document larger than 10 MiB is downloaded to disk, stored in the routed agent workspace, and available to the agent by path without a full-file base64 string in memory or SQLite.

**Architecture:** The Chat SDK bridge streams URL-backed attachment bytes into a temporary file, with a fixed 1 GiB per-file cap and a longer download timeout. It carries only that temporary path through routing. The session manager copies the file atomically into each recipient group's existing attachments directory, records only the final workspace path and metadata, and removes the temporary download after strict routing finishes. Keep the SDK `fetchData` fallback only for attachments with no usable URL and cap that in-memory compatibility path at the existing 10 MiB limit; never base64-encode it.

**Tech Stack:** TypeScript, Node.js streams and filesystem APIs, Chat SDK, Vitest, SQLite-backed host routing.

## Global Constraints

- The fixed per-attachment limit is 1 GiB (1,073,741,824 bytes); do not add a user configuration knob or a new per-message limit.
- The 1 GiB path requires a streamable URL. Keep the whole-buffer SDK fallback limited to small attachments (10 MiB maximum) so known large files use the streaming path.
- Enforce the limit from declared attachment size when available, response Content-Length when available, and actual streamed bytes. A missing or incorrect size header must not allow an oversized download.
- Download sequentially as today. Keep staging files alive through the complete strict route because a message may fan out to several agent groups. Copy each staged file into each destination group; do not consume the source on the first recipient.
- Remove partial downloads on network, timeout, or size errors. Remove completed staging files after routing resolves or rejects. Never store a staging path or file bytes in the durable inbound row.
- Preserve the existing `/workspace/agent/attachments/...` path contract, per-attachment error behavior, and other channels' base64 attachment handling.
- The separate provider-native image attachment limits and behavior are outside this change; Word documents are read through their existing mounted workspace path.
- Source-only work belongs on `overlay/shapiroserver2`. Preparing the server deployment pin requires the exact tested runtime commit. Production deployment and its host smoke are conditional on explicit authorization.
- Keep agent-visible error messages and structured logs free of CDN URLs and attachment bytes.

---

### Task 1: Stream inbound attachments to durable agent paths

**Files:**
- Modify: `src/channels/chat-sdk-bridge.ts`
- Test: `src/channels/chat-sdk-bridge.test.ts`
- Modify: `src/yente/attachments.ts`
- Test: `src/yente/attachments.test.ts`
- Modify: `src/session-manager.ts`
- Test: `src/session-manager.test.ts` and, if needed for fan-out behavior, `src/router.test.ts`

**Interfaces:**
- The bridge's serialized attachment keeps the current metadata and adds an internal `localPath: string` for a successfully staged download. It does not set `data`.
- Add `materializeAttachmentFile(args: { groupsDir: string; groupFolder: string; channel: 'discord' | 'whatsapp' | 'agentmail'; messageId: string; attachmentId: string; originalName: string; contentType: string | null; sourcePath: string }): MaterializedAttachment`.
- `writeSessionMessage()` consumes `localPath`, calls the file materializer, replaces it with the existing durable workspace metadata, and removes `localPath` and `data` before storing the inbound row.

- [ ] **Step 1: Add failing stream and handoff tests**

In `src/channels/chat-sdk-bridge.test.ts`, serve a 17 MiB response in chunks from a local HTTP server without a Content-Length header. Give the attachment both a usable URL and a `fetchData` spy. Assert that the URL path is used, the spy is untouched, the saved file has the full byte count and expected hash, and the returned attachment contains `localPath` but no base64 `data`. Exercise actual-byte overflow with a small test-only limit passed to the internal stream helper; production callers must always use the fixed 1 GiB constant. Add cases for a declared size above the production 1 GiB limit, a failed response mid-stream, cleanup of incomplete files, and the no-URL `fetchData` fallback's 10 MiB cap.

In `src/yente/attachments.test.ts`, stage a source file and assert that `materializeAttachmentFile()` atomically creates the correctly named durable file, preserves exact bytes, and leaves the source intact for a second recipient. Assert cleanup of a partial destination when copying or renaming fails.

In `src/session-manager.test.ts`, pass an attachment with an internal `localPath` through `writeSessionMessage()`. Assert the final group file is readable, the inbound row includes the existing workspace path and size metadata, and the row contains neither `localPath` nor `data`. In `src/channels/chat-sdk-bridge.test.ts`, exercise strict-route resolution and rejection to prove the bridge retains the staging file until routing finishes and removes it afterward.

- [ ] **Step 2: Run the focused tests and confirm they fail for the missing path flow**

Run: `pnpm exec vitest run src/channels/chat-sdk-bridge.test.ts src/yente/attachments.test.ts src/session-manager.test.ts src/router.test.ts`

Expected: FAIL because the bridge still emits base64 data, has a 10 MiB limit, and the session manager cannot materialize a staged file path.

- [ ] **Step 3: Implement the streamed download**

In `src/channels/chat-sdk-bridge.ts`, replace the URL fallback's `arrayBuffer()` and base64 encoding with a Node stream pipeline to a unique temporary file. Prefer the validated HTTP(S) URL when one exists, even if the SDK object also provides `fetchData`. Use the fixed 1 GiB byte limit, a 10-minute request timeout, early checks for known attachment and response sizes, and a counting transform that stops the stream once actual bytes exceed the limit. Remove the partial file on every failed pipeline. For an attachment without a usable URL, preserve the `fetchData` fallback only up to the existing 10 MiB limit: reject a declared oversize before calling it, check the returned buffer's actual size, write accepted bytes to a temporary file, and never encode them as base64.

- [ ] **Step 4: Carry and clean staging paths**

Add the temporary `localPath` to attachment metadata. Keep an in-memory staged-path list keyed to the message object while `messageToInbound()` serializes its attachments. In `forwardInboundMessage()`, use `try/finally` around inbound conversion and the complete strict forwarding promise; remove the paths in the `finally` block so routing fan-out can copy them first and conversion or routing failures cannot leave staging files behind. Retain per-attachment error metadata and continue processing later attachments when one download fails. Use safe error text in rows and structured logs; do not log URLs, tokens, or file bytes.

- [ ] **Step 5: Materialize one durable copy per recipient**

In `src/yente/attachments.ts`, add the file-path materializer. Copy each source to a unique temporary sibling inside the existing destination directory, then rename it atomically to the current safe final filename. On failure, remove the destination temporary file and preserve the source for other recipients or route replay.

In `src/session-manager.ts`, handle `localPath` alongside the existing `data` path. Replace it with the existing durable metadata and prompt path before inserting the SQLite row. Leave current base64 handling intact for other channels.

- [ ] **Step 6: Run focused tests, then refactor while green**

Run: `pnpm exec vitest run src/channels/chat-sdk-bridge.test.ts src/yente/attachments.test.ts src/session-manager.test.ts src/router.test.ts`

Expected: PASS, including the 17 MiB stream, actual-byte limit enforcement, source preservation across recipients, strict-route cleanup, and absence of file bytes or temporary paths in durable rows.

Refactor only the changed bridge and materializer code while these tests remain green.

- [ ] **Step 7: Run impacted checks**

Run: `pnpm run format:check && pnpm exec tsc --noEmit && pnpm run lint && pnpm test`

Expected: Formatting, typecheck, lint, and the root test suite pass except for the baseline failure `src/gws-finalization.test.ts > sealAndDrainGwsCorrelation > accepts systemd credential mode 0440 only from its protected credential directory`, which reproduced at the plan's base commit. Record exact results in the progress ledger; do not change that unrelated test or its implementation.

- [ ] **Step 8: Commit the complete task**

```bash
git add src/channels/chat-sdk-bridge.ts src/channels/chat-sdk-bridge.test.ts src/yente/attachments.ts src/yente/attachments.test.ts src/session-manager.ts src/session-manager.test.ts src/router.test.ts
git commit -m "feat: stream large inbound attachments to disk"
```

Add only files actually changed to the commit.

---

## Deployment and post-deployment verification

This run prepares and commits the tested runtime change; the following release procedure is a separate, explicitly authorized deployment and does not mutate production by itself.

1. After local checks and review pass, publish the exact tested runtime commit to the NanoClaw fork's canonical `overlay/shapiroserver2` branch.
2. In a separate `shapiroserver2` main worktree, pin `srv/nanoclaw/source.conf` to that exact runtime SHA. Run `bash tests/validate.sh`, commit and push the deployment-repo change, then publish/squash-sync the generated `deploy/nanoclaw` branch from `main`.
3. After explicit production-deploy authorization, use the coordinated lane from the synchronized deployment repo:

```bash
bash srv/nanoclaw/deploy-host.sh --target prod \
  --expected-wrapper-sha "$SHAPIRO_SHA" \
  --expected-nano-sha "$NANO_SHA"
```

4. Run the canonical host verification with a one-hour command timeout:

```bash
ssh shapiroserver2-lan 'sudo /srv/nanoclaw/run-e2e-smoke.sh'
```

Also send a valid Word document larger than 10 MiB to the test Discord route and ask for a distinctive phrase in it. Confirm the reply uses that document's content. If production validation fails, follow the rollback procedure in `docs/nanoclaw/Upgrade.md`; do not switch providers as a recovery shortcut.

