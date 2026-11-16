# Reaction-rate-limit follow-up

Base09420 is prepared, live9010 remains authoritative. No deployment performed.

Real QA eyes/rocket calls returned explicit429 (retry_after0.3) and remained
unknown in live9010. Prepared09420 had two additional independently reproduced
P2 defects: malformed reaction-shaped multipart text could repeat an accepted
chunk; and a valid10second retry window exhausted all three attempts by3seconds.
The candidate narrows retry eligibility to nonempty string target/emoji without
files, and persists max(exponential, provider retry_after). Ambiguous sends and
transport/server failures retain reconciliation protection. Valid JSON trailing
whitespace is accepted; invalid/overflowing date delays are rejected.

Parent29focused tests+typecheck pass. Fresh zero-context independent read-only
review reproduced both base defects with the actual production ledger+bridge;
both reproductions pass on final source. Independent59delivery/thread,
18parser,11bridge-reaction tests pass (88 total),40additional parser assertions
pass, host typecheck passes. One Bun-dependent runner integration unavailable;
30 unrelated bridge tests excluded. Initial broad fixture attempt encountered
five pre-existing shared-/tmp permission failures and missing Bun; those are
preserved as qualification limits, not code successes. No other worker fixtures
were deleted or chmodded.

Bounded attempts remain3. This patch does not replay pre-existing unknown
outbound rows. Canonical deployment, actual provider behavior and receipt proof
remain separate. Review was read-only; parent implemented every source change.
