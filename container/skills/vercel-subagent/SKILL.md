---
name: vercel-subagent
description: Stateful Vercel frontend engineer workflow for building, visually verifying, and deploying websites or web apps through persistent Codex or OpenCode subprocess sessions.
---

# Vercel Subagent

You are the Vercel frontend engineer. Use this skill when a website or web app must be built, redesigned, visually verified, or deployed with Vercel.

This is a long-lived subprocess pattern, not a NanoClaw agent pattern. Do not create a NanoClaw companion agent for this work. Start or resume a Codex or OpenCode CLI session, persist its state under `/workspace/agent/.nanoclaw/vercel-subagents/`, and continue that same subprocess session until the build is complete.

## State Directory

Use one stable slug per project or user request:

```bash
STATE_ROOT=/workspace/agent/.nanoclaw/vercel-subagents
SESSION_DIR="$STATE_ROOT/<project-or-request-slug>"
mkdir -p "$SESSION_DIR"
```

Persist at least:

- `request.md` — the original build request and acceptance criteria
- `project-dir` — absolute path to the project being edited
- `codex-session-id` or `opencode-session-id` — the provider session id, once known
- `status.md` — latest state, live URL, screenshot paths, test results, and blockers
- `transcript.log` — copied CLI output needed to resume confidently

Use Codex first when available. Use OpenCode when the environment or task calls for it.

## Codex Sessions

First run:

```bash
PROJECT_DIR=$(cat "$SESSION_DIR/project-dir")
codex exec --cd "$PROJECT_DIR" "$(cat "$SESSION_DIR/request.md")" | tee -a "$SESSION_DIR/transcript.log"
```

After the first run, record the Codex session id in:

```bash
$SESSION_DIR/codex-session-id
```

Continuation:

```bash
PROJECT_DIR=$(cat "$SESSION_DIR/project-dir")
codex exec resume "$(cat "$SESSION_DIR/codex-session-id")" "$(cat "$SESSION_DIR/followup.md")" | tee -a "$SESSION_DIR/transcript.log"
```

## OpenCode Sessions

First run:

```bash
PROJECT_DIR=$(cat "$SESSION_DIR/project-dir")
opencode run --dir "$PROJECT_DIR" "$(cat "$SESSION_DIR/request.md")" | tee -a "$SESSION_DIR/transcript.log"
```

After the first run, record the OpenCode session id in:

```bash
$SESSION_DIR/opencode-session-id
```

Continuation:

```bash
PROJECT_DIR=$(cat "$SESSION_DIR/project-dir")
opencode run --session "$(cat "$SESSION_DIR/opencode-session-id")" --dir "$PROJECT_DIR" "$(cat "$SESSION_DIR/followup.md")" | tee -a "$SESSION_DIR/transcript.log"
```

## Build Workflow

Every frontend task follows this sequence. Do not skip steps.

### 1. Understand Before Coding

- For existing projects, read `package.json`, check existing patterns, components, and design tokens before changing anything.
- For new projects, choose the right tool: Next.js for full apps, Vite for SPAs, plain HTML/CSS for simple static pages.
- Search the codebase before creating a component. If an existing component does 80% of what is needed, extend it with props. If two components share the same pattern, extract a shared component.

### 2. Write Quality Code

TypeScript:

- Use TypeScript for app code.
- Avoid `any`; prefer `unknown` with type guards. Use `any` only for narrow third-party interop.
- Define explicit props and API response interfaces.

React and Next.js:

- Prefer Server Components in App Router projects.
- Keep `use client`, `useEffect`, and local state scoped to small leaf components.
- Never define components inside other components.
- Use `Suspense` with fallbacks for client components.
- Use dynamic imports for non-critical heavy components.
- Use `Promise.all()` for independent async operations.

Imports and bundle size:

- Prefer direct imports from source files over broad barrel imports when the project allows it.
- Use `optimizePackageImports` for icon/UI libraries when appropriate.
- Defer third-party scripts and lazy-load below-the-fold content.

HTML:

- Use semantic landmarks: `<header>`, `<nav>`, `<main>`, `<section>`, and `<footer>`.
- Give every image meaningful `alt` text, or empty `alt` for decorative images.
- Keep one `<h1>` per page and preserve heading order.
- Include `<title>` and `<meta name="description">` for every page.

CSS and styling:

- Build mobile-first responsive layouts.
- Use existing design tokens, Tailwind classes, or local design-system primitives when present.
- Keep spacing, loading states, error states, and empty states consistent.
- Use smooth 200-300ms transitions on interactive elements, favoring transform and opacity.
- Target WCAG AA text contrast.

### 3. Build Before Deploying

Run the project build and fix all errors:

```bash
pnpm run build 2>&1
```

Do not deploy a broken build. Do not disable TypeScript, ESLint, or checks to force a pass.

### 4. Visual Verification

Never report completion until the result has been visually verified in a real browser. Screenshots are proof.

Start the dev server:

```bash
pnpm run dev &
DEV_PID=$!
sleep 3
```

Then use `agent-browser` or an equivalent browser automation tool:

```bash
agent-browser open http://localhost:3000
agent-browser screenshot "$SESSION_DIR/desktop.png"
agent-browser eval "window.resizeTo(768, 1024)"
agent-browser screenshot "$SESSION_DIR/tablet.png"
```

Always verify:

- The page loads without runtime errors.
- The browser console has no relevant errors.
- There are no horizontal scrollbars or layout overflow.
- Text is readable and not clipped or overlapping.
- Images load as intended.

When relevant, verify:

- Links and navigation.
- Tablet and mobile layouts.
- Hover and focus states.
- Form submission and validation.
- Deployed production URL parity with local.

### 5. Deploy

Only deploy after build and visual checks pass:

```bash
vercel deploy --yes --prod --token placeholder --cwd "$PROJECT_DIR"
```

After deploying, inspect the deployment and visually verify the live URL:

```bash
vercel inspect <deployment-url> --token placeholder
agent-browser open <deployment-url>
agent-browser screenshot "$SESSION_DIR/production.png"
```

## Iteration Protocol

If something does not look right:

1. Identify the specific issue from the screenshot or browser output.
2. Fix the code.
3. Rebuild and re-test.
4. Take a new screenshot.
5. Repeat until the result is polished.

If the same issue remains after three serious iterations, record it in `status.md` with the exact blocker and next step.

## Reporting

When reporting results, include:

- What was built.
- The live URL, if deployed.
- Build and verification commands run.
- Screenshot paths for local and production verification.
- Known limitations or follow-up needed.
