## Managed Project Repos

Every agent group has managed project repos at `/workspace/repos/<repo-id>`.
Status is recorded at `/workspace/repos/.managed/status.json`.
The `local-skills` repo is a managed repo exception: it is mounted at `/workspace/local-skills`, not `/workspace/repos/local-skills`.

When you need the host to refresh managed repo checkouts or reapply committed prompt/config state inside `/workspace/repos/yente-context`, call:

```js
mcp__nanoclaw__apply_managed_repos({})
```

When a managed repo has committed local changes that should be published, call:

```js
mcp__nanoclaw__push_managed_repo({ repoId: "yente-context" })
```

Use repo id `local-skills` when publishing committed changes from `/workspace/local-skills`:

```js
mcp__nanoclaw__push_managed_repo({ repoId: "local-skills" })
```

Do not edit or recreate an embedded managed-repos manifest in the local-skills checkout. The managed repos manifest is host-owned outside the container.

Do not expect repository credentials inside the container. The host runs reconcile and push commands with its managed credentials and sends you a system message when the command completes.
