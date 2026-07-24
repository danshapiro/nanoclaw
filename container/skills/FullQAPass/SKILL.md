---
name: FullQAPass
description: Only use this skill if requested by name.
---

# FullQAPass

Run a full NanoClaw runtime validation and emit a machine-readable result.

## Output Contract

Return exactly one line per completed check:

```text
CHECK <name> PASS <details>
CHECK <name> FAIL <details>
SUMMARY PASS
SUMMARY FAIL
```

Do not emit bullets, prose, or markdown outside those lines.

## Required Checks

Always emit these checks in this order:

1. `skill_named_invocation`
2. `allowed_tool_surface`
3. `local_skills_repo_visible`
4. `local_skills_repo_writable`
5. `local_skills_repo_git_ok`
6. `settings_json_valid`
7. `tool_bash_roundtrip`
8. `tool_read_write_edit`
9. `tool_glob_grep`
10. `tool_todowrite`
11. `tool_notebookedit`
12. `tool_websearch_https`
13. `tool_webfetch_https`
14. `tool_toolsearch`
15. `tool_skill_nested`
16. `orchestration_roundtrip`
17. `managed_skills_visible`
18. `nanoclaw_mcp_roundtrip`
19. `gws_auth_personal` when `gws` is present in `PATH`
20. `gws_auth_glowforge` when `gws` is present in `PATH`

If any check fails, continue running the remaining checks, then end with `SUMMARY FAIL`.

Provider note: NanoClaw can run under the Claude Code SDK, Codex, or OpenCode
provider. Validate each provider through its native tools. Do not fail a Codex
check merely because a Claude tool alias is absent when the corresponding
Codex capability is present and its probe succeeds. The OpenCode provider also
intentionally exposes a smaller tool surface. In OpenCode sessions, do not fail
checks solely because these Claude-only tools are absent: `WebSearch`,
`ToolSearch`, `NotebookEdit`, `TaskOutput`, `TaskStop`, `TeamCreate`, and
`TeamDelete`.

## Scratch Paths

- Use `/workspace/agent/full-qa-pass/` for temporary files.
- Use `/workspace/local-skills/.qa/` for the writable git probe.
- Clean both paths before finishing, even after failures.

## Procedure

### 1. Named Invocation

Confirm you are running because the user requested `FullQAPass` by name.

### 2. Allowed Tool Surface

Determine the provider profile from visible environment/config clues:

- Codex when `AGENT_PROVIDER=codex`, Codex model/config variables are present,
  or provider-native tools such as `exec_command`, `apply_patch`,
  `update_plan`, and `spawn_agent` identify the Codex surface.
- OpenCode when `AGENT_PROVIDER=opencode`, `OPENCODE_PROVIDER` is set, or the
  available tool list lacks the Claude-only orchestration/tool-discovery
  families while OpenCode model variables are present.
- Claude otherwise when the Claude tool families below are present.

For the Claude profile, assert that the current environment includes these tool
families:

- `Bash`
- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`
- `WebSearch`
- `WebFetch`
- `Task`
- `TaskOutput`
- `TaskStop`
- `TeamCreate`
- `TeamDelete`
- `SendMessage`
- `TodoWrite`
- `ToolSearch`
- `Skill`
- `NotebookEdit`
- `mcp__nanoclaw__*`

For the OpenCode profile, assert that the current environment includes these
tool families:

- `Bash`
- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`
- `WebFetch`
- `Task`
- `SendMessage`
- `TodoWrite`
- `Skill`
- `mcp__nanoclaw__*`

For the Codex profile, require these capabilities through provider-native
tools; exact Claude aliases are neither required nor expected:

- command execution and file reading;
- patch-based file creation, editing, and deletion;
- file discovery and content search;
- plan/todo state updates;
- HTTPS search and fetch;
- deferred tool discovery;
- skill discovery and nested skill use;
- bounded subagent orchestration;
- `mcp__nanoclaw__*`.

If a provider-required family is missing, mark this check failed. If only
Claude-only families are absent in the OpenCode profile, emit
`CHECK allowed_tool_surface PASS opencode profile; Claude-only tools absent as expected`.
For Codex, emit `CHECK allowed_tool_surface PASS codex native capability
surface available` only after the required Codex capabilities are present; the
provider-specific probes below must still run and may independently fail.

### 3. Local Skills Repo Checks

- `local_skills_repo_visible`: verify `/workspace/local-skills` exists.
- `local_skills_repo_writable`: create and remove a temporary file under `/workspace/local-skills/.qa/`.
- `local_skills_repo_git_ok`: verify `/workspace/local-skills` is a git working tree and ends clean after the probe.

### 4. Settings Validation

Validate `/home/node/.claude/settings.json`:

- the file exists;
- it contains valid JSON;
- `env` is an object when present.

### 5. Tool Probes

- `tool_bash_roundtrip`: use `Bash` under Claude/OpenCode or `exec_command`
  under Codex to create, read, and delete a scratch file.
- `tool_read_write_edit`: under Claude/OpenCode use `Write`, `Read`, and `Edit`
  on a file under `/workspace/agent/full-qa-pass/`. Under Codex use
  `apply_patch` to create and then edit the file, use `exec_command` to read and
  verify it, and use `apply_patch` to delete it.
- `tool_glob_grep`: under Claude/OpenCode use `Glob` and `Grep` against the
  scratch directory. Under Codex use `rg --files` and `rg` through
  `exec_command`. Confirm both discovery and content search find the expected
  file.
- `tool_todowrite`: under Claude/OpenCode create at least one todo item and
  mark it completed. Under Codex use `update_plan` to create an in-progress
  item and then mark it completed.
- `tool_notebookedit`: in the Claude profile, create or update a notebook entry
  tied to this run. In the Codex profile, use `apply_patch` to create and
  update a minimal `.ipynb` under the scratch path, then parse it and confirm
  the updated cell content before deleting it. In the OpenCode profile, emit
  PASS noting NotebookEdit is Claude-only and not expected.
- `tool_websearch_https`: in the Claude or Codex profile, perform an HTTPS web
  search and confirm the result URLs are HTTPS. In the OpenCode profile, emit
  PASS noting WebSearch is Claude-only and covered by the WebFetch HTTPS check.
- `tool_webfetch_https`: fetch an HTTPS URL with the provider-native web tool
  and confirm content was returned.
- `tool_toolsearch`: in the Claude profile, use `ToolSearch`; in the Codex
  profile, use `tool_search`. Confirm it returns at least one result relevant
  to this environment. In the OpenCode profile, emit PASS noting ToolSearch is
  Claude-only and not expected.
- `tool_skill_nested`: invoke the built-in `status` skill by name and confirm it returns a result.

### 6. Orchestration Roundtrip

In the Claude profile, exercise the orchestration tool family end-to-end in a
bounded way:

- create a temporary team named `fullqapass-probe-<unique-suffix>`, where the suffix is derived from the current run timestamp or random alphanumeric text;
- if `TeamCreate` reports a name collision, retry once with a different unique suffix;
- do not use `Agent` or create a long-lived teammate for this check;
- use `Task` to start a short-lived probe that returns exactly `PROBE_OK`;
- use `TaskOutput` to confirm the task result contains `PROBE_OK`;
- if the task is still running after you capture its output, use `TaskStop` to stop it;
- delete the temporary team with `TeamDelete`;
- keep the temporary team memberless so `TeamDelete` can succeed immediately.
- do not use Bash to remove `/home/node/.claude/teams/...`; team state is managed by orchestration tools and may be blocked as a sensitive path.

Mark `orchestration_roundtrip` failed if any step fails.

In the Codex profile, use the provider's bounded subagent tools to spawn one
temporary subagent whose entire task is to return exactly `PROBE_OK`. Wait for
the subagent to finish and verify its result contains exactly `PROBE_OK`.
Close the subagent if the provider leaves completed agents open. Mark
`orchestration_roundtrip` failed if the subagent cannot be created, does not
finish within the tool's normal bounded wait, or returns anything else.

In the OpenCode profile, emit `CHECK orchestration_roundtrip PASS opencode profile; Claude team tools are not expected` after confirming `Task` is available and `nanoclaw_mcp_roundtrip` will exercise durable scheduling.

### 7. Managed Skills Visibility

Confirm `/home/node/.claude/skills/` contains both built-in container skills and managed synced skills when present.
At minimum, verify `status` and `FullQAPass` are visible there.

### 8. NanoClaw MCP Roundtrip

Create a uniquely named temporary scheduled task with `mcp__nanoclaw__schedule_task`.
Use a far-future `processAfter` timestamp and rely on the current session routing; do not provide any target override.
Because task snapshots are written asynchronously, retry `mcp__nanoclaw__list_tasks` up to 5 times with short delays between attempts until the task ID appears.
Use `Bash` for the short delays when needed.
Then remove the task with `mcp__nanoclaw__cancel_task`.
Fail this check only if the schedule request fails, the task ID never appears before the retry budget is exhausted, or cleanup fails.

### 9. Optional GWS Check

If `gws` is present in `PATH`, run both account-specific checks in order:

1. Run `gws --account personal auth status`. Require the response to identify
   the canonical account as `dan@danshapiro.com`. Emit
   `CHECK gws_auth_personal PASS <details>` only when that exact identity is
   valid; otherwise emit `CHECK gws_auth_personal FAIL <details>`.
2. Run `gws --account glowforge auth status`. Require the response to identify
   the canonical account as `dan@glowforge.com`. Emit
   `CHECK gws_auth_glowforge PASS <details>` only when that exact identity is
   valid; otherwise emit `CHECK gws_auth_glowforge FAIL <details>`.

A missing, invalid, or mismatched account is a failed check. Never collapse
these checks into a generic one-row result. If `gws` is not present, omit both
checks entirely.

## Cleanup

Before returning:

- remove `/workspace/agent/full-qa-pass/` contents created by this run;
- remove `/workspace/local-skills/.qa/` contents created by this run;
- ensure `/workspace/local-skills` is not left dirty by the probe.

## Final Line

Emit `SUMMARY PASS` only when every required emitted check passed. Otherwise emit `SUMMARY FAIL`.
