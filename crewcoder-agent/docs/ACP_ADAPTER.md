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
| `session/set_approval_mode` | Switches the active session approval/sandbox mode without respawning CrewCoder |
| `session/set_external_directories` | Replaces and persists the session's explicitly granted filesystem roots |
| `session/compact` | Compacts the durable CrewCoder session in place and returns the summary |
| `session/set_system_prompt` | Sets a host-supplied system prompt for the session. Routed through `extMethod` |
| `session/set_project_instructions` | Sets host-read project files (AGENTS.md) that CrewCoder drops per turn for backends that load them natively. Routed through `extMethod` |
| `session/set_instruction_policy` | Turns the worker identity and the user's global instruction files on or off for the session. Routed through `extMethod` |
| `authenticate` | No-op; credentials are managed by `crewcoder auth` |

Capabilities are reported **honestly**: `loadSession: true`,
`promptCapabilities.image: false`. CrewCoder takes images as on-disk paths, not
inline base64, so advertising the ACP image block would invite a request it cannot
serve. Manual compact is advertised on `initialize._meta["crewcoder/sessionCompact"]`
and the host system prompt on `initialize._meta["crewcoder/sessionSystemPrompt"]`,
not as standard ACP session capabilities.

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

`session/set_approval_mode` is another additive extension. It accepts
`{ sessionId, approvalMode }`, where `approvalMode` is `never`, `review`, `always`,
`full-access`, or `sandboxed`. The value is session-scoped and applies to the next prompt.
Clients that own the complete execution safety boundary may synchronize their trust mode
after `session/new` / `session/load` and whenever it changes. A client that retains a host-side
dangerous-command tripwire should keep CrewCoder in `review` and auto-resolve ordinary ACP
permission requests instead; setting `full-access` makes Codex unrestricted and prevents that
host from inspecting provider-native commands before execution.

`session/set_system_prompt` is an additive extension for hosts that give CrewCoder an
identity or role of their own (for example a Supervisor persona). It accepts
`{ sessionId, systemPrompt }`, where `systemPrompt` is a string of at most 262,144
characters. An empty string clears it. The response is
`{ applied: true, length, appliesTo: "next_prompt" }`.

The prompt is appended to CrewCoder's system field under a "Host application system
prompt" heading on every model request. It is never written to the transcript, so a host
does not need to repeat identity context inside each user message, the transcript does not
accumulate duplicate copies, and compaction cannot summarize it away. Where it defines
identity, role, or voice it takes precedence over CrewCoder's default identity; tool policy,
approvals, and sandbox rules still apply.

The value is held in memory for the live ACP session and is **not persisted**. Hosts must
send it after every `session/new` and `session/load`, and again whenever it changes. A turn
that is already running keeps the system field it started with. Changing the prompt changes
the request prefix, so the next request cannot reuse the provider prompt cache, and the
Codex app-server provider starts a fresh native thread because its continuation contract
hash covers the system prompt. `initialize._meta["crewcoder/sessionSystemPrompt"]`
advertises `{ method: "session/set_system_prompt", maxChars: 262144, persisted: false }`.

`session/set_project_instructions` lets a host that reads project instruction files itself
(CrewMate reads the workspace AGENTS.md, including on remote nodes) hand them to CrewCoder
without them reaching the model twice. It accepts
`{ sessionId, instructions: [{ file: "AGENTS.md", text }] }`. `file` must be one of the
advertised files, each file appears once, and the texts total at most 131,072 characters.
An empty array clears them. The response is `{ applied: true, count, appliesTo: "next_prompt" }`.
The text is opaque host-formatted content.

On every turn CrewCoder resolves the active provider and appends each file to the host
system prompt only when that backend would not load it from the session cwd by itself:

| Provider | Loads natively | Host AGENTS.md |
| --- | --- | --- |
| `codex-cli` (user's `codex app-server`) | AGENTS.md | Dropped |
| `claude` (Claude Agent SDK, `settingSources: ["project"]`) | CLAUDE.md | Dropped only when `CLAUDE.md` or `.claude/CLAUDE.md` imports it (`@AGENTS.md`, `@./AGENTS.md`, `@../AGENTS.md`) |
| Every other provider | Nothing | Kept |

The decision is per turn because the provider can change with `session/set_model`. Like the
system prompt, the files are held in memory only; hosts re-send them after `session/new`,
`session/load`, and whenever they change. `initialize._meta["crewcoder/projectInstructions"]`
advertises `{ method: "session/set_project_instructions", version: 1, files: ["AGENTS.md"], maxChars: 131072, persisted: false }`.
The logic lives in `src/core/host-project-instructions.ts`.

`session/set_instruction_policy` lets a host that supplies its own identity decide which of
CrewCoder's own instruction sources apply. It accepts
`{ sessionId, workerIdentity: boolean, globalInstructions: boolean }` and returns
`{ applied: true, version: 1, workerIdentity, globalInstructions, appliesTo: "next_prompt" }`.
Without a policy the session behaves as standalone CrewCoder: worker identity on, no global files.

- `workerIdentity: false` omits the active worker's identity block (`~/.crewcoder/workers/<name>`).
- `workerIdentity: true` permits identity only when the user's persistent `workerIdentityEnabled` setting is also on. Host opt-in never overrides user opt-out. See [worker identity](WORKER_IDENTITY.md).
  Hosted text-only sessions never include it either way.
- `globalInstructions: true` adds the user's `$CODEX_HOME/AGENTS.md` (default `~/.codex`) and
  `$CLAUDE_CONFIG_DIR/CLAUDE.md` (default `~/.claude`) under a "Global user instructions" heading,
  including hosted text-only sessions. `@path` imports in CLAUDE.md are inlined the way Claude Code
  does (relative to the importing file, `~/` for home, at most five hops, not inside code fences).
  The block is capped at 65,536 characters. `codex-cli` already loads the Codex file from the user's
  `CODEX_HOME`, so CrewCoder skips that one for it. The Claude Agent SDK runs with project settings
  only, so the user CLAUDE.md is always added by CrewCoder.
- `globalInstructions: false` adds nothing, but cannot stop `codex-cli` from reading the user's own
  `~/.codex/AGENTS.md`.

The policy is held in memory only; hosts re-send it after `session/new`, `session/load`, and on change.
`initialize._meta["crewcoder/instructionPolicy"]` advertises
`{ method: "session/set_instruction_policy", version: 1, globalSources: ["codex-agents", "claude-md"], persisted: false }`.
The logic lives in `src/core/global-instructions.ts`.

`session/compact` is the host compact-button path. It is an additive extension method
routed through `extMethod`, same as `session/set_model`. `initialize._meta["crewcoder/sessionCompact"]`
advertises `{ method: "session/compact", preview: true, editedSummary: true }` so CrewCode can
stop local summary-reset and compact CrewCoder's durable session instead.

Request: `{ sessionId, preview?, summary? }`. `preview: true` generates the summary without
saving. A non-empty `summary` installs that text as the compacted background. The method
refuses while `session/prompt` is running and refuses sessions that have not been persisted
yet. It is the same rewrite as `crewcoder session compact`: older messages become a
synthetic background summary, recent messages stay, native provider continuation is
cleared, and `lastInputTokens` is reset.

Response:

```txt
compacted, preview, edited, compactionId?, source?, fallbackReason?,
originalMessageCount, retainedMessageCount, summary
```

Host-requested compact emits `_crewcoder/compaction_update` with `automatic: false`. The
completed update **includes `summary`** so the client can replace its local history with
CrewCoder's summary rather than inventing one. Automatic live compaction still omits the
summary body on the update channel.

`session/prompt` reports usage **twice**: `_meta["crewcoder/usage"]` (spec-correct,
full `UsageSummary` including `contextWindow` and `lastInputTokens`) and a top-level
`usage` mirror, which is where hermes-derived clients look.

Agent-to-client calls used: `session/update`, `session/request_permission`,
`fs/read_text_file`, `fs/write_text_file`.

## Artifacts

`initialize._meta["crewcoder/artifacts"]` advertises the versioned
`session/artifacts/list`, `session/artifacts/read`, and `session/artifacts/write`
methods. Normal ACP sessions offer `artifact_write`, `artifact_read`, and
`artifact_list` to tool-routed models. Changes emit a separate
`_crewcoder/artifact_updated` JSON-RPC notification with session-scoped metadata.
Hosts re-list after loading or reconnecting and fetch source to render or download.
The embedding app owns preview isolation and editing UI; CrewCoder never executes source.
Hosted-text-only sessions exclude these tools and refuse artifact write RPCs.
See [Artifacts over ACP](ARTIFACTS.md) for schemas, revisions, permissions, and limitations.

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

`tool_execution_end` copies `result.details` onto `rawOutput` next to
`output` / `isError`. Task tools put a `todos` snapshot there so CrewCode's
overlay can render the current session list without reconstructing mutations.

Compaction has no standard ACP lifecycle shape, so CrewCoder uses the additive
`_crewcoder/compaction_update` session-update kind. It carries `status`,
`automatic`, `percent`, `message`, and optional phase/count/id metadata. Automatic
live compaction keeps the summary body in CrewCoder's durable session and does not
put it on the update. Host-requested `session/compact` sets `automatic: false` and
includes `summary` on both the RPC result and the completed update. CrewCode
understands this extension; standard-only ACP clients safely ignore the unknown
update kind.

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

Provider-native operations use the same visible permission surface. When Codex app-server,
Claude Agent SDK, or a nested ACP provider calls `ModelStreamCallbacks.requestQuestion` with
options, the adapter announces a pending provider-question tool row and forwards the choices
through `session/request_permission`. Standard approval ids are mapped back to the provider's
original values (`allow_once` to `accept`, `allow_always` to `acceptForSession`, and
`reject_once` to `decline` for Codex). Codex's elevated-permission `turn` value also maps to
ACP `allow_once` and back; otherwise CrewCode's canonical response would be mistaken for a
rejection. Cancellation returns no answer, so providers retain
their fail-closed behavior without falsely claiming that the user rejected an unseen prompt.

CrewCode deliberately keeps CrewCoder in `review` for Build and Full. Full auto-resolves
ordinary `session/request_permission` calls while retaining CrewCode's catastrophic-command
tripwire; it must not select unrestricted Codex `dangerFullAccess`, which would bypass that gate.
Ask and Plan cancel mutation requests at the ACP client boundary.

| CrewCode mode | ACP lane | CrewCoder approval mode |
|---|---|---|
| `ask` / `plan` | permission requests declined | `review` |
| `build` | permission overlay shown | `review` (default) |
| `full` | ordinary requests auto-accepted; catastrophic commands require confirmation | `review` |

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

`session/prompt` must not re-emit that transcript. Later turns stream only new
assistant/thinking/tool updates. Replaying prior user/assistant chunks on each
prompt is what makes CrewCode duplicate the last messages at the start of a
turn.

Tool calls and thinking are **not** replayed, only message text. CrewCode sets
`suppressProviderHistoryReplay` when it has richer local history anyway.

## Client filesystem

When a client declares `clientCapabilities.fs.readTextFile` / `writeTextFile` at
`initialize`, the `read`, `write`, and `edit` tools route their text I/O through the
client instead of `node:fs`. That gets CrewCoder two things it cannot do on its own:
**unsaved editor buffers**, and **remote workspaces** (CrewCode proxies these over
SFTP).

Those capabilities describe available file methods, not workspace custody. The client
must separately send `_meta["crewcode/virtualFilesystem"]` on `initialize`. CrewCode
sends `false` for local chats and `true` for remote SSH chats.
Only the explicit `true` disables provider-native file access and activates the
runtime custody policy; missing metadata remains local-compatible for other ACP clients.

```txt
tools/text-file-io.ts   single choke point: host filesystem, else node:fs
ToolContext.textFiles   optional TextFileHost, plumbed from AgentLoopOptions
acp/client-files.ts     builds a TextFileHost backed by conn.readTextFile/writeTextFile
```

Three rules the implementation depends on:

- **Capability and custody are separate.** Local clients can provide `fs/*` for
  unsaved buffers while still allowing local provider runtimes. Never infer virtual
  custody from `clientCapabilities.fs`.
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
