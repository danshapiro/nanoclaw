# Yente CDATA Outbound Leak Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix the formatting defect from the 2026-09-27 Yente incident (kata rdj6) in the NanoClaw agent-runner on the deployed overlay branch:
1. Outbound deliveries must never contain literal CDATA markers: `<message to>` block bodies that the model wraps in `<![CDATA[...]]>` (including the `]]]]><![CDATA[>` split form) must be unwrapped before delivery, in both the final-message dispatch path and the MCP send_message/send_file text paths.
2. `prepareCodexInputText` must stop rewrapping the unwrapped-output nudge's literal example pair into a CDATA-teaching form — runtime-injected prompts must not be mangled — while inbound formatted chat envelopes keep their exact-text CDATA restoration.
3. Regression tests: nudge text reaching the provider keeps the plain example; a CDATA-wrapped final reply delivers clean text; MCP send_message/send_file with CDATA-wrapped text delivers clean text.

### Explicit constraints
- Work only in the dedicated the-usual worktree branched from overlay/shapiroserver2 (the deployed overlay tip fa4b8afc); never upstream main; no production deploys, no live-host mutation, no merge/push as part of the run.
- TypeScript; red/green/refactor TDD (bun test); the existing suite must stay green at the full-suite gate excluding the four ledger-recorded pre-existing full-suite flakes.
- Inbound envelope fidelity is load-bearing: the CDATA restore for real user messages (entity decoding + `]]>` splitting) must keep working exactly — its tests pin it.
- The CDATA leak is the defect: do not change the destination-addressing contract (`<message to="name">` blocks) or any other routing behavior.

### Accepted tradeoffs and residuals
- Existing conversation history in affected threads still contains CDATA-wrapped replies; the tolerant outbound unwrap is the guarantee that delivery is clean regardless.
- The nanoclaw GWS proxy fixes were a separate the-usual run (completed on branch the-usual/gws-upload-cwd in gws-skill).

**Goal:** Yente's delivered messages never show literal `<![CDATA[...]]>` markers, and the runtime never teaches the model the CDATA wrapper format it was never supposed to use.

**Architecture:** Two halves of one envelope contract. Inbound: `prepareCodexInputText` (providers/codex.ts) restores exact chat text by rewrapping formatted inbound `<message ...sender="...">` envelope bodies in CDATA — keep that, but scope its regex so only real formatted envelopes (which always carry `sender="`) are rewritten; the unwrapped-output nudge's `<message to="name">` example pair is then never mangled into teaching the format. Outbound (the safety net): a whole-body-only `stripCdataWrapper` helper in formatter.ts is applied wherever model-authored text is delivered — the final-message dispatch body, the nudge-ignored fallback, and the MCP send_message/send_file text — collapsing the `]]]]><![CDATA[>` split form back to `]]>` inside the unwrapped body.

**Tech Stack:** TypeScript on bun (bun test, tsc --noEmit), agent-runner package at container/agent-runner.

## Global Constraints

- All `bun`/`tsc` test commands run from `container/agent-runner/`; all `git` commands run from the worktree root, using repository-root-relative paths (`container/agent-runner/src/...`). Run `export PATH="$HOME/.bun/bin:$PATH"` once per shell (bun 1.4.2 is not on the default PATH); every `bun` command in this plan carries that PATH prefix — never chain an unprefixed `bun` after a `&&`.
- The two `prepareCodexInputText` tests at src/providers/codex.factory.test.ts:91-112 pin the inbound restore exactly — they must stay green unchanged.
- Whole-body-only strip: text that merely CONTAINS CDATA mid-body (e.g. a code sample quoting CDATA syntax) must pass through unchanged.
- Do not touch the `MESSAGE_RE` destination contract, routing, recovery, or any provider other than codex's input preparation.
- Full-suite gate: `bun test` at final HEAD green excluding the four ledger-recorded pre-existing full-suite flakes (Task 6 Dvora replay ×2, poll-loop unbacked parking ×2 — all pass focused; receipts in the baseline ledger), plus `bun run typecheck` green.
- Focused test command pattern: `bun test src/<file>.test.ts` and `bun test -t "<name fragment>"`.

---

### Task 1: `stripCdataWrapper` helper + clean final-message dispatch

**Files:**
- Create: nothing (helper goes in an existing file)
- Modify: `src/formatter.ts` (add `stripCdataWrapper` after `stripInternalTags`, ~line 291-322 region)
- Modify: `src/formatter.test.ts` (unit tests for the helper)
- Modify: `src/poll-loop.ts` (dispatchResultText body strip at ~line 2169; writeRoutedMessage strip at ~line 193)
- Test: `src/poll-loop.test.ts` (new dispatch test after the single-quote test at ~line 1136)

**Interfaces:**
- Consumes: `dispatchResultText`'s `const body = match[3].trim();` (poll-loop.ts:2169), `writeRoutedMessage`'s `const sanitized = sanitizeDeliveredText(text, ...)` (poll-loop.ts:193).
- Produces: `export function stripCdataWrapper(text: string): string` in src/formatter.ts — returns `text` unchanged when it has no `<![CDATA[`; otherwise, if the trimmed text is exactly one `<![CDATA[...]]>` wrapper, returns the inner body with `]]]]><![CDATA[>` sequences collapsed to `]]>` and trimmed; otherwise returns `text` unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `src/formatter.test.ts` (inside the existing describe/import conventions of that file):

```ts
import { stripCdataWrapper } from './formatter.js';

describe('stripCdataWrapper', () => {
  it('returns plain text unchanged', () => {
    expect(stripCdataWrapper('Working on it.')).toBe('Working on it.');
  });

  it('leaves mid-body CDATA (a code sample) untouched', () => {
    const text = 'Use `<![CDATA[x]]>` syntax like this.';
    expect(stripCdataWrapper(text)).toBe(text);
  });

  it('unwraps a whole-body CDATA wrapper', () => {
    expect(stripCdataWrapper('<![CDATA[Two separate failures.]]>')).toBe('Two separate failures.');
  });

  it('trims whitespace inside and around a whole-body wrapper', () => {
    expect(stripCdataWrapper('  <![CDATA[\nDone.\n]]>  ')).toBe('Done.');
  });

  it('collapses the split CDATA boundary back to the original text', () => {
    expect(stripCdataWrapper('<![CDATA[a ]]]]><![CDATA[> b]]>')).toBe('a ]]> b');
  });

  it('does not unwrap when the body only starts with the marker', () => {
    const text = '<![CDATA[open but never closed';
    expect(stripCdataWrapper(text)).toBe(text);
  });
});
```

Add to `src/poll-loop.test.ts` after the `accepts single-quoted destination names in explicit final message tags` test (~line 1136):

```ts
  it('delivers CDATA-wrapped final message bodies without the markers', async () => {
    insertChannelDestination('discord-current', 'chan-2');
    insertMessage(
      'cdata-final-chat',
      'chat',
      { sender: 'User', text: 'finish this' },
      { platformId: 'chan-2', channelType: 'discord', threadId: 'thread-2' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'cdata-final-session' };
      yield {
        type: 'result',
        text: '<message to="discord-current"><![CDATA[Two separate failures — not a permission problem.]]></message>',
      };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('cdata-final-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Two separate failures — not a permission problem.');

    await loopPromise.catch(() => {});
  });

  it('delivers the split CDATA boundary form as the original text', async () => {
    insertChannelDestination('discord-current', 'chan-2');
    insertMessage(
      'cdata-split-final-chat',
      'chat',
      { sender: 'User', text: 'finish this' },
      { platformId: 'chan-2', channelType: 'discord', threadId: 'thread-2' },
    );

    const provider = new ScriptedProvider(async function* () {
      yield { type: 'init', continuation: 'cdata-split-final-session' };
      yield {
        type: 'result',
        text: '<message to="discord-current"><![CDATA[kept ]]]]><![CDATA[> sequence]]></message>',
      };
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal);

    await waitFor(() => getAckStatus('cdata-split-final-chat') === 'completed', 1500);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('kept ]]> sequence');

    await loopPromise.catch(() => {});
  });
```

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test src/formatter.test.ts src/poll-loop.test.ts -t "stripCdataWrapper"` then `PATH="$HOME/.bun/bin:$PATH" bun test src/poll-loop.test.ts -t "CDATA"`

Expected: FAIL — the formatter tests fail because `stripCdataWrapper` does not exist (import error — acceptable as the red for a new export; confirm it is the missing-export failure, not a syntax accident). The two poll-loop tests fail because the delivered `text` is the body verbatim with the `<![CDATA[`/`]]>` markers (and the split form intact) — assert the actual delivered text in the failure output shows the markers.

- [ ] **Step 3: Add the minimal production implementation**

In `src/formatter.ts`, after `stripInternalTags`:

```ts
const CDATA_WRAPPER_RE = /^<!\[CDATA\[([\s\S]*)\]\]>$/;
// The inverse of the codex provider's ]]> split (which rewrites ]]> to
// ]]]]><![CDATA[>): note FOUR closing brackets before the >.
const CDATA_SPLIT_BOUNDARY_RE = /\]\]\]\]\><!\[CDATA\[>/g;

/**
 * Remove a whole-body `<![CDATA[...]]>` wrapper from agent-authored text
 * before delivery. The codex provider rewraps inbound chat bodies in a CDATA
 * boundary (and splits any literal `]]>` inside them); models imitating that
 * envelope can echo the markers into their replies, so delivery strips the
 * wrapper again — collapsing the split boundary back to the original text.
 * Text that merely contains CDATA mid-body (for example a code sample) is
 * delivered unchanged: only a single wrapper around the whole body is removed.
 */
export function stripCdataWrapper(text: string): string {
  if (!text || !text.includes('<![CDATA[')) return text;
  const match = CDATA_WRAPPER_RE.exec(text.trim());
  if (!match) return text;
  return match[1].replace(CDATA_SPLIT_BOUNDARY_RE, ']]>').trim();
}
```

In `src/poll-loop.ts`:

1. In `dispatchResultText`, replace `const body = match[3].trim();` (line ~2169) with:

```ts
    const body = stripCdataWrapper(match[3].trim());
```

2. In `writeRoutedMessage` (the nudge-ignored fallback delivery), wrap the text before sanitation (line ~193):

```ts
  const sanitized = sanitizeDeliveredText(stripCdataWrapper(text), (name) => Boolean(findByName(name)));
```

3. Add `stripCdataWrapper` to the existing `from './formatter.js'` import in poll-loop.ts (it already imports `sanitizeDeliveredText` and `stripInternalTags` from there).

- [ ] **Step 4: Run the focused tests**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test src/formatter.test.ts src/poll-loop.test.ts -t "CDATA"` and `PATH="$HOME/.bun/bin:$PATH" bun test src/formatter.test.ts -t "stripCdataWrapper"`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None expected — the helper is single-purpose and sits next to its siblings in formatter.ts. Confirm the `writeRoutedMessage` change composes with `sanitizeDeliveredText`'s nested-`<message to>` stripping (stripping the outer wrapper first cannot break the block regex, which only matches full `<message to=...>...</message>` pairs).

- [ ] **Step 6: Run impacted-test verification**

Affected groups: everything that exercises dispatch or delivered text — the whole `src/poll-loop.test.ts` (104 tests, ~23s), `src/formatter.test.ts`, and any test asserting delivered message text shapes.

Run: `PATH="$HOME/.bun/bin:$PATH" bun test src/formatter.test.ts src/poll-loop.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add container/agent-runner/src/formatter.ts container/agent-runner/src/formatter.test.ts container/agent-runner/src/poll-loop.ts container/agent-runner/src/poll-loop.test.ts
git commit -m "fix: strip whole-body CDATA wrappers from delivered messages (kata rdj6)"
```

---

### Task 2: MCP send_message and send_file deliver clean text

**Files:**
- Modify: `src/mcp-tools/core.ts` (send_message text at ~line 168; send_file text at ~line 236)
- Modify: `src/mcp-tools/core.test.ts` (send_message CDATA test)
- Create: `src/mcp-tools/send-file.test.ts` (send_file handler test with a mocked fs — send_file has zero coverage today)

**Interfaces:**
- Consumes: `stripCdataWrapper` from `../formatter.js` (Task 1), the `ok`/`err`/`resolveRouting`/`routeStampForCurrentSession`/`writeMessageOut` helpers already in core.ts.
- Produces: no new production interface; both handlers deliver stripped text.

- [ ] **Step 1: Write the failing tests**

Add to `src/mcp-tools/core.test.ts` (imitate the `stamps same-route send_message rows` test at ~line 121):

```ts
  it('unwraps whole-body CDATA text in send_message deliveries', async () => {
    const dir = writeActiveInput('opencode|discord|chan-1|dm:mg-1');
    createSessionRouting({
      channelType: 'discord',
      platformId: 'chan-1',
      threadId: null,
      messagingGroupId: 'mg-1',
      isGroup: 0,
    });

    const result = await sendMessage.handler({ text: '<![CDATA[Done — clean text.]]>' });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Done — clean text.');

    fs.rmSync(dir, { recursive: true, force: true });
  });
```

Create `src/mcp-tools/send-file.test.ts` (new file — send_file copies the file through fs against `/workspace/outbox`, which does not exist on a workstation, so `fs` is mocked before importing the handler). Two harness facts are load-bearing-verified on bun 1.4.2: (a) a naive `{ ...fs }` spread WITHOUT a `default` key silently keeps the real module for `import fs from 'fs'` consumers — the `default:` shim is required; (b) `mock.module` overrides are process-global for the whole `bun test` run and cannot be restored, so the mock must be PATH-SCOPED: it delegates to the real fs for everything outside `/workspace` (the test file's own statically-imported `fs` binding captured BEFORE the mock registration IS the real module — that is the delegation target). This keeps every other test file, whatever its load order, on real filesystem behavior. The `destinations` table lives in the INBOUND test db (insert via `getInboundDb()`, mirroring core.test.ts's `insertDestination`), and `getUndeliveredMessages` comes from `../db/messages-out.js`:

```ts
import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';

import fs from 'fs';
import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';

// Captured BEFORE the mock registration, so this binding is the real fs.
const realFs = fs;

// Path-scoped virtualization: only /workspace paths are virtual; every other
// caller in the test process keeps real fs behavior (bun's mock.module is
// process-global and not restorable).
const fsMock = {
  ...realFs,
  existsSync: (p: string) => (typeof p === 'string' && p.startsWith('/workspace') ? true : realFs.existsSync(p)),
  mkdirSync: (p: string, ...rest: Parameters<typeof realFs.mkdirSync>) =>
    typeof p === 'string' && p.startsWith('/workspace') ? undefined : realFs.mkdirSync(p, ...rest),
  copyFileSync: (src: string, dst: string, ...rest: Parameters<typeof realFs.copyFileSync>) =>
    typeof dst === 'string' && dst.startsWith('/workspace') ? undefined : realFs.copyFileSync(src, dst, ...rest),
};
mock.module('fs', () => ({ ...fsMock, default: fsMock }));

// Imported after the fs mock is registered.
const { sendFile } = await import('./core.js');

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-current', 'Discord Current', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_file', () => {
  it('unwraps whole-body CDATA text in the accompanying message', async () => {
    const result = await sendFile.handler({
      to: 'discord-current',
      path: '/workspace/agent/report.pptx',
      filename: 'report.pptx',
      text: '<![CDATA[Found the originals — unchanged.]]>',
    });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content.text).toBe('Found the originals — unchanged.');
    expect(content.files).toEqual(['report.pptx']);
  });
});
```

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test src/mcp-tools/core.test.ts -t "CDATA"` and `PATH="$HOME/.bun/bin:$PATH" bun test src/mcp-tools/send-file.test.ts`

Expected: FAIL — the send_message test delivers the text verbatim WITH the `<![CDATA[`/`]]>` markers; the send_file test delivers `content.text` with the markers (or, if the harness has a setup defect, fix the harness until the failure is exactly the marker assertion).

- [ ] **Step 3: Add the minimal production implementation**

In `src/mcp-tools/core.ts`:

1. Add the import: `import { stripCdataWrapper } from '../formatter.js';`
2. In `send_message`'s handler, replace `const text = args.text as string;` (line ~168) with:

```ts
    const text = stripCdataWrapper(args.text as string);
```

3. In `send_file`'s `writeMessageOut` call, replace the content line (~line 236) with:

```ts
        content: JSON.stringify({ text: stripCdataWrapper((args.text as string) || ''), files: [filename] }),
```

- [ ] **Step 4: Run the focused tests**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test src/mcp-tools/core.test.ts src/mcp-tools/send-file.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None expected. Confirm no other core.ts handler delivers model-authored chat text (`edit_message` and the interactive tools are out of scope for this run — record them as suggestions, do not change them).

- [ ] **Step 6: Run impacted-test verification**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test src/mcp-tools/`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add container/agent-runner/src/mcp-tools/core.ts container/agent-runner/src/mcp-tools/core.test.ts container/agent-runner/src/mcp-tools/send-file.test.ts
git commit -m "fix: unwrap CDATA text in MCP send_message and send_file deliveries (kata rdj6)"
```

---

### Task 3: `prepareCodexInputText` stops rewrapping runtime-injected example tags

**Files:**
- Modify: `src/providers/codex.ts` (the `prepareCodexInputText` regex, ~line 119-132)
- Modify: `src/providers/codex.factory.test.ts` (new test pinning the nudge example is untouched; existing restore tests stay green)
- Modify: `docs/agent-runner-details.md` (envelope/dispatch contract section: one sentence on outbound unwrap, one on the scoped inbound restore)

**Interfaces:**
- Consumes: `prepareCodexInputText`'s current shape-only regex `/(<message\b[^>]*>)([\s\S]*?)(<\/message>)/g` (codex.ts:120).
- Produces: same function, same export; only the open-tag discriminator changes — the open tag must now carry `sender="` (every real formatted inbound envelope does; the unwrapped-output nudge's `<message to="name">` example does not).

- [ ] **Step 1: Write the failing test**

Add to `src/providers/codex.factory.test.ts` next to the existing `prepareCodexInputText` tests (their envelope shapes, e.g. `<message id="2" sender="A &amp; B" time="now">`, stay untouched):

```ts
  it('does not rewrite the unwrapped-output nudge example pair', () => {
    const nudge = [
      'Your last answer was not delivered because it was not wrapped in a final `<message to="name">...</message>` block.',
      'Do not redo work. Do not call tools. Reply now with only the corrected final message block.',
      'The current inbound message came from `discord-yente-threaded`; address the block to `discord-yente-threaded`.',
      '',
      'Put this exact answer text inside the block:',
      '<answer>',
      'Two separate failures.',
      '</answer>',
    ].join('\n');
    expect(prepareCodexInputText(nudge)).toBe(nudge);
  });

  it('still restores real chat envelopes alongside untagged example text', () => {
    const input =
      '<context timezone="America/Los_Angeles" />\n' +
      '<message id="2" from="discord-yente-threaded" sender="DanS" time="Sep 27, 2026, 10:11 PM">what happened?</message>';
    const prepared = prepareCodexInputText(input);
    expect(prepared).toContain('<message id="2" from="discord-yente-threaded" sender="DanS" time="Sep 27, 2026, 10:11 PM"><![CDATA[what happened?]]></message>');
  });
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test src/providers/codex.factory.test.ts -t "nudge"`

Expected: FAIL — the current shape-only regex rewrites the nudge's example pair, so the output contains `<message to="name"><![CDATA[...]]></message>` and does not equal the input.

- [ ] **Step 3: Add the minimal production implementation**

In `src/providers/codex.ts`, replace the regex and add the scope comment (function body otherwise unchanged):

```ts
export function prepareCodexInputText(input: string): string {
  return input.replace(
    // Only real formatted chat envelopes are restored: formatSingleChat
    // always emits sender="..." on inbound <message> tags, while runtime-
    // injected prompts (the unwrapped-output nudge) carry only the literal
    // <message to="name"> example pair. Requiring sender= keeps the exact-
    // text CDATA restore scoped to user chat and stops the nudge's example
    // from being rewritten into a CDATA-wrapped form the model then imitates.
    /(<message\b[^>]*\bsender="[^"]*"[^>]*>)([\s\S]*?)(<\/message>)/g,
    (_match, open: string, escapedBody: string, close: string) => {
      const body = escapedBody
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&')
        .replace(/]]>/g, ']]]]><![CDATA[>');
      return `${open}<![CDATA[${body}]]>${close}`;
    },
  );
}
```

- [ ] **Step 4: Run the focused tests**

Run: `PATH="$HOME/.bun/bin:$PATH" bun test src/providers/codex.factory.test.ts`

Expected: PASS — including the two pre-existing `prepareCodexInputText` restore tests (their envelopes carry `sender="`), whose input/output strings must not be modified.

- [ ] **Step 5: Refactor while green**

None expected. Confirm the only `prepareCodexInputText` call site (codex.ts:537) needs no change, and that `<messages>`/`<quoted_message>` tags still cannot match (word boundary after `<message`).

- [ ] **Step 6: Run impacted-test verification**

Affected groups: the codex provider tests and any poll-loop test that drives the codex path end to end.

Run: `PATH="$HOME/.bun/bin:$PATH" bun test src/providers/` then `PATH="$HOME/.bun/bin:$PATH" bun test src/poll-loop.test.ts -t "nudge"`

Expected: PASS

- [ ] **Step 7: Document and commit the task**

In `docs/agent-runner-details.md`, at the dispatch-contract sentence (~line 635) and the envelope section (~lines 552-615), add two sentences (keep them current-state, no history):

```markdown
Delivered text never carries the CDATA boundary: a whole-body `<![CDATA[...]]>` wrapper (including the split `]]]]><![CDATA[>` form) is stripped from final-message bodies and from MCP send_message/send_file text before delivery.
```

and

```markdown
The exact-text CDATA restore in the codex provider applies only to formatted inbound chat envelopes (`<message>` tags carrying `sender="`); runtime-injected prompts such as the unwrapped-output nudge are never rewritten.
```

```bash
git add container/agent-runner/src/providers/codex.ts container/agent-runner/src/providers/codex.factory.test.ts docs/agent-runner-details.md
git commit -m "fix: scope the codex CDATA restore to real chat envelopes, never the nudge example (kata rdj6)"
```

---

## Verification (whole plan)

1. Focused tests per task (commands above) — each red before its implementation, green after.
2. Typecheck: `PATH="$HOME/.bun/bin:$PATH" bun run typecheck` at final HEAD — green.
3. Full-suite gate: `PATH="$HOME/.bun/bin:$PATH" bun test` at final HEAD — green excluding the four ledger-recorded pre-existing full-suite flakes (Task 6 Dvora replay ×2, poll-loop unbacked parking ×2 — receipts in the baseline ledger; each must pass focused if it appears).
4. The kata rdj6 evidence: per-task commit SHAs plus the gate receipt recorded in the progress ledger.

## Plan-level notes

- The outbound unwrap is deliberately whole-body-only: a reply that merely quotes CDATA syntax in a code block keeps its markers. The leak the incident showed was the whole-body form.
- `edit_message` (mcp-tools/core.ts:299) and the interactive tools (interactive.ts ask_user_question/send_card) can also deliver model-authored text verbatim and are candidates for the same strip, but the User Request scoped this run to the final-message dispatch, its nudge-ignored fallback, and MCP send_message/send_file; the others are recorded as suggestions.
- Relay lanes reuse the send_message handler, so they inherit the Task 2 strip.
- The inbound restore's pinned tests (codex.factory.test.ts:91-112) are the fidelity contract: if the discriminator breaks them, the discriminator is wrong, not the tests.
