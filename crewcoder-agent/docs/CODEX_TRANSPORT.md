# Codex Transport

CrewCoder's built-in ChatGPT OAuth Codex provider uses the official Codex app-server as its primary
transport. App-server persists native Codex threads on disk, so continuation survives CrewCoder,
CrewCode, and machine restarts. The direct Responses WebSocket/SSE implementation remains a guarded
fallback for legacy credentials and pre-turn app-server failures.

## Durable native threads

A successful `crewcoder login codex` now retains the OpenAI ID token needed by app-server. CrewCoder
writes the minimum official auth shape with mode `0600` under
`~/.crewcoder/codex-app-server/auth.json`; secrets are never placed in session files or logs. Codex
stores its durable rollouts under that isolated home.

For a new CrewCoder session, the provider:

1. Starts `codex app-server --stdio` from the pinned `@openai/codex` package.
2. Performs the JSON-RPC initialize handshake with experimental dynamic-tool support.
3. Calls `thread/start` and sends the current CrewCoder conversation context for the first turn.
4. Persists an encoded native thread ID in `providerSessionIds.codex`.

On later prompts—even in a new process—it calls `thread/resume` and sends only the latest user turn.
If the native thread was pruned or cannot be resumed, CrewCoder starts a replacement thread and
seeds it from the current compacted CrewCoder history.

The persisted continuation includes a hash of the stable request contract: model, system prompt,
working roots, and tool definitions. A contract change starts a fresh native thread instead of
silently attaching incompatible context. Compaction clears the native thread ID, as it does for
Claude, so discarded pre-compaction history cannot reappear.

## Tools and safety

App-server runs its native capabilities in a read-only sandbox with approval policy `never`.
CrewCoder's tool definitions are registered as dynamic tools; mutations and specialized operations
therefore return through CrewCoder's existing executor, approval, checkpoint, audit, extension-hook,
and path-containment boundaries. Unexpected native app-server approval requests are denied.

## Fallback and replay safety

Older saved OAuth credentials do not contain an ID token. They continue using the direct Codex
Responses transport until the user runs `crewcoder login codex` again. The direct implementation
uses connection-cached WebSocket continuation within a live process and SSE/full-context replay as
its fallback.

An app-server failure before `turn/start` is safe to fall back because no model output or tool side
effect can have occurred. CrewCoder never replays through the direct transport after `turn/start`
has been sent: the native turn may have started even if the local stream subsequently failed.

Provider error events remain terminal. Authentication, billing, failed turns, and protocol errors
must never be rendered as successful assistant text.

## Compaction still matters

Durable threads avoid repeated uploads; they do not create unlimited model context. CrewCoder
compacts at 60% of a known context window by default and retains an 80% emergency guard when normal
auto-compaction is disabled. Applying compaction clears the Codex native thread and initializes a
replacement from the compacted summary plus recent messages.

See [`AUTO_COMPACTION.md`](./AUTO_COMPACTION.md).
