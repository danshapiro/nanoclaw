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
3. `portable_repo_visible`
4. `portable_repo_writable`
5. `portable_repo_git_ok`
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
19. `gws_auth_status` when `gws` is present in `PATH`

If any check fails, continue running the remaining checks, then end with `SUMMARY FAIL`.

## Scratch Paths

- Use `/workspace/agent/full-qa-pass/` for temporary files.
- Use `/workspace/portable-skills/.qa/` for the writable git probe.
- Clean both paths before finishing, even after failures.

## Procedure

### 1. Named Invocation

Confirm you are running because the user requested `FullQAPass` by name.

### 2. Allowed Tool Surface

Assert that the current environment includes these tool families:

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

If any required family is missing, mark this check failed.

### 3. Portable Repo Checks

- `portable_repo_visible`: verify `/workspace/portable-skills` exists.
- `portable_repo_writable`: create and remove a temporary file under `/workspace/portable-skills/.qa/`.
- `portable_repo_git_ok`: verify `/workspace/portable-skills` is a git working tree and ends clean after the probe.

### 4. Settings Validation

Validate `/home/node/.claude/settings.json`:

- the file exists;
- it contains valid JSON;
- `env` is an object when present.

### 5. Tool Probes

- `tool_bash_roundtrip`: use Bash to create, read, and delete a scratch file.
- `tool_read_write_edit`: use `Write`, `Read`, and `Edit` on a file under `/workspace/agent/full-qa-pass/`.
- `tool_glob_grep`: use `Glob` and `Grep` against the scratch directory and confirm the created file is found.
- `tool_todowrite`: create at least one todo item and mark it completed.
- `tool_notebookedit`: create or update a notebook entry tied to this run.
- `tool_websearch_https`: perform an HTTPS web search and confirm the result URLs are HTTPS.
- `tool_webfetch_https`: fetch an HTTPS URL and confirm content was returned.
- `tool_toolsearch`: use `ToolSearch` and confirm it returns at least one result relevant to this environment.
- `tool_skill_nested`: invoke the built-in `status` skill by name and confirm it returns a result.

### 6. Orchestration Roundtrip

Exercise the orchestration tool family end-to-end in a bounded way:

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

If `gws` is present in `PATH`, run a lightweight auth/status check and emit `gws_auth_status`.
If `gws` is not present, omit this check entirely.

## Cleanup

Before returning:

- remove `/workspace/agent/full-qa-pass/` contents created by this run;
- remove `/workspace/portable-skills/.qa/` contents created by this run;
- ensure `/workspace/portable-skills` is not left dirty by the probe.

## Final Line

Emit `SUMMARY PASS` only when every required emitted check passed. Otherwise emit `SUMMARY FAIL`.
