# Repository Guidelines

## Quick Context
NanoClaw is a personal Claude assistant built as a small Node.js/TypeScript system. The core runtime is a single host process with a skill-first channel system: channels self-register at startup, inbound messages are stored in SQLite, and responses are produced by Claude Agent SDK instances running in isolated Linux containers. This repository is a fork: `upstream/main` is the upstream product line, `origin` is the personal fork remote, and `overlay/shapiroserver2` is the long-lived local deploy overlay. Each group gets its own filesystem and memory boundary.

## Upstream-First Fork Policy
- Treat `upstream/main` as the product, architecture, and workflow source of truth for this fork.
- Keep local `main` easy to update from `upstream/main`. Do not make changes that increase long-term fork drift unless the user explicitly approves that exact divergence in this session.
- Do not make fork-specific product, architecture, deployment, auth, workflow, or built-in-vs-skill decisions on your own.
- Before changing core runtime or release-management files, fetch and compare with `upstream/main`, then explain how the proposed change preserves updateability.
- Sensitive files include: `src/index.ts`, `src/container-runner.ts`, `src/container-runtime.ts`, `src/config.ts`, `src/db.ts`, `src/router.ts`, `src/channels/index.ts`, `container/agent-runner/**`, `setup/**`, `groups/main/CLAUDE.md`, `groups/global/CLAUDE.md`, `package.json`, `package-lock.json`, and `CHANGELOG.md`.
- Explicit user approval is required before changing the auth model, deployment model, container mount model, channel-loading model, built-in-vs-skill boundaries, or dependency choices that replace upstream architecture.
- If you think divergence from `upstream/main` is necessary, stop and ask the user. Do not implement it speculatively, and do not treat existing fork drift as precedent.

## Project Structure & Key Files
`src/` contains the main runtime. Important files include `src/index.ts` for orchestration, `src/channels/registry.ts` for channel registration, `src/ipc.ts` for task processing and IPC watching, `src/router.ts` for message formatting and outbound routing, `src/container-runner.ts` for agent container execution, `src/task-scheduler.ts` for recurring work, `src/db.ts` for SQLite operations, and `src/config.ts` for paths and intervals. `setup/` contains guided installation and platform checks. `container/` contains the agent image, runtime assets, and `container/skills/` for skills loaded inside agent containers. Host-side skills live in `.claude/skills/`. Group memory lives under `groups/<name>/CLAUDE.md`. `docs/` holds design and operational notes; `assets/` holds images; `config-examples/` holds example config payloads; `dist/` is generated output.

## Deployment: shapiroserver2 Only
This repository is deployed to the server `shapiroserver2` only. Before making any deployment-related change, or before attempting a deploy, you MUST consult the server documentation in `/home/user/code/shapiroserver2`.

The primary deployment references are:
- `/home/user/code/shapiroserver2/docs/nanoclaw/Deployment.md`
- `/home/user/code/shapiroserver2/docs/nanoclaw/Upgrade.md`
- `/home/user/code/shapiroserver2/AGENTS.md`
- `/home/user/code/shapiroserver2/README.md`

Important constraints from that documentation:
- NanoClaw is not deployed as a Compose service.
- Do not use `srv/deploy.sh` for NanoClaw.
- The host-specific deployment path is `bash /home/user/code/shapiroserver2/srv/nanoclaw/deploy-host.sh`.
- Releases live under `/srv/nanoclaw/releases/<git-sha>/` on the server.
- Durable state lives under `/srv/nanoclaw/shared/`.
- `groups/global/CLAUDE.md` and `groups/main/CLAUDE.md` are release-managed defaults and require manual merge handling on deploy if they changed.

If you change deployment behavior, auth flow, backups, rollback, recovery, or server assumptions in this repo, update the matching docs in `/home/user/code/shapiroserver2` in the same task.

## Deploy Branch Strategy
- Keep `main` aligned with `upstream/main`, then mirror that clean baseline to the personal fork's `main` branch. Do not treat temporary fix branches as the deploy path.
- The long-lived NanoClaw deploy overlay branch is `overlay/shapiroserver2`. Deploy-affecting NanoClaw runtime changes must be folded back into that branch before the task is complete.
- The matching long-lived deploy-management branch in `shapiroserver2` is `deploy/nanoclaw`, and it owns the NanoClaw source pin in `srv/nanoclaw/source.conf`. Do not leave that pin only on a scratch branch.
- Short-lived worktree branches are disposable implementation branches only. Use them to isolate risky work, but before stopping you must cherry-pick or re-express the final deploy-relevant commits onto the long-lived branch for that repo.
- After a scratch branch's commits have been preserved on the long-lived branch, the scratch branch/worktree should be treated as cleanup work, not as part of the upgrade story.
- For the authoritative end-to-end operator sequence, follow `/home/user/code/shapiroserver2/docs/nanoclaw/Upgrade.md`.
- When preparing a future upgrade: rebase or replay the NanoClaw overlay branch onto updated `upstream/main`, test that branch, then update the `shapiroserver2` `deploy/nanoclaw` source pin to the tested commit. Do not assemble deployments by hunting across multiple topic branches.

## Skills Model
NanoClaw relies on skills more than built-in features. Read `CONTRIBUTING.md` before creating a PR or adding a skill.

There are four skill types:
- Feature skills: merge a `skill/*` branch to add a capability such as `/add-telegram` or `/add-slack`.
- Utility skills: ship code files alongside `SKILL.md`, such as `/claw`.
- Operational skills: instruction-only workflows kept on `main`, such as `/setup`, `/debug`, `/customize`, `/update-nanoclaw`, `/update-skills`, `/qodo-pr-resolver`, and `/get-qodo-rules`.
- Container skills: loaded inside the agent container from `container/skills/`.

Prefer shipping new capabilities as skills rather than expanding the base runtime. Core repo changes should usually be fixes, security work, or simplifications.

## Secrets, Credentials, and Proxying
Docker installs use OneCLI for Anthropic credential management. The host process reads `ONECLI_URL`, and containers receive OneCLI gateway configuration instead of raw Anthropic credentials. Apple Container remains the exception path and may still use direct Anthropic credentials where that runtime already expects them.

## Build, Test, and Development Commands
Use Node 20+.

- `npm run dev`: run NanoClaw directly from TypeScript sources.
- `npm run build`: compile TypeScript into `dist/`.
- `npm run start`: run the built app from `dist/index.js`.
- `npm run typecheck`: run `tsc --noEmit`.
- `npm run lint`: lint `src/` with ESLint.
- `npm run lint:fix`: apply auto-fixable lint changes in `src/`.
- `npm run format`: run Prettier on `src/**/*.ts`.
- `npm run format:check`: verify formatting.
- `npm test`: run the main Vitest suite for `src/` and `setup/`.
- `npx vitest --config vitest.skills.config.ts`: run skill tests.
- `npm run setup`: execute the host setup flow.
- `./container/build.sh`: rebuild the agent container image.

When acting as an agent in this repo, run commands directly rather than telling the user to run them.

## Service Management
If you need to manage a local install during development:

macOS with launchd:
- `launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist`
- `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

Linux with systemd:
- `systemctl --user start nanoclaw`
- `systemctl --user stop nanoclaw`
- `systemctl --user restart nanoclaw`

## Coding Style & Naming Conventions
Use TypeScript ESM and match the existing code style: 2-space indentation, semicolons, and single quotes. Prefer descriptive file names such as `container-runner.ts` and colocated test files named `feature-name.test.ts`. Prefix intentionally unused variables or parameters with `_` to satisfy lint rules. Keep behavior explicit and auditable. Clear, user-friendly errors are preferred over silent fallbacks; do not add fallback behavior without approval.

## Testing Guidelines
Vitest is the test runner. Add or update colocated `*.test.ts` files for behavior changes in `src/` and `setup/`. If you touch skills, run the dedicated skills test config too. For setup, auth, and skill flows, test end-to-end on a fresh clone when practical. If you change deployment-sensitive behavior, verify the change against the `shapiroserver2` deployment docs before considering it complete.

## Commit & Pull Request Guidelines
Recent history favors short imperative commits with prefixes like `feat:`, `fix:`, `docs:`, and `chore:`. Keep each PR focused on one change. In the PR description, explain what changed, why, how it works, and how it was tested. Include `Closes #123` when applicable.

Before opening a PR:
- Search for related issues and PRs.
- Confirm the change fits the project philosophy in `README.md`.
- Read `CONTRIBUTING.md`.
- Test the changed path thoroughly.

## Troubleshooting Notes
If WhatsApp stops working after an upgrade, verify the deployed ref still includes `src/channels/whatsapp.ts`, `src/whatsapp-auth.ts`, and an active `import './whatsapp.js'` in `src/channels/index.ts` before blaming host auth. Do not document or rely on missing helper scripts. For container image issues, note that buildkit caches the build context aggressively: `--no-cache` alone may not invalidate stale `COPY` steps, so a builder prune may be required before re-running `./container/build.sh`.

## Worktree & Collaboration Rules
Make changes in a dedicated worktree under `.worktrees/`, for example `git worktree add .worktrees/my-fix -b my-fix`. Commit to your worktree often. Do not overwrite or revert unrelated changes from other agents. If you encounter conflicting local edits, preserve them and coordinate rather than resetting them away.
