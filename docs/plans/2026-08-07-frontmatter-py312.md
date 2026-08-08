# Frontmatter Top-Level Scan Fix + Python 3.12 Agent Image Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Two production-blocking NanoClaw runtime fixes on `overlay/shapiroserver2`: (1) the SKILL.md frontmatter scan must only treat TOP-LEVEL keys as skill bin/helper declarations (nested informational keys like `metadata.openclaw.requires.bins` caused a fleet-wide spawn outage — kata 23ma); (2) the agent container image must provide `python3.12` on PATH alongside the untouched distro Python 3.11 (kata 68q9).

**Architecture:** Fix 1 is a one-regex change in the module-private `readYamlStringList()` in `src/yente/managed-skills.ts` — anchor the key match to column 0 of the frontmatter block — plus regression tests through the already-exported `readSkillRuntimeRequirements()` and the end-to-end `resolveManagedSkillRoot()`. We use indentation-aware scanning, NOT a YAML library: `package.json` declares no YAML dependency (`js-yaml` exists only as a transitive dev-dependency hoisted by npm; under the repo's canonical pnpm isolated `node_modules` it is not importable), and adding a dependency would trip the pnpm `minimumReleaseAge` supply-chain gate — the spec directs indentation-aware scanning in exactly this situation. Fix 2 adds a pinned `uv` static binary (via a distroless `ghcr.io/astral-sh/uv` stage) to `container/Dockerfile`, runs `uv python install 3.12` at build time into a world-readable `/opt/uv/python`, and symlinks `/usr/local/bin/python3.12` (which is on the agent runtime PATH, `AGENT_CONTAINER_PATH` in `src/container-runner.ts:134`). Validation is empirical: build the image with the same `container/build.sh` the production deploy invokes and verify as a passwd-less non-root uid.

**Tech Stack:** TypeScript (ESM, `NodeNext`, strict), vitest 4, Docker 29 (BuildKit, `# syntax=docker/dockerfile:1.7`), Debian bookworm base (`node:22-slim`), uv (Astral) for the managed CPython 3.12.

## Global Constraints

- **Worktree:** all work happens in `/home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312`, on the already-checked-out branch `fix/frontmatter-py312` (based on `overlay/shapiroserver2` @ `607de6c`). Always run git as `git -C /home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312 ...` or `cd` there first — never rely on cwd.
- **Branch policy (spec, verbatim):** "Work on a feature branch off overlay/shapiroserver2; when everything passes, merge to overlay/shapiroserver2 and push to origin (the danshapiro fork). NEVER push to upstream nanoclaw main." The only configured remote is `origin = https://github.com/danshapiro/nanoclaw.git`. Never add or push to any other remote.
- **Quality bar (spec, verbatim):** "`npm run typecheck`, `npm run build`, and the full `npm test` (vitest) suite must pass; new tests must fail against the unfixed code (verify red before green on Fix 1)." Baseline before this work: 96 test files / 1171 tests, all passing.
- **Commit discipline (spec):** exactly two clearly-scoped fix commits — commit 1 = scan fix + its tests; commit 2 = Dockerfile change (+ its guard test + build.sh smoke) — so either can be reverted independently. Conventional-commit subjects with scope (`fix(yente): ...`, `feat(container): ...`), matching `git log` style, with the Amplifier co-author trailer (exact text in Task 1 Step 7).
- **Fix 1 required behavior (spec):** only TOP-LEVEL frontmatter keys count as bin/helper declarations; nested occurrences at any depth are ignored; both block-list and inline `key: [a, b]` forms keep working for top-level keys; preserve behavior for every currently-valid top-level declaration.
- **Fix 2 required behavior (spec):** ADD a `python3.12` (or newer) interpreter on PATH; do NOT disturb the existing `python3` (3.11) / `python-is-python3` / `python3-jsonschema` (and `python3-pip`) arrangement. Pin the uv version. Interpreter must work for a non-root user with a world-readable/executable install dir. Keep image size growth reasonable.
- **Never touch:** deployment configuration, `source.conf`, or anything in the shapiroserver2 config repo (`/home/dan/code/shapiroserver2`) — that is the follow-up deploy task's job.
- **Never commit** the untracked `package-lock.json` at the worktree root (the repo is pnpm-canonical; `pnpm-lock.yaml` is the only tracked lockfile). Always `git add` explicit file paths; never `git add -A` / `git add .`.
- **No new package dependencies** (npm or pnpm) — no YAML library.
- The pre-commit hook (`.husky/pre-commit`) runs `pnpm run format:fix`. If `pnpm` is not on PATH, run `corepack enable` first (Node 22 ships corepack). Do not bypass the hook with `--no-verify` for code commits.
- `AGENTS.md` (repo root) rule: subagents report to their caller, not directly to the user. `README.md` is not touched.
- Report the final `overlay/shapiroserver2` SHA prominently at the end (the follow-up deploy task pins it).

**Out of scope (explicit spec boundary, not a deferral):** deploying to production and live fleet validation — "a separate follow-up task will deploy the result to production and validate live, so this task ends at 'merged to overlay/shapiroserver2, pushed, fully tested locally'."

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/yente/managed-skills.ts` | Modify (1 regex + comment, in `readYamlStringList`, ~line 383) | Frontmatter key scan becomes top-level-only |
| `src/yente/managed-skills.test.ts` | Modify (add 1 import, 1 new `describe` with 5 tests, 1 new e2e test, rewrite 4 nested fixture strings in 3 existing tests) | Regression coverage for kata 23ma + both parse forms |
| `container/Dockerfile` | Modify (add `ARG UV_VERSION` + uv stage before `FROM node:22-slim`; add Python 3.12 block after the yt-dlp block) | Bake uv-managed CPython 3.12 alongside distro 3.11 |
| `container/build.sh` | Modify (add a second in-image verification run) | Durable non-root python3.12 + unchanged python3 smoke on every build (deploy runs this script) |
| `src/container-runtime.test.ts` | Modify (add 1 guard test to the existing `describe('agent container Dockerfile')` block) | Pin the new Dockerfile lines so they can't silently regress |
| `docs/plans/2026-08-07-frontmatter-py312.md` | Create | This plan (working/agent doc) |

Scope check: the two fixes touch independent subsystems (TS runtime scan; container image). The spec deliberately lands them on one branch as two independently-revertible commits, so this single plan keeps them as separate tasks (each with its own test cycle and commit) plus a shared final quality/merge gate.

---

### Task 1: Top-level-only frontmatter scan (Fix 1: kata 23ma) — tests + fix, one commit

**Files:**
- Modify: `src/yente/managed-skills.ts` (line ~383, inside `readYamlStringList`, lines 380–403)
- Test: `src/yente/managed-skills.test.ts`

**Interfaces:**
- Consumes (existing exports of `./managed-skills.js`, unchanged signatures):
  - `readSkillRuntimeRequirements(skillDir: string): SkillRuntimeRequirements` where `SkillRuntimeRequirements = { skillLocalBins: string[]; runtimeBins: string[]; baseCommands: string[] }`
  - `resolveManagedSkillRoot(args: { projectRoot: string; dataDir: string; env?: NodeJS.ProcessEnv; root?: string; selection?: SkillSelection }): ManagedSkillRoot`
  - Test helpers already in the test file: `makeTempDir(): string`, `makeSkill(root: string, name: string): string`, `makeExecutable(filePath: string, body?: string): void`
- Produces: no API changes. Behavioral contract for Task 3: frontmatter keys `bins`, `skillLocalBins`, `skill_local_bins`, `runtimeBins`, `runtime_bins`, `baseCommands`, `base_commands` are declarations ONLY at column 0 of the frontmatter block; both block and inline list forms; nested occurrences at any depth ignored.

Background you need (verified against the current source): `readYamlStringList(frontmatter, key)` builds `` new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*(.*)$`) `` — the leading `\\s*` makes it match the key at ANY indentation, so the nested informational block that upstream skills carry (`metadata:` → `openclaw:` → `requires:` → `bins:`) is misread as a declaration. `readSkillRuntimeRequirements` routes `bins` entries through `RUNTIME_SHIM_BINS = new Set(['gws'])`: `gws` → `runtimeBins`, anything else → `skillLocalBins`. `synthesizeSkillBinLinks` (called from `resolveManagedSkillRoot`) then throws `Skill "<name>" declares helper "<bin>" but executable script is missing: <path>/scripts/<bin>` for any `skillLocalBins` entry without an executable `scripts/<bin>` — that throw is what killed every container spawn fleet-wide.

**Important:** three existing tests in `managed-skills.test.ts` declare requirements in the NESTED form (`metadata.openclaw.requires.*`) — they pin the buggy behavior and MUST be rewritten to the top-level form (Step 4). A repo-wide audit confirmed these are the only nested fixtures in any test file, and the only bundled skill declaring bins (`container/skills/local-skills/SKILL.md`) already uses the top-level form `bins: ["publish-local-skill"]`, so it keeps working unchanged.

- [ ] **Step 1: Write the failing regression tests**

In `src/yente/managed-skills.test.ts`:

1a. Add `readSkillRuntimeRequirements` to the import from `'./managed-skills.js'`. The import block (lines 7–16) becomes:

```ts
import {
  clearManagedSkillRootCache,
  cleanupStaleTempRoots,
  computeManagedSkillGeneration,
  createManagedSkillTempRoot,
  currentManagedSkillGeneration,
  managedSkillRootsFromEnv,
  readSkillRuntimeRequirements,
  resolveManagedSkillRoot,
  syncManagedSkillSymlinks,
} from './managed-skills.js';
```

1b. Inside the existing `describe('resolveManagedSkillRoot', ...)` block, immediately AFTER the test `it('validates writable local skill helper declarations on each merge', ...)` (it currently ends around line 250), add this end-to-end regression test (the user story: container spawn must not hard-fail on a skill with nested informational bins and no helper scripts):

```ts
  it('spawns cleanly when bins appear only nested under informational metadata (last30days regression)', () => {
    const projectRoot = makeTempDir();
    const dataDir = makeTempDir();
    const skillDir = makeSkill(path.join(projectRoot, 'container', 'skills'), 'last30days');
    // Modeled on upstream mvanhorn/last30days-skill frontmatter: the nested
    // metadata.openclaw.requires.bins list is informational for OpenClaw.
    // There is deliberately NO scripts/node or scripts/python3 — before the
    // fix, resolveManagedSkillRoot threw 'Skill "last30days" declares helper
    // "node" but executable script is missing' and every spawn failed
    // (shapiroserver2 kata 23ma, 2026-08-07 fleet outage).
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: last30days\ndescription: Research the last 30 days of a topic.\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - node\n        - python3\n---\n# last30days\n`,
    );

    const result = resolveManagedSkillRoot({ projectRoot, dataDir });

    expect(result.skills.find((entry) => entry.name === 'last30days')?.requirements).toEqual({
      skillLocalBins: [],
      runtimeBins: [],
      baseCommands: [],
    });
    expect(fs.existsSync(path.join(result.root, '.bin'))).toBe(false);
  });
```

1c. At the END of the file (after the last existing `describe` block, `'managed skill generation (content digest)'`), add a new describe block that unit-tests the parse through the exported `readSkillRuntimeRequirements`:

```ts
describe('readSkillRuntimeRequirements', () => {
  function writeSkillMd(contents: string): string {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'SKILL.md'), contents);
    return dir;
  }

  it('ignores bin keys nested under informational metadata at any depth', () => {
    // Real-world shape from upstream mvanhorn/last30days-skill (kata 23ma).
    const dir = writeSkillMd(
      `---\nname: last30days\ndescription: Research the last 30 days of a topic.\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - node\n        - python3\n---\n# last30days\n`,
    );

    expect(readSkillRuntimeRequirements(dir)).toEqual({
      skillLocalBins: [],
      runtimeBins: [],
      baseCommands: [],
    });
  });

  it('parses top-level bins in block and inline forms', () => {
    const block = writeSkillMd(`---\nname: t\nbins:\n  - helper-a\n  - gws\n---\n# t\n`);
    expect(readSkillRuntimeRequirements(block)).toEqual({
      skillLocalBins: ['helper-a'],
      runtimeBins: ['gws'],
      baseCommands: [],
    });

    const inline = writeSkillMd(`---\nname: t\nbins: ["helper-a", "gws"]\n---\n# t\n`);
    expect(readSkillRuntimeRequirements(inline)).toEqual({
      skillLocalBins: ['helper-a'],
      runtimeBins: ['gws'],
      baseCommands: [],
    });
  });

  it('parses top-level skillLocalBins and skill_local_bins in block and inline forms', () => {
    const block = writeSkillMd(
      `---\nname: t\nskillLocalBins:\n  - helper-a\nskill_local_bins:\n  - helper-b\n---\n# t\n`,
    );
    expect(readSkillRuntimeRequirements(block)).toEqual({
      skillLocalBins: ['helper-a', 'helper-b'],
      runtimeBins: [],
      baseCommands: [],
    });

    const inline = writeSkillMd(
      `---\nname: t\nskillLocalBins: ["helper-a"]\nskill_local_bins: ["helper-b"]\n---\n# t\n`,
    );
    expect(readSkillRuntimeRequirements(inline)).toEqual({
      skillLocalBins: ['helper-a', 'helper-b'],
      runtimeBins: [],
      baseCommands: [],
    });
  });

  it('parses top-level runtimeBins and baseCommands (and snake_case aliases) in block and inline forms', () => {
    const block = writeSkillMd(
      `---\nname: t\nruntimeBins:\n  - gws\nbaseCommands:\n  - bash\n  - node\n---\n# t\n`,
    );
    expect(readSkillRuntimeRequirements(block)).toEqual({
      skillLocalBins: [],
      runtimeBins: ['gws'],
      baseCommands: ['bash', 'node'],
    });

    const inline = writeSkillMd(
      `---\nname: t\nruntime_bins: ["gws"]\nbase_commands: ["bash", "node"]\n---\n# t\n`,
    );
    expect(readSkillRuntimeRequirements(inline)).toEqual({
      skillLocalBins: [],
      runtimeBins: ['gws'],
      baseCommands: ['bash', 'node'],
    });
  });

  it('does not double-count a nested key shadowing a top-level key of the same name', () => {
    const dir = writeSkillMd(
      `---\nname: t\nbins: ["jq-helper"]\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - node\n        - python3\n---\n# t\n`,
    );

    expect(readSkillRuntimeRequirements(dir)).toEqual({
      skillLocalBins: ['jq-helper'],
      runtimeBins: [],
      baseCommands: [],
    });
  });
});
```

(`makeTempDir()` registers the dir in the module-level `tempRoots` array, so the existing file-level `afterEach` cleans these up — no extra teardown needed.)

- [ ] **Step 2: Run the new tests to verify red against the unfixed code**

Run (from the worktree root):
```bash
cd /home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312
npx vitest run src/yente/managed-skills.test.ts
```
Expected: exactly **3 failures**, all demonstrating the bug — record this output as the red evidence:
- `spawns cleanly when bins appear only nested under informational metadata (last30days regression)` — FAILS with thrown `Skill "last30days" declares helper "node" but executable script is missing: ...`
- `ignores bin keys nested under informational metadata at any depth` — FAILS: received `skillLocalBins: ['node', 'python3']`, expected `[]`
- `does not double-count a nested key shadowing a top-level key of the same name` — FAILS: received `skillLocalBins: ['jq-helper', 'node', 'python3']`, expected `['jq-helper']`

The three "parses top-level ..." tests PASS against unfixed code (they pin behavior that must be preserved). All pre-existing tests still pass. If the failures differ from the above, stop and reconcile before proceeding.

- [ ] **Step 3: Implement the fix (one regex, anchored to column 0)**

In `src/yente/managed-skills.ts`, inside `readYamlStringList` (line ~383), replace:

```ts
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*(.*)$`);
```

with:

```ts
  // Only TOP-LEVEL frontmatter keys (column 0) count as bin/helper
  // declarations. Nested occurrences at any depth — e.g. the informational
  // metadata.openclaw.requires.bins block that upstream skills carry — must
  // be ignored: an indentation-agnostic match here turned into deterministic
  // fleet-wide spawn failures on 2026-08-07 (shapiroserver2 kata 23ma).
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*)$`);
```

Nothing else in the function changes: the inner block-item loop (`/^\s*-\s*["']?([^"',\]]+)["']?\s*$/`, blank-line tolerant, stops at the first other line) still collects the indented `- item` lines under a top-level key, and `parseInlineStringList` still handles the inline `key: [a, b]` form.

- [ ] **Step 4: Rewrite the 3 existing tests that used nested declarations (4 fixture strings)**

These tests pinned the buggy nested form; their intent (executable validation, gws shim routing, fail-closed unknown names) is preserved by moving the declarations to top level. In `src/yente/managed-skills.test.ts`, make exactly these four replacements:

4a. In `it('validates writable local skill helper declarations on each merge', ...)` (~line 232), replace the fixture string
```
`---\nname: local-tool\nmetadata:\n  openclaw:\n    requires:\n      bins: ["local-tool"]\n---\n# Local Tool\n`
```
with
```
`---\nname: local-tool\nbins: ["local-tool"]\n---\n# Local Tool\n`
```

4b. In `it('treats gws as a runtime shim and base commands outside .bin', ...)` (~line 258), replace
```
`---\nname: gws-like\nmetadata:\n  openclaw:\n    requires:\n      bins:\n        - gws\n      baseCommands: ["bash", "node"]\n---\n# GWS Like\n`
```
with
```
`---\nname: gws-like\nbins:\n  - gws\nbaseCommands: ["bash", "node"]\n---\n# GWS Like\n`
```

4c. In `it('fails closed for unknown runtime shims and base commands', ...)` (~line 277), replace
```
`---\nname: bad-runtime\nmetadata:\n  openclaw:\n    requires:\n      runtimeBins: ["not-a-shim"]\n---\n# Bad\n`
```
with
```
`---\nname: bad-runtime\nruntimeBins: ["not-a-shim"]\n---\n# Bad\n`
```

4d. Same test, second fixture (~line 286), replace
```
`---\nname: bad-runtime\nmetadata:\n  openclaw:\n    requires:\n      baseCommands: ["gcc"]\n---\n# Bad\n`
```
with
```
`---\nname: bad-runtime\nbaseCommands: ["gcc"]\n---\n# Bad\n`
```

Then confirm no nested declaration fixtures remain:
```bash
grep -n 'requires' src/yente/managed-skills.test.ts
```
Expected: the only matches are in the fixtures added in Step 1 (the two `last30days` fixtures and the shadow-test fixture) — i.e. every remaining `requires:` occurrence sits in a fixture whose test ASSERTS the nested keys are ignored.

- [ ] **Step 5: Run the test file to verify green**

Run: `npx vitest run src/yente/managed-skills.test.ts`
Expected: PASS — all tests in the file (previous count plus the 6 new tests), 0 failures.

- [ ] **Step 6: Run the full suite**

Run: `npm test` (allow up to 10 minutes)
Expected: PASS — 96+ files, 1177+ tests, 0 failures. Any failure elsewhere means an unaccounted consumer of the nested form — stop and investigate before committing.

- [ ] **Step 7: Commit (scan fix + tests together — spec-mandated scoping)**

```bash
cd /home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312
git add src/yente/managed-skills.ts src/yente/managed-skills.test.ts
git commit -m "$(cat <<'EOF'
fix(yente): only top-level frontmatter keys declare skill bins/helpers

readYamlStringList matched bin/helper keys at any indentation, so nested
informational blocks like metadata.openclaw.requires.bins in upstream
skills (real case: mvanhorn/last30days-skill declaring node/python3) were
misread as skill-local helper declarations. synthesizeSkillBinLinks then
hard-failed every container spawn with 'declares helper ... but executable
script is missing' - 4/4 deterministic spawn failures fleet-wide on
2026-08-07 and an emergency rollback (shapiroserver2 kata 23ma).

Keys now only count at column 0 of the frontmatter block; block-list and
inline forms keep working for every top-level key alias. Existing test
fixtures that declared requirements under metadata.openclaw.requires move
to the top-level form; new regression tests pin the last30days shape, both
parse forms for every key alias, and nested/top-level shadowing.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```
Expected: pre-commit hook runs `pnpm run format:fix` and the commit lands on `fix/frontmatter-py312`. If the hook reformatted files, re-stage the same two paths and amend (`git add <same paths> && git commit --amend --no-edit`). Verify with `git log -1 --stat`: exactly `src/yente/managed-skills.ts` and `src/yente/managed-skills.test.ts` changed; `package-lock.json` NOT included.

---

### Task 2: Python 3.12 in the agent container image (Fix 2: kata 68q9) — guard test + Dockerfile + empirical build validation, one commit

**Files:**
- Modify: `container/Dockerfile` (insert ARG + stage before `FROM node:22-slim`; insert a Python 3.12 block after the yt-dlp block, before the GWS shim block)
- Modify: `container/build.sh` (add a second in-image verification run after the existing yt-dlp verification)
- Test: `src/container-runtime.test.ts` (extend the existing `describe('agent container Dockerfile')` block)

**Interfaces:**
- Consumes: `container/build.sh` builds `<image-base>:<tag>` where `<image-base> = nanoclaw-agent-v2-<sha1(projectRoot)[:8]>` (derived by sourcing `setup/lib/install-slug.sh`) and `<tag>` is `$1` (default `latest`); the production deploy invokes exactly `bash container/build.sh '<git-sha>'`. Agent containers run with `--user <hostUid>:<hostGid>` (999:987 in production, NO `/etc/passwd` entry), `-e HOME=/home/node`, `--cap-drop=ALL`, and a runtime PATH override (`AGENT_CONTAINER_PATH`, `src/container-runner.ts:134`) that includes `/usr/local/bin` and `/usr/bin` — so the new interpreter MUST be reachable via `/usr/local/bin`.
- Produces: image with `/usr/local/bin/python3.12` → uv-managed CPython 3.12 under `/opt/uv/python` (world-readable/executable), `/usr/local/bin/uv` (pinned static binary), `ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python`; distro `python3`/`python`/`pip3`/`python3-jsonschema` untouched at 3.11. New Dockerfile ARG: `UV_VERSION`.

Mechanism decision (per spec's "strong candidate", taken on the merits): a pinned `uv` static binary + `uv python install 3.12` at image build time + symlink. Debian bookworm has no `python3.12` apt package and compiling CPython would bloat the build; uv's python-build-standalone CPython is ~100–150MB uncompressed (reasonable). The uv binary is copied from Astral's distroless image `ghcr.io/astral-sh/uv:<version>` — multi-arch-safe (manifest list) and pinned by version tag, matching this Dockerfile's ARG-pinning convention (`CLAUDE_CODE_VERSION`, `YT_DLP_VERSION`, ...). Note the repo's "pnpm global-install block" rule applies to *Node CLIs* only; uv is a system binary like yt-dlp/bun, which are installed by direct pinned download.

- [ ] **Step 1: Write the failing Dockerfile guard test**

In `src/container-runtime.test.ts`, inside the existing `describe('agent container Dockerfile', ...)` block, immediately after the test `it('includes the Python runtime needed by managed Python project repos', ...)` (lines 72–77), add:

```ts
  it('bakes a uv-managed python3.12 alongside the untouched distro python3', () => {
    const dockerfile = fs.readFileSync(path.join(process.cwd(), 'container', 'Dockerfile'), 'utf8');

    // Pinned uv provides a managed CPython 3.12 for skills needing PEP 701
    // (shapiroserver2 kata 68q9); the distro 3.11 stack must stay untouched.
    expect(dockerfile).toMatch(/^ARG UV_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toContain('uv python install 3.12');
    expect(dockerfile).toContain('ln -s "$(uv python find 3.12)" /usr/local/bin/python3.12');
    expect(dockerfile).toContain('UV_PYTHON_INSTALL_DIR=/opt/uv/python');
    expect(dockerfile).toContain('python-is-python3');
    expect(dockerfile).toContain('python3-jsonschema');
  });
```

- [ ] **Step 2: Run the guard test to verify it fails**

Run:
```bash
cd /home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312
npx vitest run src/container-runtime.test.ts -t 'bakes a uv-managed python3.12'
```
Expected: FAIL — `expected ... to match /^ARG UV_VERSION=...$/m` (the Dockerfile has no uv lines yet).

- [ ] **Step 3: Edit `container/Dockerfile`**

3a. Directly BEFORE the line `FROM node:22-slim` (line 13; keep the `# syntax=` line and header comments above it untouched), insert:

```dockerfile
# ---- uv (pinned) ---------------------------------------------------------
# Distroless helper stage providing the static `uv` binary used below to
# install a managed CPython 3.12. Pinned like every other tool in this image.
ARG UV_VERSION=0.5.11
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv-dist

```

(The `ARG` must sit before the first `FROM` to be usable in the `FROM` line. If pulling `ghcr.io/astral-sh/uv:0.5.11` fails at build time, verify tag availability with `docker manifest inspect ghcr.io/astral-sh/uv:0.5.11`; if the registry has retired it, bump `UV_VERSION` to the newest tag listed at https://github.com/astral-sh/uv/releases — any uv >= 0.5.11 works for `uv python install 3.12`.)

3b. AFTER the yt-dlp block (it ends with `test "$(yt-dlp --version)" = "$YT_DLP_VERSION"`) and BEFORE the `# ---- GWS policy proxy shim` comment, insert:

```dockerfile
# ---- Python 3.12 (uv-managed) --------------------------------------------
# Debian bookworm ships python3 = 3.11 only (no python3.12 apt package), but
# the last30days research skill's engine needs Python 3.12+ (PEP 701
# f-string grammar) - shapiroserver2 kata 68q9. Bake a uv-managed CPython
# 3.12 ALONGSIDE the distro stack: python3 / python-is-python3 /
# python3-jsonschema / python3-pip stay untouched at 3.11. Agent processes
# run as an arbitrary host uid with no /etc/passwd entry (999:987 in
# production), so the interpreter lives outside any home directory and is
# world-readable/executable.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
COPY --from=uv-dist /uv /usr/local/bin/uv
RUN UV_CACHE_DIR=/tmp/uv-cache uv python install 3.12 && \
    ln -s "$(uv python find 3.12)" /usr/local/bin/python3.12 && \
    chmod -R a+rX /opt/uv && \
    rm -rf /tmp/uv-cache && \
    python3.12 --version && \
    python3 --version 2>&1 | grep -F 'Python 3.11'
```

Notes for the implementer: `uv python find 3.12` resolves the freshly installed managed interpreter's absolute path (the system 3.11 cannot satisfy the `3.12` request), so the symlink is deterministic regardless of which 3.12.x patch uv installs; the trailing `python3.12 --version` and the `grep -F 'Python 3.11'` make the layer self-verifying — the build fails loudly if either interpreter is wrong. Do NOT touch the apt package list — guard tests pin its contents and one-package-per-line formatting.

- [ ] **Step 4: Extend `container/build.sh` with a non-root python verification**

In `container/build.sh`, AFTER the existing yt-dlp verification `${CONTAINER_RUNTIME} run ...` block (it ends with `grep -q "ERROR: Unsupported URL:" /tmp/yt-dlp-smoke.out'`) and BEFORE the `echo ""` / `echo "Build complete!"` lines, insert:

```bash
echo "Verifying python3.12 (uv-managed) alongside distro python3 as a non-root uid..."
# Mirror production agent spawns: an arbitrary host uid with no /etc/passwd
# entry (src/container-runner.ts pushes --user <uid>:<gid> + HOME=/home/node).
# shellcheck disable=SC2016 # The quoted script expands inside the container.
${CONTAINER_RUNTIME} run --rm \
    --network none \
    --user 12345:12345 \
    -e HOME=/home/node \
    --entrypoint sh \
    "${IMAGE_NAME}:${TAG}" \
    -c 'set -eu
python3.12 --version
python3.12 -c "import sys; print(sys.version)"
case "$(python3.12 --version 2>&1)" in "Python 3.12."*) ;; *) echo "unexpected python3.12 version" >&2; exit 1 ;; esac
case "$(python3 --version 2>&1)" in "Python 3.11."*) ;; *) echo "distro python3 is no longer 3.11" >&2; exit 1 ;; esac'
```

This makes the check durable: the production deploy runs `bash container/build.sh '<sha>'`, so every future release build re-proves non-root python3.12 access and the unchanged distro python3.

- [ ] **Step 5: Run the guard test to verify green**

Run: `npx vitest run src/container-runtime.test.ts`
Expected: PASS — the new test and ALL pre-existing Dockerfile guard tests (apt one-package-per-line, yt-dlp pin shape, GWS shim, ENV PATH string, etc.) pass.

- [ ] **Step 6: Build the image locally with the deploy-representative invocation**

Run (long: first local build downloads chromium, bun, pinned CLIs — allow 30+ minutes; requires network):
```bash
cd /home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312
bash container/build.sh py312-local
```
This is the same script the production deploy invokes (deploy runs it with the release SHA as the tag; `py312-local` is a representative local tag). Expected: build succeeds; the in-Dockerfile self-check prints `Python 3.12.x` then a `Python 3.11.2` grep match; the yt-dlp verification passes; the NEW python verification block prints `Python 3.12.x` and the full `sys.version` string and exits cleanly; final output `Build complete!` with `Image: nanoclaw-agent-v2-<slug>:py312-local`. Record the printed image name for Step 7.

- [ ] **Step 7: Empirical non-root verification mirroring production exactly (999:987) + size check**

```bash
cd /home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312
IMAGE_BASE="$(source setup/lib/install-slug.sh && container_image_base)"
docker run --rm --network none --user 999:987 -e HOME=/home/node \
  --entrypoint sh "${IMAGE_BASE}:py312-local" -c 'set -eu
id
python3.12 --version
python3.12 -c "import sys; print(sys.version)"
python3 --version
python --version
command -v python3.12'
docker run --rm --entrypoint sh "${IMAGE_BASE}:py312-local" -c 'du -sh /opt/uv /usr/local/bin/uv'
docker images "${IMAGE_BASE}"
```
Expected output (record it as validation evidence):
- `uid=999 gid=987` (no name — no passwd entry, exactly like production)
- `Python 3.12.<x>` (any patch >= 0)
- `3.12.<x> (...)` from `sys.version`
- `Python 3.11.2` for `python3` AND `python` (distro stack untouched, `python-is-python3` intact)
- `command -v python3.12` → `/usr/local/bin/python3.12`
- `/opt/uv` around 100–200M and `uv` around 30–50M — reasonable growth. If `/opt/uv` exceeds ~300M, investigate before committing (likely a leftover cache — the `rm -rf /tmp/uv-cache` must be in the same RUN layer).

If any of these fail, fix the Dockerfile (permissions → check `chmod -R a+rX /opt/uv`; PATH → the symlink must be exactly `/usr/local/bin/python3.12`) and repeat Steps 6–7. Compiling CPython from source is the fallback ONLY if the uv route proves unworkable.

- [ ] **Step 8: Commit (Dockerfile change, independently revertible)**

```bash
cd /home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312
git add container/Dockerfile container/build.sh src/container-runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(container): bake uv-managed python3.12 alongside distro python3

Debian bookworm has no python3.12 apt package and the last30days research
skill's engine needs Python 3.12+ (PEP 701 f-string grammar), currently
papered over with a downstream 3.11-compatibility patch we want to retire
(shapiroserver2 kata 68q9).

Copy a pinned uv static binary (ARG UV_VERSION) from its distroless image
and run `uv python install 3.12` at build time into /opt/uv/python
(world-readable/executable - agents run as arbitrary passwd-less non-root
uids), symlinked at /usr/local/bin/python3.12 which is already on the
agent runtime PATH. The distro python3 (3.11) / python-is-python3 /
python3-jsonschema / python3-pip stack is untouched. build.sh now
smoke-tests python3.12 and the unchanged python3 as a passwd-less
non-root uid on every build, and a Dockerfile guard test pins the new
lines. Verified locally: image builds; uid 999:987 runs python3.12
(3.12.x) and python3 still reports 3.11.2.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```
Verify with `git log -1 --stat`: exactly `container/Dockerfile`, `container/build.sh`, `src/container-runtime.test.ts`; no `package-lock.json`.

---

### Task 3: Full quality gates, merge to overlay/shapiroserver2, push, report SHA

**Files:**
- No file changes. Git operations + verification only.

**Interfaces:**
- Consumes: the two commits from Tasks 1–2 on `fix/frontmatter-py312`; the plan commit (already on the branch).
- Produces: `overlay/shapiroserver2` fast-forwarded to the branch head and pushed to `origin` (danshapiro fork); the final SHA reported prominently for the follow-up deploy task.

- [ ] **Step 1: Run the full quality bar in the worktree**

```bash
cd /home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312
npm run typecheck
npm run build
npm test
```
Expected: all three exit 0; `npm test` reports 0 failures across 96+ files / 1177+ tests (baseline 1171 + Task 1's 6 new tests + Task 2's 1 guard test). Any failure: stop, fix on the branch, re-run all three.

- [ ] **Step 2: Confirm working tree and branch state**

```bash
git -C /home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312 status --short
git -C /home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312 log --oneline overlay/shapiroserver2..fix/frontmatter-py312
```
Expected: status shows ONLY the untracked `package-lock.json` (leave it: untracked, never committed); the log shows exactly three commits — the plan commit (`docs: add implementation plan for frontmatter-py312`), the Fix 1 commit (`fix(yente): ...`), and the Fix 2 commit (`feat(container): ...`).

- [ ] **Step 3: Fast-forward merge into overlay/shapiroserver2**

The branch is a direct descendant of `overlay/shapiroserver2` (`607de6c`), so this is a fast-forward. `overlay/shapiroserver2` may be checked out in the parent clone, so locate it first:

```bash
git -C /home/dan/code/nanoclaw-frontmatter-py312/.worktrees/frontmatter-py312 worktree list
```
- If `overlay/shapiroserver2` is checked out in the parent clone (`/home/dan/code/nanoclaw-frontmatter-py312`), merge there:
  ```bash
  git -C /home/dan/code/nanoclaw-frontmatter-py312 merge --ff-only fix/frontmatter-py312
  ```
- If it is not checked out anywhere, check it out in the parent clone first, then run the same `--ff-only` merge:
  ```bash
  git -C /home/dan/code/nanoclaw-frontmatter-py312 checkout overlay/shapiroserver2
  git -C /home/dan/code/nanoclaw-frontmatter-py312 merge --ff-only fix/frontmatter-py312
  ```
Expected: `Fast-forward` (or `Already up to date` on a retry). If `--ff-only` refuses, `overlay/shapiroserver2` moved since `607de6c` — STOP and report; do not create a merge commit or rebase without review.

- [ ] **Step 4: Push to origin (the danshapiro fork) ONLY**

```bash
git -C /home/dan/code/nanoclaw-frontmatter-py312 remote -v
```
Expected: exactly one remote, `origin  https://github.com/danshapiro/nanoclaw.git` (fetch/push). If ANY other remote appears, stop — never push anywhere but this fork.

```bash
git -C /home/dan/code/nanoclaw-frontmatter-py312 push origin overlay/shapiroserver2
git -C /home/dan/code/nanoclaw-frontmatter-py312 push origin fix/frontmatter-py312
```
Expected: both pushes succeed (the feature-branch push preserves the working branch remotely for review/traceability).

- [ ] **Step 5: Verify and report the deploy pin SHA prominently**

```bash
git -C /home/dan/code/nanoclaw-frontmatter-py312 rev-parse overlay/shapiroserver2
git -C /home/dan/code/nanoclaw-frontmatter-py312 ls-remote origin refs/heads/overlay/shapiroserver2
```
Expected: both print the SAME sha (local and remote agree). Report in the final task summary, formatted prominently:

```
================= DEPLOY PIN =================
overlay/shapiroserver2 SHA: <full 40-char sha>
==============================================
```

Also restate for the follow-up deploy task: (a) do NOT touch the shapiroserver2 config repo / `source.conf` from this task; (b) per-agent-group derived images (`nanoclaw-agent-v2-*:ag-*`) are built `FROM` the base image and pick up python3.12 only when rebuilt against the new base — the deploy/validation task must account for that.

---

## Self-Review (performed at plan-writing time)

1. **Spec coverage:** Fix 1 required behavior (top-level-only; both forms preserved; last30days fixture; double-count case; extend existing test file) → Task 1 Steps 1–5. Red-before-green → Task 1 Step 2. Fix 2 (add 3.12 without disturbing 3.11 stack; pinned uv; non-root world-readable; size; empirical docker build via the deploy-representative `container/build.sh`; `python3.12 --version`, `sys.version`, `python3` still 3.11) → Task 2 Steps 3–7. Quality bar (`npm run typecheck` / `npm run build` / `npm test`) → Task 3 Step 1. Two separately-revertible commits → Task 1 Step 7 / Task 2 Step 8. Merge + push to fork only, never upstream; SHA reported prominently → Task 3 Steps 3–5. Commit conventions + Amplifier co-author → the two heredoc messages. No deploy-config changes → Global Constraints + Task 3 Step 5 note. No gaps found.
2. **No silent deferrals:** the only excluded work (production deploy + live validation) is the spec's explicit boundary for the follow-up task, not a scope reduction. Fix 1's user-facing outcome (spawns no longer hard-fail) is proven by a real end-to-end test through `resolveManagedSkillRoot` with no stubs/mocks (the suite uses real temp dirs and the real parser). Fix 2's outcome is proven empirically against the actually-built image as a passwd-less non-root uid — no mocks anywhere in this plan.
3. **Placeholder scan:** every code step contains complete code; every command has expected output; no TBD/TODO/"similar to" references.
4. **Type consistency:** all assertions use the `SkillRuntimeRequirements` shape `{ skillLocalBins, runtimeBins, baseCommands }` matching `readSkillRuntimeRequirements(skillDir: string)`; helper names (`makeTempDir`, `makeSkill`, `writeSkillMd`) are used consistently; Dockerfile strings asserted by the guard test exactly match the strings inserted in Task 2 Step 3 (`ARG UV_VERSION=0.5.11`, `uv python install 3.12`, `ln -s "$(uv python find 3.12)" /usr/local/bin/python3.12`, `UV_PYTHON_INSTALL_DIR=/opt/uv/python`).
