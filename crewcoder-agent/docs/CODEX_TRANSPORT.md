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

Codex desktop/CLI login and CrewCoder login use separate credential stores. If Codex reports a
revoked refresh token, run `crewcoder login codex` (or `crew login codex`) and complete the device
login. A successful CrewCoder login replaces credentials in both its provider auth store and the
isolated app-server home, so a stale app-server refresh token cannot override the new login. Check
the active CrewCoder credentials with `crewcoder auth`; Codex OAuth is refreshed before it is
reported as ready.

For a new CrewCoder session, the provider:

1. Starts `codex app-server --stdio` from the pinned `@openai/codex` package.
2. Performs the JSON-RPC initialize handshake with experimental dynamic-tool support.
3. Calls `thread/start` and sends the current CrewCoder conversation context for the first turn.
4. Persists an encoded native thread ID in `providerSessionIds.codex`.

The launch also passes CrewCoder's resolved model context and compaction policy
as process-scoped Codex configuration. For every built-in GPT-5.6 variant this
is `model_context_window=1050000` and, with normal auto-compaction enabled,
`model_auto_compact_token_limit=630000` with `total` scope. This keeps Codex's
native thread from compacting at its smaller catalog default before CrewCoder's
60% boundary. It does not edit the user's Codex `config.toml`.

CrewCoder disables Codex reasoning summaries because they are short heading-like descriptions of
the next action rather than the native thought/progress text shown by Codex clients. Raw
`item/reasoning/textDelta` events and the authoritative completed reasoning item's `content` blocks
are routed through `thinking_delta`; streamed text is deduplicated against the completed content.
`commentary`-phase agent messages also remain visible in the thinking area, while `final_answer`
messages remain assistant output.

The app-server thread keeps the selected model's built-in Codex base instructions. CrewCoder's
system prompt is supplied as developer instructions, so it extends rather than replaces Codex's
native behavior. App-server approvals and sandboxing derive from CrewCoder's selected approval
mode: normal modes retain a workspace-write boundary, `review`/`always` requests are bridged to
CrewCoder's approval UI, and only `full-access` selects Codex's unrestricted sandbox. CrewCoder's
dynamic tools continue through CrewCoder's own approval and safety-policy path.

On later prompts—even in a new process—it calls `thread/resume` and sends only the latest user turn.
If the native thread was pruned or cannot be resumed, CrewCoder starts a replacement thread and
seeds it from the current compacted CrewCoder history.

The persisted continuation includes a hash of the stable request contract: model, system prompt,
working roots, and tool definitions. A contract change starts a fresh native thread instead of
silently attaching incompatible context. Compaction clears the native thread ID, as it does for
Claude, so discarded pre-compaction history cannot reappear.

## Tools and safety

For local workspaces, app-server runs its native shell and patch capabilities inside Codex's
`workspaceWrite` filesystem boundary. Its approval policy follows CrewCoder's active approval mode,
and provider-native approval requests route through the active host interaction channel. CrewCoder's
tool definitions remain registered as dynamic tools for specialized operations.

When an ACP or SDK host supplies a virtual filesystem (including SSH/SFTP workspaces), CrewCoder
does not start app-server because its built-in shell and patch tools operate on the local host and
cannot honor that virtual filesystem boundary. The Codex provider uses its direct Responses
transport for that session, where reads and writes are exposed only as CrewCoder tools and remain
routed through the host filesystem. Failed native `fileChange` events retain the provider's error
detail alongside the proposed patch instead of presenting the patch as if it were the result.
Failed native `commandExecution` events likewise retain provider error text and otherwise report
their declined status or exit code; an empty `aggregatedOutput` must never render as an unexplained
empty error.

CrewCoder requests Codex network isolation only for the explicit `sandboxed` approval mode.
`review`, `always`, and `never` are approval policies rather than strict network sandboxes, so their
app-server turns keep `networkAccess: true`. Forcing `networkAccess: false` in those modes makes
Codex create a private network namespace and can fail on restricted Linux hosts with
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`.

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
compacts known million-token windows at 60% and smaller known windows at 50%, and retains an 80%
emergency guard when normal auto-compaction is disabled. All built-in GPT-5.6
variants declare a 1,050,000-token window, so their normal trigger is 630,000
tokens in both CrewCoder and nested app-server. Applying compaction clears the Codex native
thread and initializes a replacement from the compacted summary plus recent messages.

See [`AUTO_COMPACTION.md`](./AUTO_COMPACTION.md).
