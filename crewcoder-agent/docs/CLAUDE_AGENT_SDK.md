# Claude Code Agent SDK Provider

CrewCoder exposes `claude` as a native Claude Code Agent SDK provider. It is separate from the
`anthropic` API-key provider:

- `claude` uses the local Claude Code login and `@anthropic-ai/claude-agent-sdk`.
- `anthropic` sends direct Anthropic Messages API requests with `ANTHROPIC_API_KEY`.

## Setup

Authenticate Claude Code normally, then select the provider:

```bash
claude
crewcoder run --provider claude --model claude-sonnet-5 "inspect this repository"
```

The SDK bundles its platform Claude executable. Set `CREWCODER_CLAUDE_PATH` only when CrewCoder
must use a specific installed Claude Code executable. CrewCoder defaults
`CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` to 24 hours because MCP-backed tools can remain paused for user
approval; an explicitly configured value is preserved.

## Hybrid tool ownership

Claude keeps native read-only interaction tools:

- `Read`
- `Grep`
- `Glob`
- `AskUserQuestion`

All mutation, shell, and CrewCoder-specialized tools are exposed through an in-process SDK MCP
server. Their handlers call CrewCoder's existing executor, preserving:

- approval decisions and interactive pauses;
- pre-mutation checkpoints;
- sandbox policy;
- workspace and external-directory constraints;
- extension before/after/error hooks and approval policies;
- mutation logs, file-change events, and audit entries;
- CrewCoder-specific tools such as transactions, Git primitives, LSP, background jobs, and worker delegation.

Claude native `Bash`, `Edit`, `Write`, and other mutation tools are not in the SDK tool set. This is
intentional: enabling them would bypass CrewCoder's mutation guarantees.

## Context and skills

Every query uses:

```ts
settingSources: ["project"]
skills: []
strictMcpConfig: true
```

Project `CLAUDE.md` guidance remains available, while global skill catalogs and undeclared MCP
servers are excluded. CrewCoder appends its own system prompt and selected skills separately.
External directories are passed through the SDK and remain subject to CrewCoder tool validation for
all MCP-backed operations. When ACP or the SDK supplies a virtual `TextFileHost` (including SSH/SFTP),
CrewCoder disables Claude-native Read/Grep/Glob and exposes those operations through MCP instead. A
local Claude subprocess must never bypass the host filesystem boundary.

## Durable native resume

Claude's returned native session ID is stored under `SessionRecord.providerSessionIds.claude`.
CrewCoder passes it back through SDK `resume` on later turns and process restarts. Provider-native
IDs are namespaced by provider so switching providers never sends a Claude ID elsewhere.

## Streaming and cancellation

Assistant and thinking deltas stream through normal CrewCoder events. Native read/search tool
activity is projected into tool start/end events with fully assembled arguments; MCP-backed tools
already emit CrewCoder's complete tool lifecycle. Aborting the CrewCoder turn aborts the SDK query.
After a turn, SDK context usage supplies live context occupancy separately from aggregate billing
usage so CrewCoder's context meter and compaction threshold remain accurate.

Claude SDK auto-compaction is disabled. CrewCoder keeps explicit `/compact` and its own persisted
compaction policy authoritative. Applying compaction clears provider-native session IDs before the
next turn, preventing Claude from reattaching the pre-compaction context.
