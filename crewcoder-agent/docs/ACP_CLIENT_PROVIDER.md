# ACP Client Provider (`acp-client` runtime)

CrewCoder speaks **both halves** of the Agent Client Protocol.

```txt
src/acp/*                          CrewCoder IS the agent   (an editor spawns crewcoder acp)
src/providers/acp-client-provider  CrewCoder IS the client  (CrewCoder spawns an agent CLI)
```

This document covers the second one: the `acp-client` provider runtime, which lets
CrewCoder drive an external ACP agent CLI as if it were a model. The first consumer
is the **Grok CLI** (`grok agent stdio`).

## The core fact: this is a nested agent, not a model

An ACP agent is a complete coding agent. It owns its own model calls, its own tool
loop, its own approvals, and its own session store. So one `complete()` call through
this runtime runs an entire remote agent turn and can emit many assistant blocks and
many tool calls — exactly like `claude-agent-sdk-provider.ts`, and unlike every HTTP
provider.

Consequences that are deliberate, not oversights:

- **CrewCoder's own tools are not offered to the remote agent.** ACP has no
  client-to-agent tool contribution point, so the agent uses its own tools. Anything
  in `ModelInput.availableTools` is unused for this runtime.
- **CrewCoder keeps observation and authority, not execution.** Deltas, thinking, and
  tool activity stream into the normal event pipeline; approvals and file writes are
  routed back through CrewCoder.
- If you want CrewCoder's tool loop and its guardrails, use the `xai` provider
  instead. It reaches the same Grok models through `openai-chat-completions` under
  CrewCoder's own loop. The CLI's advantage is subscription auth plus Grok's own
  tooling, not better integration.

## Provider definition

```txt
id            grok
title         Grok CLI
runtime       acp-client
command       $CREWCODER_GROK_PATH ?? "grok"
args          ["agent", "stdio"]
apiKeyEnv     XAI_API_KEY          (or cached `grok login` credentials)
models        grok-4.5 (default)
transport     process / provider-session / replay: never
```

**Model ids here are Grok CLI ids, not xAI HTTP API ids.** Get the real list from a
logged-in CLI, never from docs:

```bash
grok models
```

The API ids carried by the `xai` provider (`grok-4.1-fast`, `grok-code-fast-1`) are
not selectable through the CLI. There is also no `grok-build` model — "Grok Build" is
the name of the CLI product itself. Do not sync the `grok` and `xai` model lists.

### Model and effort are spawn flags, not `session/set_model`

```txt
args: ["agent", "{{modelArg:--model}}", "{{effortArg:--reasoning-effort}}", "stdio"]
```

`renderArgs()` expands `{{modelArg:X}}` to `X <model>` and drops it entirely when no
model is selected. Two things are load-bearing:

- **Flag order.** `--model` and `--reasoning-effort` belong to `grok agent`. The
  `stdio` subcommand rejects them with `unexpected argument '--model' found`, so the
  flags must sit *between* `agent` and `stdio`.
- **Why not `session/set_model`.** ACP 1.x dropped the model API, so an agent may
  legitimately not implement it. A rejected call would leave the agent silently
  running on its own default while CrewCoder believed the selection took. A CLI flag
  either works or fails loudly at spawn.

`acp-client` is intentionally **not** in `EXTENSION_RUNTIMES`. Extension providers
may not select it yet: it is a new runtime that grants a spawned binary an `fs/*`
write channel, and that pairing has not been vetted against arbitrary third-party
agents. Adding it later is non-breaking; removing it would not be.

## Wire flow

```txt
spawn <command> <args>                 stdio pipes, shell: false
  -> ndJsonStream(child.stdin, child.stdout)
  -> initialize        { protocolVersion, clientInfo, clientCapabilities }
  -> session/load <providerSessionId>  (only when one is stored)
     or session/new    { cwd, mcpServers: [], additionalDirectories }
  -> session/set_model { sessionId, modelId }        best-effort
  -> session/prompt    { sessionId, prompt: ContentBlock[] }
  <- session/update    notifications, streamed until the prompt response resolves
```

`stderr` is captured separately and only surfaces on failure. The agent's stdout is
reserved for JSON-RPC frames, mirroring the guarantee `src/acp/stdio.ts` makes in the
other direction.

## Update mapping

```txt
agent_message_chunk  -> textParts + onAssistantDelta
agent_thought_chunk  -> onThinkingDelta
tool_call            -> onProviderToolStart (title as name, rawInput as arguments)
tool_call_update     -> onProviderToolEnd on completed/failed only
usage_update.used    -> ModelUsage.contextTokens
everything else      -> dropped
```

Dropped updates (`plan`, `available_commands_update`, `current_mode_update`,
`config_option_update`, `session_info_update`) have no faithful CrewCoder shape. This
is the same policy `src/acp/event-translator.ts` applies in the opposite direction:
drop rather than force-fit.

### Cost is deliberately discarded

`usage_update.cost` is documented by ACP as the **cumulative session total**. The
CrewCoder cost ledger appends **per-turn** amounts. Feeding a running total into a
per-turn ledger overstates spend on every turn after the first, so `costUsd` is never
set from this runtime. A Grok CLI turn therefore reports as `unpriced` unless a rate
is configured in `config.modelPricing` — which is the honest answer, since free and
unknown are different facts.

## Approvals

The remote agent asks with `session/request_permission`. CrewCoder maps that onto
`ModelStreamCallbacks.requestQuestion`, the same interactive channel the Claude Agent
SDK provider uses for `AskUserQuestion`.

**With no interactive host attached, the request is rejected**, not allowed. A
detached or CI run must not silently grant a remote agent permission to mutate the
workspace. The selected reject option is preferred over cancelling so the agent gets
a decision it can act on rather than an aborted turn.

## Filesystem authority

CrewCoder advertises `fs: { readTextFile: true, writeTextFile: true }` so the agent
routes text I/O back through us instead of touching disk directly. `authorizePath()`
resolves every requested path and requires it to sit inside the session `cwd` or one
of `ModelInput.externalDirectories`; anything else returns a JSON-RPC invalid-params
error. The agent is a separate process we do not control, so its paths are untrusted
input.

`terminal: false` is advertised honestly — the runtime does not implement
`terminal/*`, so the agent runs shell commands in its own process.

## Failure policy

Provider failures are terminal and must never render as assistant text:

```txt
missing binary (ENOENT)     -> "<command> not found on PATH. Install the <title> CLI first."
stopReason refusal/cancelled -> exitCode 1
turn with no assistant text  -> exitCode 1 ("returned no assistant output")
transport/JSON-RPC throw     -> exitCode 1, stderr tail attached
```

An empty successful turn is a protocol failure, not an empty reply — the same rule
Codex follows. `stderr` from the child is appended (last 2 KB) so an auth or install
error is visible instead of being swallowed.

## Sessions

The agent's own session id is persisted through `onProviderSessionId` into
`providerSessionIds.grok` and replayed as `session/load` on the next turn, so the
agent keeps its native history. A failed load **falls back to a new session** rather
than failing the run — a stale id normally just means the agent pruned its store.

When starting fresh with existing CrewCoder history, prior messages are encoded as
JSON Lines into the first prompt (the same approach as the Claude Agent SDK
provider). When the agent already holds the session, only the new user turn is sent.

## Tests

`src/tests/acp-client-provider.test.ts` drives a real fake ACP agent
(`src/tests/fixtures/fake-acp-agent.mjs`) over actual stdio JSON-RPC — no mocked
transport. It covers streaming, tool activity, usage/cost policy, both approval
paths, fs containment and escape denial, session load and load-failure fallback,
empty/refusal failures, and the missing-binary message.

## Verified against the real Grok CLI

`grok 0.2.118`, signed in to grok.com, confirmed end to end:

```txt
spawn        grok agent --model grok-4.5 stdio
initialize   protocolVersion 1
session/new  -> 019fcef0-...  (captured via onProviderSessionId)
thinking     agent_thought_chunk streams token by token
assistant    agent_message_chunk streams token by token
tool call    read_file { target_file } -> completed, result text intact
exit         0
```

**Known gap: Grok emits no `usage_update`.** `result.usage` comes back `undefined`, so
this provider reports no context tokens. Consequences: token-triggered
auto-compaction never fires for `grok` (it reads `currentContextTokens`), and the
cost ledger has nothing to record. The CLI manages its own context internally, so
sessions still work — but CrewCoder is flying blind on occupancy. Do not paper over
this with an estimate; an invented token count is worse than a missing one.

Reproduce the smoke test by calling `runAcpClientProvider` directly with a real
`cwd`. It is deliberately **not** in the suite: it needs a logged-in CLI and spends
real tokens, so it cannot run in CI.

## Adding another ACP agent

Add a builtin with `runtime: "acp-client"` and the command that starts its stdio
agent mode. No adapter code is needed; the runtime is generic. Verify the agent
implements `session/load` before relying on session reuse, and check whether it
honors `session/set_model` (the call is best-effort and a rejection is logged, not
fatal).
