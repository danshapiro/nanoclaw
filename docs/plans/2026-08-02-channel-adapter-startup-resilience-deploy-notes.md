# Deploy notes — channel adapter startup resilience (2026-08-02 outage class)

Runtime changes ship in danshapiro/nanoclaw (branch overlay/shapiroserver2).
The notes below record the VERIFIED host-side state (2026-08-02, read-only
ssh) and what the deploy step must (and must not) do. The in-runtime startup
retry is the real fix; no systemd unit change is required.

## 1. systemd unit — verified state; NO ordering change required

File: `srv/nanoclaw/nanoclaw.service` (deployed at `/etc/systemd/system/nanoclaw.service`)

The original plan called for adding `After/Wants=network-online.target`.
Validation (2026-08-02, read-only ssh to the live host) falsified that
premise on both halves:

- the live unit (and the repo unit since commit `29c5472`, 2026-03-26)
  ALREADY carries both directives — they were present through the incident;
- they are VACUOUS on this host: `systemd-networkd-wait-online.service` is
  skipped ("start condition unmet" — observed at the 2026-08-02 09:55:25
  incident reboot itself), so `network-online.target` was reached at 2.019 s,
  4 ms after `network.target`.

So: no unit change. The runtime startup retry (Tasks 1–2) is the actual fix
for the cold-network window. OPTIONAL host-side hardening, only if desired
later: make a wait-online service actually run — that is generator/netplan
level work (satisfying the service's start condition), NOT a unit `Wants=`
edit; investigate on the host before relying on it.

Keep `Restart=on-failure` / `RestartSec=5` unchanged — VERIFIED ACTIVE live
(`systemctl show`: `Restart=on-failure`, `RestartUSec=5s`; sole drop-in
`10-discord-onfailure.conf` is an additive `OnFailure=` pager only). The
AgentMail late-acquisition path DEPENDS on it: when the runtime acquires the
OneCLI env after boot, it logs
`AgentMail OneCLI env acquired after boot; exiting so systemd restarts nanoclaw ...`
and exits(1) so start.sh's env eval re-runs against the healthy network. The
deploy step should re-assert unit parity (repo unit == `systemctl cat
nanoclaw`) whenever it ships this feature.

Residual risk — CORRECTED by validation (the previous "until systemd's
start-limit backoff engages" wording was FALSE): if start.sh's eval
persistently fails while the in-process script succeeds — which requires a
start.sh bug, since both run the same code path — the exit(1)/restart loop is
NOT bounded. With the live values (`StartLimitBurst=5`,
`StartLimitIntervalSec=10`, `RestartSec=5`, systemd 255) the start limit is
mathematically unreachable (≤3 starts fit in any 10 s window), so the unit
never enters `failed` state, NO backoff engages, the loop churns silently
forever — and the host's `OnFailure=discord-notify@%N` pager never fires for
this class. Detector: repeated `AgentMail OneCLI env acquired after boot`
fatal lines across restarts in `journalctl -u nanoclaw`. Break the loop with
`AGENTMAIL_ONECLI_ENV_EXIT_ON_ACQUIRE=0`.

## 2. New runtime env tunables (all optional; defaults ship correct behavior)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHANNEL_STARTUP_RETRY_DISABLED` | `0` | `1` restores legacy single-attempt startup |
| `CHANNEL_STARTUP_RETRY_DELAYS_MS` | `5000,15000,45000,120000,300000` | backoff ladder |
| `CHANNEL_STARTUP_RETRY_CAP_MS` | `300000` | repeat delay after ladder, forever |
| `CHANNEL_STARTUP_RETRY_JITTER` | `0.2` | additive jitter ratio 0..1 |
| `CHANNEL_STARTUP_FIRST_ATTEMPT_WAIT_MS` | `30000` | max ms boot blocks per channel's first start attempt (`0` = wait forever); capped attempts keep running in the background |
| `DISCORD_COMMAND_SYNC_RETRY_{DISABLED,DELAYS_MS,CAP_MS,JITTER}` | same | background command-sync knobs |
| `AGENTMAIL_ONECLI_ENV_SCRIPT` | `${NANOCLAW_ROOT}/agentmail-onecli-env.mjs` | env script the runtime re-runs |
| `AGENTMAIL_ONECLI_ENV_TIMEOUT_MS` | `30000` | script timeout |
| `AGENTMAIL_ONECLI_ENV_EXIT_ON_ACQUIRE` | `1` | `0` = never exit-for-restart on late acquisition |

## 3. Health signal for host-side detectors

Every channel state transition emits one INFO line (INFO verified visible in
the live journal — the running service already logs INFO-level lines):

```
Channel adapter status channel="discord" status="retrying" attempt=3 lastError="fetch failed" retryInMs=45000
Channel adapter status channel="discord" status="started" attempt=4
Channel adapter status channel="whatsapp" status="starting" attempt=1
Channel adapter status channel="whatsapp" status="failed" attempt=1 lastError="..."
```

Detector recipe: `journalctl -u nanoclaw | grep 'Channel adapter status'` —
`status="retrying"` means degraded-but-self-healing; `status="starting"`
means a first attempt exceeded the boot-wait cap and is still in flight;
`status="failed"` is permanent (retries disabled, shutdown, or an error
marked permanent — e.g. WhatsApp logged out, where human re-pairing is
required). IMPORTANT semantics (validated): `status="started"` means
`setup()` RESOLVED — for discord it does NOT prove the gateway connected or
the token is valid (login is fire-and-forget), and for agentmail it does NOT
prove the socket opened. It is a startup-progress signal, not a connectivity
probe. The legacy ERROR `Failed to start channel adapter` now indicates a
PERMANENT failure only (retries disabled, shutdown, or permanent-marked
error); during retries the same words appear as WARN
`Failed to start channel adapter, will retry`.

Known pre-existing limitation (out of scope, documented for operators):
outbound deliveries drained while a channel is down are dropped and marked
delivered (`src/index.ts:175-178` → `delivery.ts:349-350`); this plan
SHRINKS that window (channels come back on their own) but does not remove
the path.
