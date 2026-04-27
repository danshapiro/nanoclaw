## Managed Project Repos

The main agent has managed project repos at `/workspace/repos/<repo-id>`.
Status is recorded at `/workspace/repos/.managed/status.json`.

When you change `/workspace/portable-skills/repos/manifest.json` or committed prompt/config state inside `/workspace/repos/yente-context`, call:

```js
mcp__nanoclaw__apply_managed_repos({})
```

When a managed repo has committed local changes that should be published, call:

```js
mcp__nanoclaw__push_managed_repo({ repoId: "yente-context" })
```

Do not expect repository credentials inside the container. The host runs reconcile and push commands with its managed credentials and sends you a system message when the command completes.
