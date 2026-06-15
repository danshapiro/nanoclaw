---
name: vercel-cli
description: Deploy apps to Vercel. Use when asked to deploy, ship, or publish a web application, or manage Vercel projects, domains, and environment variables.
---

# Vercel CLI

You can deploy web applications to Vercel using the `vercel` CLI.

**HARD RULE: You MUST NOT write HTML, CSS, or JavaScript yourself. When asked to build a website or web app, you MUST use the `vercel-subagent` skill (see "Building Websites" section below). That skill owns the frontend build, visual QA, and deploy loop through a persisted Codex or OpenCode subprocess session.**

## Auth

Auth is handled by OneCLI — the HTTPS_PROXY injects the real token into API requests automatically. The Vercel CLI requires a token to be present to skip its local credential check, so **always pass `--token placeholder`** on every command. OneCLI replaces this with the real token at the proxy level.

Before any Vercel operation, verify auth:

```bash
vercel whoami --token placeholder
```

If this fails with an auth error, ask the user to add a Vercel token to OneCLI. They can create one at https://vercel.com/account/tokens and register it via `onecli secrets create` on the host. Once added, retry `vercel whoami`.

## Deploying

Always use `--yes` to skip interactive prompts and `--token placeholder` for auth (OneCLI replaces with real token).

```bash
# Deploy to production
vercel deploy --yes --prod --token placeholder

# Deploy from a specific directory
vercel deploy --yes --prod --token placeholder --cwd /path/to/project

# Preview deployment (not production)
vercel deploy --yes --token placeholder
```

After deploying, verify the live URL:

```bash
# Check deployment status
vercel inspect <deployment-url> --token placeholder
```

If you have `agent-browser` available, open the deployed URL and take a screenshot to visually verify.

## Project Management

```bash
# Link to an existing Vercel project (non-interactive)
vercel link --yes --token placeholder

# List recent deployments
vercel ls --token placeholder

# List all projects
vercel project ls --token placeholder
```

## Domains

```bash
# List domains
vercel domains ls --token placeholder

# Add a domain to the current project
vercel domains add example.com --token placeholder
```

## Environment Variables

```bash
# Pull env vars from Vercel to local .env
vercel env pull --token placeholder

# Add an env var (use echo to pipe the value — avoids interactive prompt)
echo "value" | vercel env add VAR_NAME production --token placeholder
```

## Common Errors

| Error | Fix |
|-------|-----|
| `Error: No framework detected` | Ensure the project has a `package.json` with a `build` script, or set the framework in `vercel.json` |
| `Error: Rate limited` | Wait and retry. Don't loop — report to user |
| `Error: You have reached your project limit` | User needs to upgrade Vercel plan or delete unused projects |
| `ENOTFOUND api.vercel.com` | Network issue. Check proxy connectivity |
| Auth error after `vercel whoami` | Credential may be expired. Ask the user to refresh the Vercel token in OneCLI |

## Building Websites — Use the Vercel Subagent Skill

When asked to **build, create, or redesign** a website or web app, do not build it inline. Use the `vercel-subagent` skill. It runs a stateful Codex or OpenCode subprocess session, keeps its continuation state under `/workspace/agent/.nanoclaw/vercel-subagents/`, performs local build and visual verification, deploys through Vercel when requested, and records the live URL plus screenshots.

**When to delegate vs do it yourself:**
- **Use `vercel-subagent`**: building new sites, redesigns, multi-page apps, anything that needs visual testing
- **Do yourself**: simple `vercel deploy` of an existing project, checking deployment status, managing domains/env vars

## Best Practices

- Run `pnpm run build` locally before deploying to catch build errors early
- Use `--cwd` instead of `cd` to keep your working directory stable
- For Next.js projects, `vercel deploy` auto-detects the framework — no extra config needed
- Use `vercel.json` only when you need custom build settings, rewrites, or headers
