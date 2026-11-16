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

CrewCoder selects `CREWCODER_CLAUDE_PATH` when set, otherwise the first executable
`claude` on `PATH`, and uses the SDK's bundled executable only when no installed
CLI is available. Model discovery and inference share this resolver, so a newer
installed CLI supplies its current catalog instead of the SDK bundle's older list.
An explicit override is authoritative; an invalid override is not replaced.
On Windows, use the actual executable through `CREWCODER_CLAUDE_PATH` when the
installation exposes only a `.cmd` shim. CrewCoder defaults
`CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` to 24 hours because MCP-backed tools can remain paused for user
approval; an explicitly configured value is preserved.

Model pickers call SDK `supportedModels()` without sending an inference prompt.
Alias rows include their canonical `resolvedModel` IDs. Executable path and file
changes invalidate the process catalog cache, so native CLI updates are detected
without maintaining another model allowlist. See [automatic model discovery](PROVIDERS.md#automatic-model-discovery).

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

Project `CLAUDE.md` guidance remains available, while Claude's Skill tool and global skill catalogs
are not auto-enabled. Agents may still *read* on-demand skill files themselves: existing user
catalogs (`~/.agents/skills`, `~/.crewcoder/skills`, `~/.claude/skills`, `~/.codex/skills`) are
passed as extra `additionalDirectories` so native Read/Grep/Glob can open them. Skill bodies are
never injected into the system prompt. Undeclared MCP servers stay excluded. CrewCoder still
appends its own system prompt separately.
External directories are passed through the SDK and remain subject to CrewCoder tool validation for
all MCP-backed operations. When ACP or the SDK supplies a virtual `TextFileHost` (including SSH/SFTP),
CrewCoder disables Claude-native Read/Grep/Glob and exposes those operations through MCP instead. A
local Claude subprocess must never bypass the host filesystem boundary.

## Durable native resume

Claude's returned native session ID is stored under `SessionRecord.providerSessionIds.claude`.
CrewCoder passes it back through SDK `resume` on later turns and process restarts. Provider-native
IDs are namespaced by provider so switching providers never sends a Claude ID elsewhere.

Claude keeps native sessions on the machine that created them. When a resume fails with "No
conversation found" before any text or tool activity (a session moved with a bundle, or Claude's
files were cleaned up), the provider retries the turn once without `resume`, replaying the full
CrewCoder transcript, and stores the new native id. Any other failure is reported as is and never
retried, so a real error is not hidden or a tool run twice. See `docs/SESSION_BUNDLE.md`.

## Streaming and cancellation

Assistant and thinking deltas stream through normal CrewCoder events. Native read/search tool
activity is projected into tool start/end events with fully assembled arguments; MCP-backed tools
already emit CrewCoder's complete tool lifecycle. Aborting the CrewCoder turn aborts the SDK query.
After a turn, context occupancy is kept separate from aggregate billing usage. When available,
SDK `getContextUsage()` supplies `totalTokens` and the effective `maxTokens` capacity. Single-turn
SDK queries close their transport at the result, so that lookup can fail even on a current binary.
The fallback uses the latest main-agent assistant response's `input_tokens + cache_read_input_tokens
+ cache_creation_input_tokens`, matching [Claude Code's input-only context percentage](https://code.claude.com/docs/en/statusline#context-window-fields).
It replaces the previous request's count, excludes subagent responses and output tokens, and resets
at a native compaction boundary. It never sums request counts or uses aggregate result usage as
occupancy. The result's `modelUsage` entry for the responding model supplies runtime capacity when
the native query is unavailable; an unrelated model's entry is never substituted. These values
flow through `UsageSummary.lastInputTokens` and `contextWindow` to the TUI and ACP hosts such as
CrewMate, without changing billing/cache counters. Missing runtime capacity retains the usual
catalog fallback.

Regression coverage lives in `test/claude-context-usage.test.ts` and runs with the agent test
suite. After building the agent, `CREWCODER_LIVE_CONTEXT=1 node test/claude-context-live.mjs`
from the repository root performs one real request with the local Claude login and checks the
snapshot and runtime capacity. It does not invoke tools.

Claude SDK auto-compaction is disabled. CrewCoder keeps explicit `/compact` and its own persisted
compaction policy authoritative. Applying compaction clears provider-native session IDs before the
next turn, preventing Claude from reattaching the pre-compaction context.
