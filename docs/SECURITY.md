# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Agent groups | Trusted according to their channel membership | Each group is an isolated conversation/workspace, not a privilege tier |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- Additional mounts are read-only unless the allowlisted root permits read-write and the group config explicitly requests it

**Shared Workspace Mounts:**

Every agent group gets the same shared project surfaces: managed repos at `/workspace/repos`, local skill authoring at `/workspace/local-skills`, and managed-repo IPC at `/workspace/ipc`. Release source and host configuration remain outside the container; agents only see explicit bind mounts.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Isolation (OneCLI Agent Vault)

Real API credentials **never enter containers**. NanoClaw uses [OneCLI's Agent Vault](https://github.com/onecli/onecli) to proxy outbound requests and inject credentials at the gateway level.

**How it works:**
1. Credentials are registered once with `onecli secrets create`, stored and managed by OneCLI
2. When NanoClaw spawns a container, it calls `applyContainerConfig()` to route outbound HTTPS through the OneCLI gateway
3. The gateway matches requests by host and path, injects the real credential, and forwards
4. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`

**Per-agent policies:**
Each NanoClaw group gets its own OneCLI agent identity. This allows different credential policies per group (e.g. your sales agent vs. support agent). OneCLI supports rate limits, and time-bound access and approval flows are on the roadmap.

**GWS policy proxy:**
Yente agents use `GWS_PROXY_URL` and the `/usr/local/bin/gws` shim for Google Workspace access. Every remote invocation starts with exactly `--account personal` or `--account glowforge`; there is no `primary` alias or single-call `both` mode. The shim removes that selector from upstream argv, places it in the request envelope, and rejects a response unless `X-GWS-Account` matches before any body or downloaded file is exposed. Account-aware `auth status` uses authenticated `POST /whoami`. A task spanning both accounts is two independent, separately labeled calls through the same generic OneCLI route, not a cross-account transaction. OneCLI injects the proxy authorization header; the shim sends no bearer and agent containers receive no `GWS_PROXY_KEY`.

For `-o/--output`, the shim validates the caller path against shim-owned workspace roots, strips the path before forwarding args, receives file bytes from the proxy, verifies byte count and SHA-256 metadata, and publishes the file inside the agent workspace without overwriting an existing target. The trusted `gws-proxy` service never receives caller output paths and accepts output mode only for allowlisted Drive read operations. Agent containers must not mount `/srv/nanoclaw/shared/gws-config` and must not include Google OAuth files or the real Google Workspace CLI. Per-agent `install_packages` rebuilds preserve the same boundary: `gws` is reserved for the shim, direct `@googleworkspace/cli` package requests are rejected before approval, and image rebuilds fail closed if a package creates another executable `gws` anywhere on `PATH` other than `/usr/local/bin/gws` or at `/pnpm/gws`. The trusted `gws-proxy` service boundary may hold the real CLI, OAuth state, recipient policy, temporary proxy-local output files, and audit logs. The host also mounts only the one validated effective skill inventory selected for that group, so Claude, Codex, OpenCode, threaded sessions, and operator forks cannot discover broader provider-specific skill roots.

**Browser handoff broker:**
Yente agents use `YENTE_BROWSER_HANDOFF_URL` plus the local `superpowers-chrome`
skill helper to reach the shared browser broker through OneCLI. The
`Yente Browser Handoff` OneCLI secret grants the broker authorization header;
agent containers must not receive the broker token, VNC password, Chromium
profile, or direct VNC/CDP access.

**NOT Mounted:**
- Channel auth sessions (`store/auth/`) — host only
- GWS OAuth config (`/srv/nanoclaw/shared/gws-config`) — trusted `gws-proxy` only
- Browser handoff secrets and Chromium profile — trusted browser handoff service only
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

## Privilege Comparison

| Capability | Agent Groups |
|------------|--------------|
| Group folder | `/workspace/agent` (rw) |
| Global memory | `/workspace/global` (ro) |
| Managed project repos | `/workspace/repos` and `/workspace/extra/repos` (rw) |
| Local skill checkout | `/workspace/local-skills` (rw) |
| Managed-repo IPC | `/workspace/ipc` (rw) |
| Additional mounts | Configurable; read-only unless explicitly allowed read-write |
| Network access | Unrestricted |
| MCP tools | All configured tools for the group |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • OneCLI Agent Vault (injects credentials, enforces policies)   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through OneCLI Agent Vault                   │
│  • No real credentials in environment or filesystem              │
└──────────────────────────────────────────────────────────────────┘
```

## Supply Chain Security (pnpm)

NanoClaw uses pnpm with two supply chain defenses configured in `pnpm-workspace.yaml`:

### Minimum Release Age

`minimumReleaseAge: 4320` (3 days). pnpm will refuse to resolve any package version published less than 3 days ago. This defends against typosquatting and compromised maintainer accounts — most malicious publishes are detected and pulled within 72 hours.

**Excluding a package from the release age gate** (`minimumReleaseAgeExclude`):

This should be rare. When a zero-day fix or critical dependency requires an immediate update:

1. The exclusion must be reviewed and approved by a human maintainer
2. The entry must pin the **exact version** being excluded — never a range or wildcard
   ```yaml
   minimumReleaseAgeExclude:
     some-package: "1.2.3"  # Approved by @user, 2026-04-14 — CVE-XXXX-YYYY fix
   ```
3. The exclusion should be removed once the version ages past the threshold (i.e. after 3 days)
4. Automated agents (Claude, CI bots) must never add exclusions without human sign-off

### Build Script Allowlist

`onlyBuiltDependencies` restricts which packages can execute install/postinstall scripts. Only packages on this list are permitted to run build scripts during `pnpm install`. Currently allowed:

- `better-sqlite3` — compiles native SQLite bindings
- `esbuild` — downloads platform-specific binary
- `protobufjs` — generates protobuf bindings (used by Baileys/libsignal)
- `sharp` — downloads platform-specific image processing binary

Adding a package to this list requires human approval — build scripts execute arbitrary code with the installing user's permissions.

### `.npmrc` Safety Net

The `.npmrc` file contains `minReleaseAge=3d` as a fallback. The authoritative setting is in `pnpm-workspace.yaml`, but `.npmrc` provides defense-in-depth if npm is ever invoked directly (e.g. by a tool that doesn't respect pnpm).
