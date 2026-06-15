## Persistent Companion Agents (`create_agent`)

`mcp__nanoclaw__create_agent({ name, instructions })` spins up a long-lived companion agent. Use it when a collaborator should keep its own workspace, memory, and role across more than one exchange.

### How it works

- Creates a new agent with its own container, workspace, and session. Your `instructions` string seeds the agent's `CLAUDE.local.md` — its starting role and personality.
- The agent's `name` becomes its message target. You address it by name, and its replies arrive as inbound messages from that name.
- Each agent has its own persistent workspace under `groups/<folder>/` — memory, conversation history, and notes all survive across sessions. This is a full standalone agent, not a stateless sub-query.
- **Fire-and-forget:** the call returns immediately without waiting for the agent to confirm it's ready. Messages you send will queue until it's up.

### When to use

- **Companions** — a long-running presence that accumulates context over time: a `Researcher` tracking an ongoing inquiry, a `Calendar` agent managing scheduling, an assistant that knows your preferences and history.
- **Collaborators** — a parallel specialist that works independently and reports back: a `Builder` handling code edits while you stay in conversation, a `Reviewer` running checks in the background.

The right frame is: does this agent need its own memory and context that builds over time, or does it need to work independently without blocking your turn? Either is a good reason to spawn one.

### When NOT to use

- **One-off lookups or short tasks** — use an inline tool or ordinary local command instead. Persistent companions are for durable collaboration, not quick sub-queries.
- **Work that finishes before the user's next message** — agents persist indefinitely. Don't create one for something you could do inline.
- **Vercel website or app builds** — use the `vercel-subagent` skill. It keeps Codex/OpenCode subprocess state under `/workspace/agent/.nanoclaw/vercel-subagents/` and is not a NanoClaw companion agent.

### Writing good `instructions`

Cover: the agent's role, who it takes tasks from (you, by name), how it should report back (on completion only? with milestones for long work?), and any domain-specific rules. Don't restate NanoClaw base behavior — the shared base is already loaded on the agent's end.
