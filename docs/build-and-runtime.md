# Build & Runtime

NanoClaw runs a split stack: the host is Node + pnpm, the agent container is Bun. Session messages and ephemeral Discord typing activity pass through two SQLite files per session; trusted GWS correlation uses authenticated host IPC. The runtimes have no shared modules.

## Why the split

- **Host stays on Node** for the established channel adapters, SQLite native binding, and the tested WebSocket/HTTP stack.
- **Container runs Bun** because `bun:sqlite` is built-in (no native compile of `better-sqlite3` per image rebuild), source runs directly (no tsc build step at image build or session wake), and `bun install` is ~5-10× faster than `npm install`.

Host and container each have their own package tree:

```
/                             pnpm + Node 22
  pnpm-lock.yaml              host deps (channels, Chat SDK, better-sqlite3, etc.)
  pnpm-workspace.yaml         minimumReleaseAge + onlyBuiltDependencies policy

/container/agent-runner/      Bun 1.3+
  bun.lock                    agent-runner runtime deps (Claude Agent SDK, MCP SDK, zod, etc.)
  package.json                @types/bun, typescript devDeps for type-checking
```

The container image also has pnpm + Node inside for global CLIs (`@anthropic-ai/claude-code`, `agent-browser`, `vercel`). Those are Node binaries the agent invokes at runtime, not library deps. Keeping them on pnpm preserves the supply-chain policy for CLI versions.

`gws` is intentionally not a pnpm-installed global CLI. The image copies
`container/shim/gws` to `/usr/local/bin/gws`; the shim is the only supported
agent-facing GWS command and relies on OneCLI-mediated access to `gws-proxy`.
It explicitly supports lowercase and uppercase proxy env variants so curl
traffic to `GWS_PROXY_URL` stays on the OneCLI-mediated route, and it forces
that route even if inherited `NO_PROXY` values would otherwise match the
mediated proxy host.
Per-agent `install_packages` image rebuilds must keep that command reserved:
known direct-GWS packages such as `@googleworkspace/cli` are rejected at request
time, and the generated rebuild Dockerfile fails closed if package installation
creates another executable `gws` anywhere on `PATH` other than
`/usr/local/bin/gws`, including the explicit `/pnpm/gws` bypass shape.

`YENTE_BROWSER_HANDOFF_URL` is the agent-facing browser broker endpoint. Agent
containers receive that non-secret URL and the local `superpowers-chrome` helper;
OneCLI injects the `Yente Browser Handoff` authorization header. Broker secrets,
the VNC password, the Chromium profile, and direct CDP/VNC sockets stay outside
the agent container.

The optional OpenCode Browse service has a separate session approval contract.
`src/modules/browse-approval/` accepts `request_browse_session` and
`close_browse_session` outbound system actions. Requests carry the current
host-stamped input and route; the host resolves the actual human from its
inbound DB and posts Allow session / Cancel in that Discord conversation.
Only a matching Discord component receipt for that human, channel and card can
grant access. Stop and native-session closure revoke it; pending requests expire
after ten minutes. The broker independently enforces ten-minute idle expiry and
a one-hour maximum. Container sleep does not close an active conversation.

The host controls Browse through Unix HTTP at
`/srv/opencode-browse/control/broker.sock` (`NANOCLAW_BROWSE_CONTROL_SOCKET` may
override it). This socket is never mounted into agent containers. Approved
short-lived session permits are published through the existing read-only
host-correlation mount as `browse-session.json`; raw relay credentials remain
outside agents. A small identifier-only `data/browse-session-access.json` index
lets startup invalidate all retained access files before channels resume, even
if broker reset fails. New approvals stay blocked until control reset succeeds.
Broker revocation failures keep an explicit retryable Stop control and block the
helper; they never claim access was stopped. No runtime provider change or
Playwriter retirement is part of this feature. Deploy the matching broker and
editable Browse helper together; this source implementation alone is not proof
of production rollout.

## Lockfiles

| Tree         | Lockfile                          | Manager  | Regenerate after dep change                |
| ------------ | --------------------------------- | -------- | ------------------------------------------ |
| Host         | `pnpm-lock.yaml`                  | pnpm 10  | `pnpm install`                             |
| Agent-runner | `container/agent-runner/bun.lock` | Bun 1.3+ | `cd container/agent-runner && bun install` |

Both are committed. CI and the Dockerfile run `--frozen-lockfile` variants — any drift between `package.json` and lockfile fails the build.

## Supply chain

- **Host + global CLIs** (pnpm): `minimumReleaseAge: 4320` (3-day hold on new versions), `onlyBuiltDependencies` allowlist for postinstall scripts. See `pnpm-workspace.yaml` and `docs/SECURITY.md`.
- **Agent-runner** (Bun): no release-age policy — Bun doesn't have an equivalent today. The defenses are `bun.lock` pinning plus version-pinned CLIs/Bun itself via Dockerfile ARGs. When bumping `@anthropic-ai/claude-agent-sdk` or any runtime dep, review the release date on npm and bump deliberately, not via `bun update`.

## Image build surface

`container/Dockerfile` is a single-stage build on `node:22-slim`:

- **Pinned ARGs** — `BUN_VERSION`, `PNPM_VERSION`, `CLAUDE_CODE_VERSION`, `AGENT_BROWSER_VERSION`, `VERCEL_VERSION`. Bump deliberately in PRs. The image activates pnpm 10.33.0 explicitly, matching the host's `packageManager` pin; running Corepack without that pin can select a newer major with incompatible global CLI installation behavior.
- **ARG scope** — each tool's version is declared immediately before its
  installation. A Codex-only pin change reuses earlier system, Bun, runner
  dependency and CLI layers. Any changed step still rebuilds subsequent
  layers; Bun changes legitimately rebuild the dependencies installed by Bun.
  Versions and tool order are unchanged by this cache fix. It releases no
  existing cache bytes by itself, and no production build speed is claimed.
  Run `python3 scripts/test-build-layer-cache.py` on Linux with Docker,
  passwordless `sudo` and a static C compiler for the small behavioral fixture.
  It derives ARG/RUN order from this Dockerfile, uses an isolated Docker daemon
  under `.test-tmp`, and verifies real successive BuildKit cache identities.
  The short socket directory under `~/.cache` is recorded and removed on exit;
  shared development builders and images are never pruned.
- **CJK fonts** — `ARG INSTALL_CJK_FONTS=false`. `container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through. Default build saves ~200MB; opt in when the user works with Chinese/Japanese/Korean content.
- **BuildKit cache mounts** — `/var/cache/apt`, `/var/lib/apt`, `/root/.bun/install/cache`, `/root/.cache/pnpm`. Rebuilds where `package.json`/`bun.lock` haven't changed are fast. Requires BuildKit (default on Docker 23+, Apple Container-compat).
- **`tini` as init** — reaps Chromium zombies, forwards signals so in-flight `outbound.db` writes finalize on SIGTERM.
- **`entrypoint.sh`** (extracted) — honors explicit `docker run IMAGE <command>` arguments for image-surface smokes, otherwise captures stdin and `exec bun run /app/src/index.ts` under tini. Readable and diffable.
- **No compiled `/app/dist`** — Bun runs TS directly. The host also mounts fresh source over `/app/src` at session start, so host edits take effect without rebuilding the image.

The pinned stock Playwriter archive installs separately under `/opt/playwriter`
with optional dependencies omitted. `/usr/local/bin/playwriter` links to its
actual package entry point, so dependency checks resolve from the client rather
than a pnpm launcher. The build executes the client and accepts both stock
`0.4.0` and `playwriter/0.4.0 ...` version formats; archive identity checks remain
authoritative. This isolated install keeps Playwriter's optional-package policy
from removing binaries needed by other globally installed CLIs.
Corepack's prepared pnpm lives in the public, read-only
`/usr/local/share/corepack` cache so arbitrary runtime UIDs can use that exact
version without downloading another package manager on first use.
Global CLI executables are explicitly installed in `/pnpm/bin`, preserving the
absolute path used by the managed Codex wrapper. The image build checks these
paths as a non-root UID and starts Codex app-server offline with strict config
and closed stdin; checking only `codex --version` through `PATH` does not cover
that wrapper contract.

## Browse session approval

The Browse approval module accepts `request_browse_session` actions from the
existing session outbound DB. It resolves the requesting human from the host's
accepted Discord input and requires a matching real component click before
granting browser access. Generic agent responses cannot approve the request.

The gated Browse service exposes a host-only Unix HTTP control socket, default
`/srv/opencode-browse/control/broker.sock`; `NANOCLAW_BROWSE_CONTROL_SOCKET` can
override the host path. Never mount that socket into agent containers. The
runtime writes the approved task's short-lived token to `browse-session.json`
in the existing read-only `/workspace/.host-correlation` mount. The editable
Browse helper reads it and sends it to the broker without printing it. No new
agent environment or image-installed command is required.

Pending approvals expire after ten minutes. Active grants end through Stop,
task completion, native-session retirement, ten minutes idle or a one-hour
maximum. Failed revocation removes the helper token, reports uncertainty and
retains retry controls. Startup invalidates retained access records before
resetting the broker; failure leaves new requests blocked. A small host-only
index contains active session identifiers for this cleanup, not credentials
or an audit history. Deploy the runtime with the gated broker and updated
editable helper through the host repository's coordinated Browse runbook.

Approval and stop notifications keep the requesting Discord route, including
its thread and messaging-group metadata, so the already-open provider query
receives them promptly. They are host task notices, not new human requests.
Request failures retain that route only after human provenance was resolved.

## Session wake (two paths)

1. **Base image ENTRYPOINT** — used for stdin-piped test invocations like the sample in `container/build.sh`: `tini --> entrypoint.sh` captures stdin to `/tmp/input.json`, then `exec bun run src/index.ts`. When a command is passed to `docker run`, the entrypoint executes that command directly so image-surface checks can run without the runtime-only `/app/src` bind mount.
2. **Host-spawned session** — `src/container-runner.ts` at line ~301 uses `--entrypoint bash` with `-c 'exec bun run /app/src/index.ts'`. Bypasses tini (Docker's default PID 1 handling applies). Stdin is unused; all IO flows through the mounted session DBs.

Both paths end with Bun running the same source file from `/app/src/index.ts`.

## CI shape

`.github/workflows/ci.yml` installs both Node (with pnpm cache) and Bun, then runs in order:

1. `pnpm install --frozen-lockfile` (host)
2. `bun install --frozen-lockfile` in `container/agent-runner/` (container)
3. `pnpm run format:check`
4. `pnpm exec tsc --noEmit` (host typecheck)
5. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (container typecheck)
6. `pnpm exec vitest run` (host tests)
7. `bun test` in `container/agent-runner/` (container tests)

Any failure fails the PR.

### Container incident replay prerequisites

The runner suite calls the production `summarize-dnd` writer to verify real summary artifacts and recovery records. It never calls its model or transcription services. Supply a checkout of that repository with `NANOCLAW_SUMMARIZE_DND_TEST_ROOT`; revision `a49332b95fbda0248c84daf09d633f28727d4df1` is the verified fixture. The writer needs Python 3.12 with the JSON Schema dependency listed in `container/agent-runner/test-requirements.txt`. An optional `NANOCLAW_SUMMARIZE_DND_TEST_PYTHON` selects a virtual environment's interpreter; the default is `python3` on `PATH`.

`danshapiro/summarize-dnd` is private. The existing GitHub Actions workflow does not provision this fixture, and its default repository token cannot read it. That runner prerequisite must be supplied before the complete container suite can pass in CI; no new credential setup is included here.

For example, after checking out that `summarize-dnd` revision under `/tmp/summarize-dnd-replay`:

```bash
python3 -m venv /tmp/nanoclaw-replay-python
/tmp/nanoclaw-replay-python/bin/python -m pip install -r container/agent-runner/test-requirements.txt
cd container/agent-runner
NANOCLAW_SUMMARIZE_DND_TEST_ROOT=/tmp/summarize-dnd-replay \
NANOCLAW_SUMMARIZE_DND_TEST_PYTHON=/tmp/nanoclaw-replay-python/bin/python \
bun test
```

No workstation-specific worktree or virtual environment path is required. A missing writer checkout fails with the required setting, and replay cleanup stops the active test runtime before the next test starts.

## Key invariants

- **Session DBs must use `journal_mode=DELETE`.** WAL's `-shm` memory-map doesn't cross VirtioFS between host and guest. See the doc comment at the top of `container/agent-runner/src/db/connection.ts` and `src/session-manager.ts`.
- **Named SQL parameters in the container require the prefix in JS object keys.** `bun:sqlite` does not auto-strip `@`/`$`/`:` the way `better-sqlite3` does on the host. Use `$name` in both SQL and keys: `.run({ $id: msg.id })`. Positional `?` params work normally.
- **Agent-runner tests run under `bun:test`, not vitest.** `vitest.config.ts` excludes the `container/agent-runner/` tree because vitest runs on Node and can't load `bun:sqlite`.
- **No tsc build step in the container image.** Re-adding one would reintroduce the ~200-500ms per-session-wake cost we removed.
- **Global container CLIs stay on pnpm, not Bun.** `agent-browser`, `@anthropic-ai/claude-code`, `vercel` and any future Node CLIs the agent invokes should be pinned versions under the Dockerfile's pnpm global-install block. `bun install -g` would bypass the pnpm supply-chain policy.
- **GWS stays mediated.** The agent image must expose `/usr/local/bin/gws` as the policy-proxy shim, must not install the real Google Workspace CLI, and must not create or receive a Google OAuth config path. The trusted `gws-proxy` service owns the real CLI and OAuth state. For `-o/--output`, the shim writes caller-visible Drive export/download files locally from bytes streamed by the proxy, verifies byte count and SHA-256 metadata, and refuses to overwrite existing targets; the proxy uses only private temp output paths and never receives caller paths.
- **Browser handoff stays mediated.** Agents receive only `YENTE_BROWSER_HANDOFF_URL` and the skill helper. OneCLI owns broker authorization, and the browser handoff service owns the VNC password, profile, and CDP socket.
- **SDK tmp/CA material must escape systemd `PrivateTmp`.** The generated systemd unit (`setup/service.ts`) routes the OneCLI SDK's temp files to a host-visible runtime directory via `RuntimeDirectory=nanoclaw-sdk-tmp` + `Environment=TMPDIR=%t/nanoclaw-sdk-tmp`. The SDK writes its CA pems via `os.tmpdir()`, and dockerd resolves those paths in the _host_ namespace — under `PrivateTmp=yes` a plain `/tmp` path becomes an empty directory to Docker and yields an empty rustls trust store. Any externally-managed unit that enables `PrivateTmp=yes` (e.g. a deploy repo's own unit file) must mirror this `RuntimeDirectory`/`TMPDIR` mechanism; do not disable `PrivateTmp` instead.

## Migration history

This structure replaced a uniform npm-on-Node stack across both host and container. The pnpm migration landed first (PR #1771) to bring the host under supply-chain policy, then the container moved to Bun to eliminate native-module compilation and the per-wake tsc step. The split was chosen over going full-Bun because Baileys' native deps are the main risk surface on the host — the container has no such deps, so it benefits from Bun without taking the risk.

## Reconciling outbound delivery

A lost trusted-input control response requires the runner to exit for the
host's existing verified stop and recovery. A missing correlation pointer
does not establish rejection: the serialized host mutation may still publish
after the transport closes. The runner must not return that uncertain claim
to pending or keep retrying a closed control connection. Explicit authenticated
host rejections retain the existing retry behavior; exact processing-claim
and acceptance checks remain enforced. No operator should resend an input
whose acceptance or delivery is uncertain.

An adapter that is still starting leaves its outbound row pending with a
persisted backoff. Missing or retired routes and deterministic failures are
quarantined as `failed`. A platform request interrupted by process termination
or an ambiguous transport failure is quarantined as `unknown`: it may have
reached the recipient, so no automatic replay is safe. Outbox files remain in
place until a durable success receipt is recorded. A successful adapter may
legitimately return no platform message ID.

An explicit HTTP 429 rejection of a reaction without files uses the persisted
bounded retry path. It is one rejected operation, while a text/file delivery
may have accepted an earlier part before a later request is rate limited.
Ambiguous reaction transport failures still require reconciliation.

For a session's host-owned `inbound.db`, inspect quarantined rows:

```bash
pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/to/inbound.db
```

After checking the destination and verifying the entire text and all files,
record that it arrived, without resending:

```bash
pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/to/inbound.db MESSAGE_ID --confirmed-delivered
```

The receipt is durable; outbox files are retained for operator cleanup. If it
is certain that **nothing** arrived, fix the channel or files, then explicitly
requeue it:

```bash
pnpm exec tsx scripts/reconcile-delivery.ts /absolute/path/to/inbound.db MESSAGE_ID --confirmed-not-delivered
```

Messages intentionally discarded when a session is reset are recorded as `dropped`,
not as successful deliveries. The requeue command refuses inactive or missing source sessions and retains
the incident; a message on an archived session requires operator reconciliation.
If the session is active, the next poll retries the whole message after an
explicit requeue. A partly delivered message is neither
of these cases: reconcile the missing parts manually before recording completion.
Never requeue a partial or uncertain send: doing so can duplicate messages.


The November15 follow-up narrows safe reaction retry eligibility to nonempty
string message/emoji targets without files, matching the bridge's single
operation. Malformed reaction-shaped text retains outcome-unknown protection.
Explicit429 retry_after seconds (including JSON whitespace) are a persisted
minimum above exponential backoff; waiting polls consume no attempts. Invalid,
nonfinite or out-of-Date-range delays are rejected by parsing. Attempts remain
bounded; generic transport, server and multipart uncertainty is never replayed.

## Shared Codex catalog storage

Only `CODEX_HOME/cache/remote_plugin_catalog` receives a nested bind from
`DATA_DIR/.cache/codex-catalog/<group-id>/<Codex-version>`. The selected image
is resolved to its immutable ID, its actual Codex binary supplies the version,
and that same ID is launched. Version probes are cached per image ID for the
host process lifetime. Auth, config, SQLite, conversations, installed plugin
packages and plugin state remain private. Codex owns keyed atomic publication
and freshness; concurrent misses can still download twice.

The host holds shared kernel leases at
`data/.cache/session-store-leases/<group-id>/<session-id>.lock` from pre-wake
preparation through verified container stop, plus the corresponding
`catalog-store-leases/<group-id>/<version>.lock` while using a shared catalog.
The owning deployment repository's maintenance uses exclusive nonblocking
leases plus stable session labels and actual mount inspection. Lease inodes
must never be replaced or unlinked. The image probe and Linux `flock` are
required; unknown image/version or lease failure is a visible wake failure.
The host repository owns backup omission, operator forks and bounded weekly
catalog housekeeping. This source change alone does not claim deployment.

## Host container-log retention and archive capture

On Linux the host uses `/usr/bin/flock` to coordinate retention with the
backup hook. One persistent service-owned 0600 empty inode lives at
`data/../.container-log-retention.lock`; preserve filesystem traversal through
release/data symlinks, rather than normalizing `..` lexically. The backup
owns an exclusive lease during membership/stream/ACL cleanup. The runtime
holds a shared nonblocking lease only while deleting old tails. New tails
are published closed and uniquely named; clean and crash retention budgets
remain separate. Busy leases defer pruning until a later finalization;
unsafe/missing mutex or tool failures keep tails and log a diagnostic.
Never unlink or replace the mutex. Unsupported hosts conservatively retain
logs when the Linux lease utility is unavailable. The coordinated backup
hook is an external consumer; this source change alone does not prove an
off-machine backup or production rollout.
