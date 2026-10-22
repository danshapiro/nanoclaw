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

**Goal:** A Discord Word document larger than 10 MiB is streamed to disk, copied into the routed agent workspace, and available by the existing workspace path without a full-file base64 string in memory or SQLite.

**Design:** Use a fixed 1 GiB per-file limit and a 10-minute download timeout. Prefer a validated HTTP(S) attachment URL and stream it to a unique temporary file; retain the current 10 MiB ceiling only for SDK attachments that have no usable URL. Carry a temporary local path through routing, copy it atomically into each recipient group's existing attachments directory, and remove temporary files after the full route settles. The existing prompt path remains the way the agent learns where the Word document is.

Approval callbacks currently run asynchronously while persisting the original event. Make routing await the small approval-persistence step, so the source file remains available until it has been copied to an approval-owned spool under DATA_DIR and its row is durable. Keep card delivery asynchronous. Approval replay copies from that private spool into the current recipient groups; denial and completion remove the spool. Keep current approval-row consumption behavior on replay failure and log the failure.

The supported download can outlive the Discord route lease and Node's default local-fetch timeout. Add a small same-process guard for duplicate work on a channel/message pair, and use a local HTTP request without a short timeout that resolves only after the webhook response completes.

## Constraints

- The per-attachment cap is fixed at 1,073,741,824 bytes; do not add a configuration knob or a per-message limit.
- Enforce the cap from declared size where available, response Content-Length where available, and actual streamed bytes.
- Never buffer or base64-encode a URL-backed attachment. Keep the no-URL SDK fallback at 10 MiB and check its declared and returned sizes.
- Keep incomplete download and spool files cleaned up on errors. Temporary download paths must never enter durable session rows; only the approval-owned spool path may be stored with a pending approval.
- Preserve the existing /workspace/agent/attachments/... path, per-attachment error behavior, other channels' base64 handling, and provider-native image behavior.
- Do not log attachment bytes or signed attachment URLs.
- Runtime changes stay on this task branch. The canonical overlay has since advanced to a25b686; the-usual work must not merge or rebase it. No publish, deployment pin change, or production deployment in this run.

## Task 1: Implement and verify the complete path

**Modify:**

- src/channels/chat-sdk-bridge.ts
- src/yente/attachments.ts
- src/session-manager.ts
- src/router.ts
- src/modules/permissions/index.ts
- src/modules/permissions/sender-approval.ts
- src/modules/permissions/channel-approval.ts
- src/modules/permissions/pending-attachments.ts (new shared spool helper)
- src/channels/discord.ts

**Tests:**

- src/channels/chat-sdk-bridge.test.ts
- src/yente/attachments.test.ts
- src/session-manager.test.ts
- src/router.test.ts
- src/modules/permissions/sender-approval.test.ts
- src/modules/permissions/channel-approval.test.ts
- src/channels/discord.test.ts

1. Add failing tests first. Cover a chunked 17 MiB URL response without Content-Length, URL preference when fetchData is also present, exact bytes/hash, no data field, declared oversize rejection, actual-byte acceptance at and overflow above a small test-only limit, interrupted-stream cleanup, and the no-URL fallback's 10 MiB cap. For each behavior, run its focused test before implementing and confirm it fails because the behavior is missing.
2. Add file-path materialization into a temporary sibling followed by atomic rename. Confirm exact bytes, source preservation for fan-out, cleanup on failure, and that session rows retain only the existing workspace metadata and prompt path.
3. Make the router await access and channel approval hooks until their pending event and approval-owned attachment spool are stored. Keep question-card delivery asynchronous. Approval replay reads the durable spool; denial and completed replay remove it. Preserve existing approval-row behavior if replay fails. Test both approval routes, source cleanup after strict routing, approval delivering exact bytes, denial creating no workspace file, and replay after reopening the test database.
4. Wrap Discord message forwarding with an in-flight set keyed by channel and message ID. Hold it through dispatch and route bookkeeping and release it in finally. Test a second presentation after an injected lease expiry while the first dispatch is pending, then confirm a later attempt is allowed after rejection.
5. Replace only the loopback webhook forwarding transport with a Node HTTP request that has no shorter-than-supported timeout and consumes the completed response. Preserve existing retry behavior. Test against an ephemeral server that withholds its response until released.
6. Run the focused tests and refactor the changed code while green:

       pnpm exec vitest run src/channels/chat-sdk-bridge.test.ts src/yente/attachments.test.ts src/session-manager.test.ts src/router.test.ts src/modules/permissions/sender-approval.test.ts src/modules/permissions/channel-approval.test.ts src/channels/discord.test.ts

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

For a later authorized release:

1. Start from the then-current canonical overlay/shapiroserver2 and integrate this task without rewriting its history. The currently observed canonical SHA is a25b686256968cd0d0a14ddc6d26dfb5985fb838. Run the focused and full checks again on the exact integrated runtime SHA; do not pin the task-branch SHA before this step.
2. In a clean shapiroserver2 main worktree, set srv/nanoclaw/source.conf to that exact tested runtime SHA. Run bash tests/validate.sh, commit and push the private main branch, then synchronize the generated deploy/nanoclaw publication branch using its documented procedure.
3. Only after explicit production-deploy authorization, run the documented coordinated deploy:

       bash srv/nanoclaw/deploy-host.sh --target prod \
         --expected-wrapper-sha "$SHAPIRO_SHA" \
         --expected-nano-sha "$NANO_SHA"

4. Run the canonical Discord/Yente end-to-end smoke with a one-hour timeout:

       ssh shapiroserver2-lan 'sudo /srv/nanoclaw/run-e2e-smoke.sh'

Then send a valid Word document larger than 10 MiB through the test Discord route and verify the answer contains a distinctive phrase from that document. If release verification fails, use the existing NanoClaw rollback procedure.
