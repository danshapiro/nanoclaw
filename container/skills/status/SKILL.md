---
name: status
description: Quick read-only health check for session context, workspace mounts, tool availability, and task snapshot.
---

# Status

Generate a concise, read-only status report for the current agent environment.

## Checks

Gather the following information without changing state:

1. Timestamp, working directory, and channel context.
2. Visible workspace mounts under `/workspace`, including `/workspace/agent`, `/workspace/repos`, `/workspace/portable-skills`, `/workspace/ipc`, and `/workspace/extra` when present.
3. Tool families available in the current environment.
4. Container utility versions when available.
5. Scheduled task snapshot through `mcp__nanoclaw__list_tasks`.

Use shell commands only for read-only inspection.

## Report Format

Return a compact human-readable report with these sections:

```text
NanoClaw Status

Session:
- Channel: main
- Time: <timestamp>
- Working dir: <path>

Workspace:
- Agent folder: <summary>
- Managed repos: <summary>
- Portable authoring: <summary>
- Extra mounts: <summary>
- IPC: <summary>

Tools:
- Core: <summary>
- Web: <summary>
- Orchestration: <summary>
- MCP: <summary>

Container:
- agent-browser: <available|not installed>
- Node: <version or unavailable>
- Agent CLI: <version or unavailable>

Scheduled Tasks:
- <task summary>
```

Keep it concise. This is a quick health check, not a deep diagnostic.
