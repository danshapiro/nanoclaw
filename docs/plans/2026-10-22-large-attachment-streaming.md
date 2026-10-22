# Stream Large Inbound Attachments to Agent Workspaces

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

**Goal:** A Word document larger than 10 MiB arriving through any currently active attachment-capable channel (Discord, AgentMail, or WhatsApp) is streamed to disk, copied into the routed agent workspace, and available by the existing workspace path without a full-file base64 string in memory or SQLite.

**Design:** Use a fixed 1 GiB per-file limit and a 10-minute download timeout. Stream Discord and AgentMail HTTP bodies and WhatsApp's Baileys media stream to unique files under `DATA_DIR/inbound-attachment-staging`; a startup sweep removes leftovers from interrupted runs. Chat SDK attachments with no usable URL may use `fetchData`, but the resulting bytes are capped at the same 1 GiB limit before being staged. Carry the distinct `stagedHostPath` field through routing, copy it asynchronously into each recipient group's existing attachments directory using a temporary sibling plus atomic rename, and remove staged files after the full route settles. The existing prompt path remains the way the agent learns where the Word document is.

Approval callbacks currently run asynchronously while persisting the original event. Make routing await the small approval-persistence step, so the source file remains available until it has been copied to an approval-owned spool under DATA_DIR and its row is durable. Keep card delivery asynchronous. Key the spool by approval ID and remove it whenever the pending row is consumed, including denial, failed replay, and parse-error paths. Approval replay copies from that private spool into the current recipient groups. Keep current approval-row consumption behavior on replay failure and log the failure.

The supported download can outlive the Discord route lease and Node's default local-fetch timeout. Add a small same-process guard for duplicate work on a channel/message pair, and use the same local HTTP request without a short timeout for both live Discord forwarding and catch-up delivery; it resolves only after the webhook response completes.

## Constraints

- The per-attachment cap is fixed at 1,073,741,824 bytes; do not add a configuration knob or a per-message limit.
- Enforce the cap from declared size where available, response Content-Length where available, and actual streamed bytes.
- Never buffer or base64-encode a URL-backed attachment. Cap the non-streamable Chat SDK `fetchData` fallback at the same fixed 1 GiB limit and check its declared and returned sizes.
- Keep incomplete download and spool files cleaned up on errors. Temporary download paths must never enter durable session rows; only the approval-owned spool path may be stored with a pending approval.
- Keep host file paths in the distinct `stagedHostPath` field; do not reuse `localPath`, which is used for agent-to-agent attachments. The approval row uses a separate `approvalSpoolPath`. Sweep only the dedicated staging directory at startup. Copy staged files asynchronously so a 1 GiB attachment does not block the host event loop.
- Clean staged files after route completion or failure, and when an adapter drops an event before routing; the startup sweep handles interrupted processes. Keep AgentMail's existing outbound attachment limit unchanged; the fixed 1 GiB limit applies to inbound files only.
- Preserve the existing /workspace/agent/attachments/... path, per-attachment error behavior, and provider-native image behavior.
- In download failure logs, include safe attachment metadata and a sanitized error summary; do not log raw fetch errors, attachment bytes, or signed attachment URLs.
- Log successful staged downloads at INFO with attachment metadata, byte count, and duration so slow transfers are diagnosable.
- Runtime changes stay on this task branch. The canonical overlay has since advanced to a25b686; the-usual work must not merge or rebase it. No publish, deployment pin change, or production deployment in this run.

## Task 1: Implement and verify the complete path

**Modify:**

- src/channels/chat-sdk-bridge.ts
- src/channels/agentmail-api.ts
- src/channels/agentmail.ts
- src/channels/whatsapp.ts
- src/yente/attachments.ts
- src/index.ts
- src/session-manager.ts
- src/router.ts
- src/modules/permissions/index.ts
- src/modules/permissions/sender-approval.ts
- src/modules/permissions/channel-approval.ts
- src/modules/permissions/pending-attachments.ts (new shared spool helper)
- src/channels/discord.ts
- src/channels/discord-catchup.ts

**Tests:**

- src/channels/chat-sdk-bridge.test.ts
- src/channels/agentmail-api.test.ts
- src/channels/agentmail.test.ts
- src/channels/whatsapp.test.ts
- src/yente/attachments.test.ts
- src/session-manager.test.ts
- src/router.test.ts
- src/modules/permissions/sender-approval.test.ts
- src/modules/permissions/channel-approval.test.ts
- src/channels/discord.test.ts

1. Add failing tests first. Cover a chunked 17 MiB Discord URL response without Content-Length (including a declared 17 MiB being accepted), URL preference when `fetchData` is also present, exact bytes/hash, no base64 `data` field, declared size over 1 GiB rejection, actual-byte acceptance at and overflow above a small test-only limit, bytes appearing in the staging file before the HTTP response's final chunk is released, interrupted-stream cleanup, sanitized logs when an error contains a signed URL, and the no-URL fallback's fixed 1 GiB cap. Cover AgentMail's streamed URL download and fixed inbound cap, plus WhatsApp's Baileys stream written to staging with size enforcement. For each behavior, run its focused test before implementing and confirm it fails because the behavior is missing.
2. Add startup cleanup for leftovers in the dedicated staging directory. Add asynchronous file-path materialization into a temporary sibling followed by atomic rename. Confirm exact bytes, source preservation for fan-out, cleanup on failure, event-loop responsiveness during a file copy, and that session rows retain only the existing workspace metadata and prompt path. Add an agent-to-agent regression test proving its existing `localPath` remains unchanged.
3. Make the router await access and channel approval hooks until their pending event and approval-owned attachment spool are stored. Keep question-card delivery asynchronous. Approval replay reads the durable spool; remove it whenever the pending row is consumed, including denial, failed replay, and parse errors. Test both approval routes, source cleanup after strict routing, approval delivering exact bytes, denial creating no workspace file, and replay after reopening the test database.
4. Wrap Discord message forwarding with an in-flight set keyed by channel and message ID. Hold it through dispatch and route bookkeeping and release it in finally. Test a second presentation after an injected lease expiry while the first dispatch is pending, then confirm a later attempt is allowed after rejection.
5. Replace the loopback webhook transport used by both live Gateway forwarding and Discord catch-up with a Node HTTP request that has no shorter-than-supported timeout and consumes the completed response. Preserve existing retry behavior. Use a deliberately short-timeout fetch stub and an ephemeral server that withholds its response until released; verify both live forwarding and catch-up wait for the completed response.
6. Run the focused tests and refactor the changed code while green:

       pnpm exec vitest run src/channels/chat-sdk-bridge.test.ts src/yente/attachments.test.ts src/session-manager.test.ts src/router.test.ts src/modules/permissions/sender-approval.test.ts src/modules/permissions/channel-approval.test.ts src/channels/discord.test.ts

       pnpm exec vitest run src/channels/agentmail-api.test.ts src/channels/agentmail.test.ts src/channels/whatsapp.test.ts

7. Run format, typecheck, lint, build, the full root suite, and the agent-runner suite:

       pnpm run format:check
       pnpm exec tsc --noEmit
       pnpm run lint
       pnpm run build
       pnpm test
       cd container/agent-runner && bun test

The base commit has one independently reproduced failure in src/gws-finalization.test.ts: the mode-0750 fixture conflicts with the protected-directory check. Record exact final results. Treat only that same test as pre-existing; investigate any other failure.

8. Commit the implementation and tests with a focused message. Run the final Fresh Eyes review and full verification on the exact final task-branch HEAD.

## Release and deployment

This run does not publish or deploy. Production stays unchanged without explicit deployment authorization.

For a later release, do not change the runtime pin, publish deployment metadata, or deploy until explicit production-deployment authorization is given. Then:

1. Start from the then-current canonical overlay/shapiroserver2, integrate this task without rewriting its history, run the focused and full checks on the resulting exact runtime SHA, and push that SHA to the NanoClaw fork. The currently observed canonical SHA is a25b686256968cd0d0a14ddc6d26dfb5985fb838; do not pin the task-branch SHA before integration and testing.
2. With the same deployment authorization in effect, in a clean shapiroserver2 main worktree set `srv/nanoclaw/source.conf` to the exact pushed runtime SHA, run `bash tests/validate.sh`, commit and push the private main branch, and synchronize the generated `deploy/nanoclaw` publication branch using its documented procedure. Define `NANO_SHA` as the pushed runtime SHA and `SHAPIRO_SHA` as the resulting pushed shapiroserver2 main commit SHA.
3. Run the documented coordinated deploy:

       bash srv/nanoclaw/deploy-host.sh --target prod \
         --expected-wrapper-sha "$SHAPIRO_SHA" \
         --expected-nano-sha "$NANO_SHA"

4. Run the canonical Discord/Yente end-to-end smoke with a one-hour timeout:

       ssh shapiroserver2-lan 'sudo /srv/nanoclaw/run-e2e-smoke.sh'

Then send a valid Word document larger than 10 MiB through the channel used for the original failure and verify the answer contains a distinctive phrase from that document. If release verification fails, use the existing NanoClaw rollback procedure.
