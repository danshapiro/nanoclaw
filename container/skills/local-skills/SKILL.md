---
name: local-skills
description: Publish edits to NanoClaw local skills. Use after changing a skill under /workspace/local-skills/skills/<skill-name>.
bins: ["publish-local-skill"]
---

# Local Skills

Use this skill when publishing edits to NanoClaw local skill source.

## Workflow

1. Edit only the intended skill under `/workspace/local-skills/skills/<skill-name>/`.
2. Check `git -C /workspace/local-skills status --short --untracked-files=all`.
3. Publish exactly one skill:

```bash
publish-local-skill <skill-name> "Update <skill-name> instructions"
```

The helper sends a host request through `/workspace/ipc`, waits for the result, and prints the host output. The host stages only `skills/<skill-name>/`, commits with the supplied message, pushes with managed credentials, and reconciles managed repos.

If the publish fails because unrelated files are dirty, stop and report the conflicting paths instead of committing around them.

Do not edit `/app/skills`; it is the installed read-only skill view.
