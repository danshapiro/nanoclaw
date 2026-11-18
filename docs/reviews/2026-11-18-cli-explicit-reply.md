# CLI-origin explicit reply routing — qualified source only

Base: `1871d503f1cd0694ed86893a7a4f0c072c83f8ab`. This topic is not a
canonical overlay promotion, source-pin change or production rollout.

## Contract
- Current CLI-origin default message/file/card/question and new-task tools use
  the exact host-accepted input reply address, with a coherent route stamp.
- Active identity requires matching complete, unended, same-source proof.
  Missing, ambiguous, malformed or foreign proof fails before enqueue.
- Legacy local CLI fallback requires absent identity and no unresolved redirect.
  Relay mode requires its nonempty route lock and exact accepted identity.
- CLI-origin scheduled output keeps its explicit parent/thread; implicit headline
  creation or cached result-thread reuse cannot replace that address.
- Ordinary platform-origin headline threading, ordinary non-CLI/shared defaults,
  explicit named destinations and the relay tool allowlist remain unchanged.
- No QA-specific runtime default, new schema or permanent routing migration.
  Arbitrary non-CLI/shared admin reply overrides remain a pre-existing limitation.

## Qualification
Final detached offline unit `yente-dev-explicit-reply-pair-v8-tests-20261118`
(invocation `c121ad9ea53a42d085c25fd69943f8b7`) ended November18
11:50:34 Pacific, exit0, with all14 selected gates and unchanged source hashes.
- Container:241 tests across9 files; host scheduler/delivery:167 tests across14 files.
- Paired infrastructure:38 helper tests,8 QA checks, deployment/boundary/receipt
  contracts, both TypeScript checks, formatting, syntax and diff checks passed.
- Fresh zero-context read-only final review reported no actionable findings;
  independently ran38 infrastructure,36 container and11 host tests.
- Behavioral RED/GREEN evidence covers total proof loss, missing relay lock
  and real headline resolver thread escape. Intermediate failed candidates remain
  recorded in the paired infrastructure proof; they are not accepted releases.

Production activation, QA-only live verification, ordinary post-release backup
and acquisition, broader proof debt and safe fixture reconciliation remain open.
Existing failed sends are preserved; this source does not replay or certify them.
