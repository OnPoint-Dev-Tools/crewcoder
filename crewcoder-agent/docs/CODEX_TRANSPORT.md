# Codex CLI transport

CrewCoder exposes Codex through the `codex-cli` provider. It runs the user's
installed `codex app-server --stdio`, inherits the user's `CODEX_HOME` (normally
`~/.codex`), and uses the CLI's own login. CrewCoder has no separate Codex OAuth
login and does not install a bundled Codex runtime. See [Codex CLI setup](CODEX_CLI_PROVIDER.md).

## Model discovery

The model picker calls app-server `model/list` through the same installed CLI.
Discovery sends no inference prompt, excludes hidden models, follows bounded
pagination, and has a five-second deadline. Successful catalogs are cached for
five minutes within the backend process. See [automatic model discovery](PROVIDERS.md#automatic-model-discovery).

## Durable native threads

For a new CrewCoder session, the adapter:

1. Starts the installed Codex app-server.
2. Performs its JSON-RPC initialize handshake with experimental dynamic-tool support.
3. Calls `thread/start` with CrewCoder's developer instructions and tools.
4. Persists an encoded thread/contract identifier in `providerSessionIds["codex-cli"]`.

Later prompts call `thread/resume` and send only the latest user turn. If a
native thread cannot be resumed, CrewCoder starts a replacement seeded from its
current conversation history.

The continuation contract covers the model, system prompt, tool definitions,
working roots, and approval policy. Contract changes start a new native thread.
Workspace paths are replaced before hashing so session bundles can move between
machines while preserving a compatible native thread. See [session bundles](SESSION_BUNDLE.md).

### Pooled app-server under ACP

One-shot commands start an app-server per turn. Long-lived ACP hosts keep one
process per CrewCoder session and reuse already-loaded threads directly through
`turn/start`. This avoids repeated skill/plugin loading and context uploads.

Failed or aborted processes are closed rather than reused. Concurrent turns
use separate processes when a pooled process is busy. Idle processes close
after ten minutes; ACP shutdown and process exit close the pool.

## Tools, approvals, and filesystem custody

Local sessions use Codex native tools within the active approval and sandbox
policy. Approval and question requests route through CrewCoder's host interaction
channel. Native tool failures preserve provider error text and exit status.

Hosted or virtual filesystem sessions disable native shell, file, network,
MCP, hook, and agent tools, add a read-only sandbox, and use CrewCoder dynamic
tools for workspace operations. Failure to establish that lockdown refuses the
launch. See [hosted-tools-only lockdown](CODEX_CLI_PROVIDER.md#hosted-tools-only-lockdown).

Only explicit `sandboxed` approval mode requests native network isolation.
Normal approval modes preserve network access; forcing a private namespace there
can fail on restricted hosts with `bwrap: loopback: Failed RTM_NEWADDR`.

Thinking remains visible through raw reasoning deltas, completed reasoning
content, and commentary-phase messages, with streamed/final content deduplicated.
Final-answer messages remain assistant output.

## Failure behavior

There is no direct HTTP/SSE or WebSocket fallback. A missing CLI or failed
app-server launch returns an actionable provider error, and no started turn is
replayed through another transport. Authentication, billing, protocol, and turn
errors are terminal failures.

## Context and compaction

CrewCoder passes known context-window and compaction limits as process-only
Codex configuration without editing the user's `config.toml`. GPT-5.6 fallback
metadata declares 1,050,000 tokens with a normal 630,000-token compaction boundary.
Unknown discovered model windows are resolved separately rather than guessed.

Applying CrewCoder compaction clears the native thread ID so discarded history
cannot return on the next turn. Durable threads reduce repeated uploads; they
remain subject to the model's context limit. See [automatic compaction](AUTO_COMPACTION.md).
