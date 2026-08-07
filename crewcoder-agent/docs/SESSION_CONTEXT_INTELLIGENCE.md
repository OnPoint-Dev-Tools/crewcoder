# Session & Context Intelligence

Phase 6 features that reuse the durable-session / event-stream substrate.

## Cross-session memory

Repo-shareable, file-backed memory the model can honor across sessions.

- Storage: `<repo>/.crewcoder/memory/<topic>.md` (repo-local, commit it to share).
- Per-project enablement is stored in `<repo>/.crewcoder/memory-settings.json` and defaults to **off**.
- Each fact is a markdown bullet with a stable id comment: `- <fact> <!-- id:ab12cd34 ts:... -->`.
- Files are grouped by topic (default topic is `memory`). Hand-edited bullets without an id comment are still listed with a derived id.
- Injection is **once per session, at the start**. `readMemoryContext(cwd)` composes all memory into a bounded (4k char) block that is attached to the first user message's `background` when a session begins (`src/core/agent-loop.ts`), next to `projectContext`. It is gated on `!resumeFromSessionId`, so resuming or continuing a session does not re-inject it — the memory block is already in the persisted transcript. It is not added to the system prompt (which would re-send it on every run).

Core: `src/core/memory-store.ts` (`rememberFact`, `listMemories`, `forgetMemory`, `readMemoryContext`, `resolveMemoryDir`).

### CLI

```bash
crewcoder remember "API base path is /v2"            # append to memory.md
crewcoder remember "Prefer pnpm" --topic tooling     # append to tooling.md
crewcoder memory on                                  # enable reads and writes for this project
crewcoder memory off                                 # disable reads and writes; preserve existing facts
crewcoder memory status [--json]                     # show this project's setting and paths
crewcoder memory list [--json]                       # list facts with ids even when disabled
crewcoder memory show [--json]                        # show the injected context block
crewcoder memory forget <id>                          # remove a fact by id
crewcoder memory path                                 # print the memory directory
```

### Tool

The built-in `remember` tool lets the agent persist durable facts itself (`{ fact, topic? }`).
It writes to the same repo-local store and is not treated as a source mutation (no checkpoint). Secrets must not be stored.
When project memory is off, memory is not injected and the tool rejects new writes. Existing files remain available to `memory list` and become active again after `memory on`.

### TUI

```txt
/memory              # show status for the current project
/memory on           # enable project memory
/memory off          # disable project memory without deleting facts
/memory status       # show the setting and repo-local paths
/memory list         # list saved facts
/remember I don't like using the library "dodo"
```

Memory must be enabled with `/memory on` before `/remember` or the agent's `remember` tool can write facts.

The toggle applies only to the TUI's current working directory. Other projects retain their own settings.

## Session "what changed since"

Summarize files touched, tools run, and last outcomes across sessions since a point in time, and optionally
pre-load that summary into a session for the next resume.

- `<ref>` resolves as a session id first (uses that session's `startedAt` as the cutoff), otherwise as an ISO
  timestamp or a relative duration (`30m`, `2h`, `7d`).
- Aggregates all sessions in the current repo (`cwd`) started at or after the cutoff, oldest first.
- Per session: changed files (unique mutation log), tool run counts (from `tool_execution_start` events), and the
  last assistant line as the decision/outcome.

Core: `src/core/session-since.ts` (`summarizeSessionsSince`, `formatSessionSinceContext`, `parseSinceRef`).

### CLI

```bash
crewcoder session since 2h                            # sessions in the last 2 hours
crewcoder session since <sessionId>                   # since that session started
crewcoder session since <ref> --json                  # machine-readable summary
crewcoder session since <ref> --into <sessionId>      # pre-load summary as resume context
crewcoder session resume <sessionId>                  # picks up the pre-loaded context
```

### Durable pre-loaded resume context

`--into` writes `formatSessionSinceContext(summary)` to the target session's `pendingResumeContext`. This field is
now persisted through the session JSONL metadata entry (`src/core/session-store.ts`) and consumed by
`runAgentLoopContinue`, which passes it as `resumeContext` on the next resume. Because each save re-emits metadata,
the field is automatically cleared after the resumed run completes.
