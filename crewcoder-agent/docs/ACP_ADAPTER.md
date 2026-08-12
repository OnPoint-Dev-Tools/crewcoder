# ACP Adapter

`crewcoder acp` runs CrewCoder as an **Agent Client Protocol** agent: JSON-RPC 2.0
over newline-delimited stdio. Any ACP client — CrewCode, Block's Buzz, Zed — can
spawn it and drive the agent loop.

```bash
crewcoder acp --approval review
```

## Roles: CrewCoder is the agent, not the client

ACP is asymmetric. There are two halves and they are different work:

```txt
client (the app)          agent (the coding agent)
CrewCode, Buzz, Zed  ──spawns──>  crewcoder acp
```

The client owns the UI and spawns the agent as a child process on stdio. The agent
owns the model and the tools. CrewCode already implements the **client** half in
`src/main/agents/hermes-bridge.ts`; this adapter is the **agent** half. There is no
reason for CrewCode to also implement an agent — nothing would spawn it.

## Stdout is reserved

This is the single most important constraint. ACP frames occupy stdout exclusively;
one stray `console.log` corrupts the stream and the client silently stops parsing.

`src/acp/stdio.ts` captures the real stdout writer, hands it to the protocol, and
then replaces `process.stdout.write` with a shim that redirects to stderr with an
`[acp] suppressed stdout write:` prefix. Accidental writes become loud and harmless
instead of silent and fatal. **Do not remove this guard**, and do not hand
`process.stdout` directly to `ndJsonStream`.

## Package and protocol version

The adapter builds on `@agentclientprotocol/sdk` (the official TypeScript SDK from
the `agentclientprotocol` org). It replaces `@zed-industries/agent-client-protocol`,
which is deprecated and no longer receives updates.

Protocol version **1** is the stable wire, and it matches what CrewCode's bridge
sends. The SDK also ships a `v2` schema tree; do not adopt it until CrewCode and
Buzz negotiate it.

The 1.x SDK **removed `session/set_model`** and the `models` field (both were
`UNSTABLE` in 0.4.x, nominally replaced by `providers/*` and
`session/set_config_option`). Clients still use them, so this adapter re-adds both —
see "Deliberate deviations" below.

## Implemented methods

| Method | Behavior |
|---|---|
| `initialize` | Negotiates version 1, reports capabilities |
| `session/new` | Allocates a session id; does not call the model. Returns `models` |
| `session/load` | Reattaches a durable session and replays its transcript |
| `session/prompt` | Runs the agent loop; resolves with a `stopReason` |
| `session/cancel` | Aborts the run via `AbortSignal` |
| `session/set_model` | Switches provider/model. Routed through `extMethod` |
| `session/set_external_directories` | Replaces and persists the session's explicitly granted filesystem roots |
| `authenticate` | No-op; credentials are managed by `crewcoder auth` |

Capabilities are reported **honestly**: `loadSession: true`,
`promptCapabilities.image: false`. CrewCoder takes images as on-disk paths, not
inline base64, so advertising the ACP image block would invite a request it cannot
serve.

## Deliberate deviations from the 1.x schema

The adapter targets **hermes ACP parity**, because that is the dialect existing
clients (CrewCode, and anything written against hermes) already speak. Two pieces
of that dialect were dropped from the 1.x SDK schema and are re-added here:

- **`models` on `session/new` / `session/load`.** The 1.x schema removed the model
  API, but clients still read `result.models.availableModels[]` to populate their
  model picker (CrewCode's `detectHermesFromAcp` does exactly this). CrewCoder
  emits `{ modelId: "provider:model", name }` for every built-in provider model.
  Verified to survive the wire — the SDK does not strip unknown response fields.
- **`session/set_model`.** Removed from the schema, so it arrives at `extMethod`
  rather than as a typed method. `modelId` is split on the **first** colon, because
  model names contain colons of their own (`qwen-2.5:free`).

Both are additive: clients that ignore them are unaffected. Revisit if/when the
v2 `providers/*` and `session/set_config_option` methods land in CrewCode.

CrewCoder also defines `session/set_external_directories` as an additive extension method. It
accepts `{ sessionId, directories }`, validates directories on the agent host, replaces the active
session grant set, and persists changes once the session exists durably. CrewCode calls it after
new/load; sending an empty array is required to revoke stale grants. See
[`EXTERNAL_DIRECTORIES.md`](./EXTERNAL_DIRECTORIES.md).

`session/prompt` reports usage **twice**: `_meta["crewcoder/usage"]` (spec-correct,
full `UsageSummary` including `contextWindow` and `lastInputTokens`) and a top-level
`usage` mirror, which is where hermes-derived clients look.

Agent-to-client calls used: `session/update`, `session/request_permission`,
`fs/read_text_file`, `fs/write_text_file`.

## Event translation

`src/acp/event-translator.ts` maps `AgentEvent`s onto `session/update` payloads:

```txt
assistant_delta       -> agent_message_chunk
thinking_delta        -> agent_thought_chunk
tool_execution_start  -> tool_call        (kind, status, rawInput, locations, title)
tool_delta            -> tool_call_update (in_progress, content)
tool_execution_end          -> tool_call_update (completed | failed, rawOutput)
session_compaction_progress -> _crewcoder/compaction_update (started | completed | failed)
session_compacted           -> _crewcoder/compaction_update (completed)
```

Field names matter: CrewCode reads `rawInput`, `rawOutput`, `status`, and `title`
specifically. Get them wrong and tool rows render empty.

Compaction has no standard ACP lifecycle shape, so CrewCoder uses the additive
`_crewcoder/compaction_update` session-update kind. It carries `status`,
`automatic`, `percent`, `message`, and optional phase/count/id metadata. The
compacted summary body stays in CrewCoder's durable session and is deliberately
not broadcast to the client. CrewCode understands this extension; standard-only
ACP clients safely ignore the unknown update kind.

Everything else returns `undefined` and is dropped. CrewCoder's richer vocabulary —
checkpoints, cost ledger, durable goals, compaction preview, token budget,
verification, background jobs — still has **no standard ACP representation** and
must not be forced into a lossy standard update. Future additions belong on the
same namespaced `_crewcoder/*` extension channel.

`src/acp/tool-kind.ts` maps tool names onto the ACP `ToolKind` vocabulary. An
unmapped tool degrades to `other` rather than throwing — extension tools are
namespaced (`extension_<id>_<tool>`) and can never be enumerated ahead of time.

## Permissions

CrewCoder emits `approval_required` **before** `tool_execution_start`, so the client
has not seen the tool call yet when permission is requested. The adapter therefore
announces a `tool_call` (status `pending`) first, then calls
`session/request_permission`. Skipping that step leaves the permission prompt
pointing at a row that does not exist.

The decision is pushed into the loop's `approvalSignal`, the same channel the TUI's
stdin control uses. Do not replace this with saved-session polling — approvals must
control the *active* run.

Options are offered with the standard ids `allow_once`, `allow_always`,
`reject_once`, `reject_always`. The response is matched **by prefix**, not exact id,
because clients are known to answer with shortened ids (CrewCode replies `reject`).
`allow_always` / `reject_always` are remembered per session and per tool name.

CrewCode's composer modes already have an ACP lane, which maps onto CrewCoder's
`ApprovalMode`:

| CrewCode mode | ACP lane | `--approval` |
|---|---|---|
| `ask` / `plan` | permission requests declined | `always` |
| `build` | permission overlay shown | `review` (default) |
| `full` | auto-accept | `full-access` |

## Stop reasons

```txt
cancelled           session/cancel arrived
refusal             AgentLoopResult.approvalDenied
max_tokens          budgetExceeded
max_turn_requests   iterationCapReached
end_turn            otherwise
```

`providerError` and `stallError` are **not** stop reasons — they are turn failures,
raised as JSON-RPC errors so the client renders them as errors. Returning `end_turn`
on a provider auth failure would present a broken run as a successful one, which is
the same class of bug as rendering a provider error as assistant text.

ACP respects CrewCoder's persisted `autoCompact` setting and never compacts or retries merely
because a provider reported context-window overflow. With automatic compaction off, the error is
terminal and the user explicitly runs `/compact` before continuing. ACP must not silently rewrite
a user's durable session context.

## Sessions

`session/new` allocates an id without calling the model. The first `session/prompt`
runs `runAgentLoop` with that id; later prompts run `runAgentLoopContinue`, which
resumes from the durable session store. So multi-turn ACP conversations reuse the
same durable sessions as `crewcoder run`, and `crewcoder sessions` lists them. External directory
grants are restored from that record and may be replaced by the client through
`session/set_external_directories` before the next prompt.

## Testing

`src/tests/acp-adapter.test.ts` drives the server over in-memory `TransformStream`s
speaking raw JSON-RPC — the real wire, framing included, with no subprocess.
`createAcpServer({ input, output })` takes its streams as parameters precisely so
this works; keep it that way rather than reaching for `process.stdin` internally.

```bash
env -u OPENCODE_API_KEY CREWCODER_HOME=/tmp/.crewcoder npm test -w @onpoint-dev-tools/crewcoder-agent
```

## Session loading

`session/load` reattaches a durable CrewCoder session by id and streams its
transcript back as `user_message_chunk` / `agent_message_chunk` notifications, as
the spec requires. The loaded session is marked `started`, so the next
`session/prompt` continues it via `runAgentLoopContinue` rather than starting a
fresh run. An unknown id returns `resourceNotFound` rather than silently creating
a new session — a client that falls back to `session/new` should do so explicitly.

Tool calls and thinking are **not** replayed, only message text. CrewCode sets
`suppressProviderHistoryReplay` when it has richer local history anyway.

## Client filesystem

When a client declares `clientCapabilities.fs.readTextFile` / `writeTextFile` at
`initialize`, the `read`, `write`, and `edit` tools route their text I/O through the
client instead of `node:fs`. That gets CrewCoder two things it cannot do on its own:
**unsaved editor buffers**, and **remote workspaces** (CrewCode proxies these over
SFTP).

```txt
tools/text-file-io.ts   single choke point: host filesystem, else node:fs
ToolContext.textFiles   optional TextFileHost, plumbed from AgentLoopOptions
acp/client-files.ts     builds a TextFileHost backed by conn.readTextFile/writeTextFile
```

Three rules the implementation depends on:

- **Read and write are independent.** A client may offer reads without writes, so
  each method is wired only if actually claimed and each falls back separately.
  All-or-nothing gating would silently disable writes for read-only clients.
- **`mkdir` only happens on the local path.** A host filesystem owns its own
  directory creation; creating parents locally would target the wrong machine.
- **Images always come from local disk.** ACP `fs/read_text_file` is text-only.
  `read` still probes for an image first; against a remote workspace that probe
  simply finds nothing and falls through to the text read, which is correct — an
  inline image from a remote host cannot be rendered anyway.

The host is generic (`TextFileHost` in `core/tool-types.ts`), not ACP-specific, so
the fleet server or SDK can supply one too.

<!-- ## Not implemented yet

- `terminal/*` — CrewCode answers `-32601`, so `bash.ts` must keep executing
  locally and must never depend on the ACP terminal capability. Note this means
  shell commands still run **locally** even when files are served remotely.
- Image prompt blocks and the `_crewcoder/*` ext channel. -->
