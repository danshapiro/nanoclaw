# Continuation recovery lifecycle — source qualification

Status: reviewed, qualified source candidate. Production activation, natural continuation recovery and QA-only post-deploy verification remain pending. The active runtime and prepared overlay are unchanged; the owner's existing Facebook/Familiar task was neither replaced nor replayed.

Base: `8807979eb869f16760167d06b8e0bd198a044ecc`, containing the separately reviewed reaction retry follow-up atop prepared overlay09420/live9010.

## Repair

- A fully drained normal Codex query may request the existing clean whole-container recycle lifecycle only after a graceful zero app-server exit with no transport error. Aborts, native failures, setup/acceptance errors, early iterator return and signal escalation remain failures. Direct process exit never establishes descendant quiescence: correlation is retained until the host verifies the entire container stopped, before revocation or a successor.
- A clean recycle leaves never-bound queued inputs pending, preserving their original identities. Host-bound uncertainty stays recovery-owned. Genuine-failure ownership carries exact queued requests, route progress and side effects; completed original requests are excluded. Recovery formatting and successful exact-resume completion discharge the corresponding owned rows together.
- Native `turn/completed` status `failed` is an interruption, including when partial answer text exists. Provider-status diagnostics are sanitized at the outgoing boundary; raw internal evidence remains available.
- Fresh bounded recovery does not page on every projection generation. Malformed/future timestamps, stale recovery, retry exhaustion, terminal failures and GWS uncertainty retain visible failure paths.
- Single-member exhaustion preserves independently actionable live siblings and their side-effect context. A shared accepted prompt cannot safely be split: partial exhaustion persists `reconciliation_required`, blocks automatic context replay and TTL/wake release, and raises an idempotent reconciliation incident. Reporting retries after a crash/failure. The hold remains unresolved for pressure accounting and survives pruning; normal acceptance and resolution cannot clear it. An explicit evidence-based operator reconciliation is required.
- Malformed recovery metadata conservatively holds existing owned rows while unrelated fresh input can wake the runner's non-destructive repair path. The release path fails loudly and performs no release.

## Independent review

A fresh zero-context READ-ONLY reviewer independently reproduced the native failure misclassification, queued context/discharge gap, diagnostic credential leak, mixed-owner context loss, shared-prompt replay and malformed-metadata wake regression. Each was corrected and independently rechecked. Final assessment: no remaining actionable findings.

Independent validation: 256 Bun tests across nine relevant files, 17 host recovery tests, 19 isolated scheduler tests, both typechecks and diff checks. Private adversarial tests exercise real outbox sanitization, held work across later TTL passes, unrelated same-route wakes, and retained recovery acknowledgments. No production reads, provider calls, service signals or repository edits by the reviewer.

## Parent qualification

Exact frozen tracked-diff SHA256 before this documentation:
`9be2513ebd03375c31fc1afbf4fcda32c8c19b1288aa0df7cbe94a4b266f512f`.

Task-private pinned Bun1.3.12 (same as project Dockerfile) was downloaded from the official release; archive SHA256 `11dc3ee11bc1695e149737c6ca3d5619302cf4346e6b8a6ec7988967ef01ddc5` matched release asset metadata. Runner dependencies installed with the committed frozen lockfile. No global installation or production-image change.

Broader detached OFFLINE unit `yente-dev-scheduler-recovery-tests-20261115.service`, invocation `ac893bb6eed3447b840206b37237a334`, started2026-11-15T20:36:42-08:00 and ended20:37:47. Actual terminal log markers are `SCHEDULER_RECOVERY_BROAD_ALL_SELECTED_SUITES_PASS` and `SCHEDULER_RECOVERY_BROAD_TERMINAL_EXIT=0`; the diff hash was checked unchanged at exit.

- 213 host tests: session DB, host sweep, recovery escalation, scheduling sync/ledger/projection.
- 210 provider Bun tests.
- 198 session-state/poll-loop/formatter Bun tests.
- Host and runner typechecks, `git diff --check`.

**621 selected tests passed.** Targeted270 checks overlap these suites and are not an additive total. The complete runner incident-replay suite requiring the separate SummarizeDND fixture and full fleet/production smoke were not run here. Earlier test-fixture and shared-temp-path failures remain in private logs, followed by qualified final runs; no other workers' fixtures were deleted or chmodded.

Logs/scripts: garageserver `/home/yente-dev/.cache/backup-completion-races-20261115/scheduler-recovery-*`; independent adversarial evidence `/tmp/scheduler-zero-review-20261115.1r0hWz/`. These are private engineering evidence, not backup-completion or deployment receipts.
