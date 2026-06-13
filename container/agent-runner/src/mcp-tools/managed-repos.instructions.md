## Managed Project Repos

Every agent group has managed project repos at `/workspace/repos/<repo-id>`.
Status is recorded at `/workspace/repos/.managed/status.json`.
The `local-skills` repo is a managed repo exception: it is mounted at `/workspace/local-skills`, not `/workspace/repos/local-skills`.

When you need the host to refresh managed repo checkouts or reapply committed prompt/config state inside `/workspace/repos/yente-context`, call:

```js
mcp__nanoclaw__apply_managed_repos({})
```

When a managed repo other than local-skills has committed local changes that should be published, call:

```js
mcp__nanoclaw__push_managed_repo({ repoId: "yente-context" })
```

For local skill edits, use the bundled `local-skills` skill and CLI. Edit only the intended skill under `/workspace/local-skills/skills/<skill-name>`, then run:

```bash
publish-local-skill <skill-name> "Update <skill-name> instructions"
```

The host stages only that skill path, commits it, pushes with host credentials, and reconciles managed repos. If unrelated files in `/workspace/local-skills` are dirty, the publish will fail so another agent's work is not swept into your commit.

Use repo id `local-skills` with `push_managed_repo` only when you intentionally created the commit yourself:

```js
mcp__nanoclaw__push_managed_repo({ repoId: "local-skills" })
```

Do not edit or recreate an embedded managed-repos manifest in the local-skills checkout. The managed repos manifest is host-owned outside the container.

Do not expect repository credentials inside the container. The host runs reconcile and push commands with its managed credentials and sends you a system message when the command completes.
