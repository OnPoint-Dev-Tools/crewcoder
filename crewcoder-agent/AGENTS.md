# AGENTS.md

## Project identity

This package is **CrewCoder**, a standalone coding agent CLI.

DISCLAIMER:
crewcoder and crewcode are 2 different apps, CrewCoder harness has knowledge and plugin logic for crewcode, but everything else is for 'CrewCoder or crewcoder' dont get it confused, if you in doubt double check with me

CrewCoder should become a best-in-class coding agent with:

```txt
- evented agent loop
- durable sessions
- built-in providers
- local coding tools
- CrewCoder extension architecture
- CrewCode app plugin generation
```

## CLI aliases

The agent package maps `crewcoder`, `cc`, and `crewcoder-agent` to the same CLI entrypoint. Keep `cc` behavior identical to `crewcoder`, including no-argument TUI launch and all argument-bearing backend commands.

## Project structure

```txt
crewcoder-agent/
├── AGENTS.md
├── README.md
├── package.json
├── tsconfig.json
├── .npmrc
├── scripts/
│   └── ensure-bin-executable.cjs
├── docs/
│   └── contributor/
│       ├── ROADMAP.md
│       └── TUI_BACKEND_CONTRACT.md
├── src/
│   ├── cli.ts
│   ├── core/
│   │   ├── agent.ts
│   │   ├── agent-loop.ts
│   │   ├── agent-loop-continue.ts
│   │   ├── approval.ts
│   │   ├── backend-debug-logger.ts
│   │   ├── browser-opener.ts
│   │   ├── config.ts
│   │   ├── crewcode-repo.ts
│   │   ├── crewcoder-home.ts
│   │   ├── events.ts
│   │   ├── json-event-stream.ts
│   │   ├── messages.ts
│   │   ├── model-client.ts
│   │   ├── mode-router.ts
│   │   ├── repo-inspector.ts
│   │   ├── session-branch.ts
│   │   ├── session-compaction.ts
│   │   ├── session-loader.ts
│   │   ├── session-store.ts
│   │   ├── session-why.ts
│   │   ├── system-prompt.ts
│   │   ├── tool-schema.ts
│   │   ├── tool-types.ts
│   │   ├── types.ts
│   │   └── usage.ts
│   ├── extensions/
│   │   ├── extension-loader.ts
│   │   ├── extension-registry.ts
│   │   └── types.ts
│   ├── generators/
│   │   ├── extension-generator.ts
│   │   ├── plugin-generator.ts
│   │   └── template-registry.ts
│   ├── knowledge/
│   │   ├── constraints.ts
│   │   ├── crewcode-docs.ts
│   │   ├── crewcoder-extension-docs.ts
│   │   └── extension-constraints.ts
│   ├── modes/
│   │   ├── general-coding-mode.ts
│   │   ├── plugin-architect-mode.ts
│   │   └── index.ts
│   ├── plugins/
│   │   └── crewcoder-provider/
│   │       └── crewcode.plugin.json
│   ├── providers/
│   │   ├── auth-store.ts
│   │   ├── builtins.ts
│   │   ├── codex-provider.ts
│   │   ├── http-provider.ts
│   │   ├── model-registry.ts
│   │   ├── model-resolution.ts
│   │   ├── oauth-codex.ts
│   │   ├── openai-responses-provider.ts
│   │   ├── output-parser.ts
│   │   ├── process-provider.ts
│   │   ├── provider-model-client.ts
│   │   ├── provider-registry.ts
│   │   ├── types.ts
│   │   └── websocket-provider.ts
│   ├── skills/
│   │   ├── crewcode/
│   │   │   └── index.ts
│   │   ├── crewcoder-extension/
│   │   │   └── index.ts
│   │   ├── general/
│   │   │   └── index.ts
│   │   └── types.ts
│   ├── tests/
│   │   ├── agent-loop.test.ts
│   │   ├── auth-store.test.ts
│   │   ├── browser-opener.test.ts
│   │   ├── codex-provider.test.ts
│   │   ├── crewcoder-home.test.ts
│   │   ├── extension-loader.test.ts
│   │   ├── http-provider.test.ts
│   │   ├── mode-router.test.ts
│   │   ├── openai-responses-provider.test.ts
│   │   ├── output-parser.test.ts
│   │   ├── process-provider.test.ts
│   │   ├── provider-registry.test.ts
│   │   ├── template-registry.test.ts
│   │   ├── usage.test.ts
│   │   ├── validate-plugin.test.ts
│   │   └── websocket-provider.test.ts
│   └── tools/
│       ├── bash.ts
│       ├── create-extension-tool.ts
│       ├── create-plugin-tool.ts
│       ├── docs.ts
│       ├── edit.ts
│       ├── grep.ts
│       ├── index.ts
│       ├── list-files.ts
│       ├── list-templates-tool.ts
│       ├── path-utils.ts
│       ├── read.ts
│       ├── validate-plugin-tool.ts
│       ├── validate-plugin.ts
│       └── write.ts
├── dist/              # Build output
└── node_modules/      # Dependencies
```

## State directory

CrewCoder owns:

```txt
/.crewcoder
```

Fallback:

```txt
~/.crewcoder
```

Override:

```bash
CREWCODER_HOME=/custom/path
```

Layout:

```txt
/.crewcoder/config.json
/.crewcoder/sessions
/.crewcoder/extensions
/.crewcoder/cache
/.crewcoder/logs
```

Do not store CrewCoder extensions under `/.crewcode`.

## Keep systems separate

```txt
1. Built-in providers
   - codex
   - claude
   - opencode

2. CrewCoder extensions
   - manifest: crewcoder.extension.json
   - location: /.crewcoder/extensions
   - purpose: extend CrewCoder itself

3. CrewCode app plugins
   - manifest: crewcode.plugin.json
   - templates: /CrewCode/examples/plugins
   - purpose: extend the CrewCode desktop app
```

## Provider architecture

Built-ins are not plugins. They live in `src/providers` and are first-class provider adapters.

Users add additional providers through CrewCoder extensions.

Thinking/reasoning stream behavior is part of the provider contract:

```txt
Provider stream callback:
  ModelStreamCallbacks.onThinkingDelta -> AgentEvent thinking_delta -> TUI thinking block
```

Do not remove this path when refactoring providers. Never suppress reasoning a provider exposes. Forward partial deltas and, when only completed reasoning blocks are available, forward those without duplicating already-streamed text.

Provider failures are terminal and must never render as assistant text:

```txt
provider failure -> exitCode !== 0 (or SSE `error` event on a 200)
                 -> AssistantMessage { stopReason: "error", errorMessage }
                 -> agent loop sets AgentLoopResult.providerError and breaks the loop
                 -> CLI prints to stderr and sets process.exitCode = 1
```

A billing/auth/network failure rendered as a successful reply is a bug of the same class as a
tool call returned as plain JSON text. `providerErrorMessage()` in `src/providers/output-parser.ts`
is the single place that turns a provider error payload into a readable message; keep error
envelopes (`{type:"error"}` / `{error:{...}}`) out of the assistant-text path. Guarded by
`src/tests/output-parser.test.ts`, `src/tests/http-provider.test.ts`, and `src/tests/agent-loop.test.ts`.

Provider-specific notes:

```txt
Codex / OpenAI Responses:
- ChatGPT OAuth Codex requests must follow the current first-party Codex CLI contract: `originator: codex_cli_rs`, event-stream accept header, session/thread metadata, `tool_choice: auto`, and `prompt_cache_key`. GPT-5.6 access is rejected as “Model not found” when sent through the legacy CrewCoder header/body contract.
- Request reasoning summaries with reasoning: { effort, summary: "auto" }.
- Keep include: ["reasoning.encrypted_content"] for stateless reasoning continuity.
- Reasoning summaries may arrive as:
  - response.reasoning_summary_text.delta
  - response.reasoning_summary.delta
  - response.reasoning_text.done / response.reasoning_summary_text.done
  - response.completed response.output[] reasoning items
  - response.output_item.done item.type === "reasoning"
- Never treat reasoning token usage as proof the UI received a summary; usage can show reasoning_tokens while no summary was emitted.
- If successful Codex output leaks raw SSE `data:` lines, normalize it back into CrewCoder assistant JSON before returning.
- HTTP 200 does not prove a successful Codex turn: SSE `error`, `response.failed`, and `response.incomplete` events are terminal provider failures. A stream ending without assistant text, tool calls, or completion metadata is also a provider/protocol failure, never a successful `(empty Codex response)` placeholder.
- Codex primarily uses official app-server durable threads stored under CrewCoder's isolated Codex home. Persist only the encoded thread/contract identifier in `providerSessionIds.codex`; never auth tokens. App-server native capabilities stay read-only and CrewCoder mutations route through dynamic tools. The direct connection-cached WebSocket and stateless SSE transports are guarded fallbacks; never replay after app-server `turn/start` has been sent.
- Provider protocol and physical transport are separate contracts. Famous providers use maintained built-in payload/auth adapters; extensions may select only vetted generic runtimes and must never access credential-owning adapters such as ChatGPT OAuth Codex.

Claude Agent SDK:
- `claude` is the local-login Agent SDK provider; `anthropic` remains the direct API-key Messages provider.
- Keep `settingSources: ["project"]`, `skills: []`, and `strictMcpConfig: true`: preserve project CLAUDE.md guidance without global skill/MCP bloat.
- Tool ownership is hybrid. Native Claude is limited to Read/Grep/Glob/AskUserQuestion; Bash, mutations, and specialized tools must route through the in-process CrewCoder MCP server and existing executor.
- Disable native Read/Grep/Glob whenever a virtual `TextFileHost` is active (especially ACP SSH/SFTP); route those operations through CrewCoder MCP so the local Claude process cannot cross host boundaries.
- Persist returned SDK session ids in `providerSessionIds.claude`; never substitute the CrewCoder session id or send Claude ids to another provider.
- Preserve assistant/thinking deltas, native read/search tool activity, cancellation, and CrewCoder MCP tool lifecycle events.
- Unlike every other provider, one SDK call runs a full internal loop and emits multiple assistant text blocks. Separate them with a blank line in the returned text; hosts must not re-render that concatenation on top of the already-streamed segments (see `crewcoder-tui/AGENTS.md`).

ACP client (`acp-client` runtime, Grok CLI):
- `grok` spawns `grok agent stdio` and drives it as an ACP **client**; `src/acp/*` is the opposite half (CrewCoder as agent). Do not conflate them.
- An ACP agent is a nested full agent, not a model endpoint: it owns its own tool loop, so CrewCoder's `availableTools` are intentionally unused here. Use `xai` (XAI_API_KEY, `openai-chat-completions`) when you want Grok models under CrewCoder's own tool loop.
- `grok` model ids come from `grok models` on a logged-in CLI, NOT from docs and NOT from `xai`. Verified list is `grok-4.5`. There is no `grok-build` model — "Grok Build" is the CLI product name. Never sync the `grok` and `xai` model lists.
- Model/effort are spawn flags (`grok agent --model X stdio`), not `session/set_model`. Flag order is load-bearing: the `stdio` subcommand rejects `--model`, so flags go between `agent` and `stdio`. ACP 1.x dropped the model API, so a `session/set_model` rejection would silently leave the agent on its own default.
- Grok emits no `usage_update`, so `grok` reports no context tokens: auto-compaction cannot trigger and the cost ledger gets nothing. Do not substitute an estimated token count.
- `usage_update.cost` is a CUMULATIVE session total and must never be written to the per-turn cost ledger; only `used` is kept, as `contextTokens`.
- Permission requests route to `requestQuestion`; with no interactive host the request is REJECTED, never auto-allowed.
- `fs/read_text_file`/`fs/write_text_file` are served by CrewCoder with path containment to `cwd` + `externalDirectories`. The agent is an untrusted separate process.
- `acp-client` is deliberately excluded from `EXTENSION_RUNTIMES`; it hands a spawned binary an fs write channel and has not been vetted for arbitrary third-party agents.
- Empty turns and `refusal`/`cancelled` stop reasons are provider failures, not replies. See `docs/ACP_CLIENT_PROVIDER.md`.

There is no `groq` builtin. Groq (LPU inference, `api.groq.com`, `GROQ_API_KEY`) was removed by owner request; it is a different company from xAI and was never a misspelling of `grok`. Do not "restore" it by renaming `grok`, and do not treat `grok`/`xai` as typos for it. The two Grok providers are `xai` (HTTP API, `api.x.ai`, `XAI_API_KEY`) and `grok` (Grok CLI over ACP stdio). Groq can still be reached as an extension provider on the `openai-chat-completions` runtime.

OpenAI-compatible provider family:
- `openai-chat-completions` is a checked HTTP/SSE runtime for OpenRouter, xAI, DeepSeek, Mistral, and extension gateways. Select it by runtime, never by model-name heuristics for new providers.
- Preserve streamed reasoning fields, function-call argument deltas, final usage chunks, multimodal `image_url` input, and HTTP-200 error envelopes.
- Do not opt a provider into WebSocket because it offers an unrelated realtime/voice socket; agent-grade continuation and replay safety must be implemented and tested explicitly.

OpenCode / Anthropic-compatible:
- Use the anthropic-messages runtime in src/providers/http-provider.ts.
- Request stream: true so text_delta and thinking_delta events can reach the TUI.
- Enable provider thinking only when effort is not none/off.
- Streamed Anthropic/OpenCode output from `readHttpMessagesStream` is already CrewCoder assistant JSON. Do not pass it back through `anthropicResponseToCrewCoderAssistantJson`; that turns real `toolCall` parts into plain JSON-looking assistant text and ends the turn before tools run.
```

## Image input (vision)

User messages can carry image parts for vision-capable providers.

```txt
ImagePart          -> core/messages.ts { type:"image", mime, path, width?, height? }
transport          -> `crewcoder run|session resume --image <path>` (repeatable)
                      -> AgentRequest.images -> withImageParts() on the user message
serialization      -> provider adapters read the file + base64 at request time
```

- `renderMessagesForModel` must preserve image parts when it merges `background`
  into the user text; only the text is rewritten.
- Encoded per runtime: `anthropic-messages` -> Anthropic `image`/base64 (or OpenAI
  chat `image_url` for OpenAI-shaped models); `openai-responses` and
  `openai-codex-responses` (codex) -> Responses API `input_image` data URI.
- Codex image input is additive: it adds an `input_image` content part to the user
  turn only. It does NOT change the sensitive ChatGPT OAuth contract (originator,
  headers, model access, session/thread metadata, tool_choice, prompt_cache_key) —
  keep those intact when touching codex.
- Image parts store the on-disk `path`, not base64, so session records stay small;
  the TUI persists pasted screenshots under `~/.crewcoder/cache/images`.

## Images in tool results

Any tool can declare images on its result and the TUI blits them inline under that
tool's output:

```txt
ToolResult.details.images[] = { path (absolute), displayPath, mime, byteSize }
  -> mergeToolMetadata -> `tool_execution_end` event `metadata`
  -> TUI reducer -> `image` block -> existing terminal graphics layer
```

`src/core/tool-images.ts` owns `detectImageMime` (magic bytes only — file extensions
lie and are absent on generated temp files), `describeToolImage`, and
`describeToolImageForModel`. It deliberately reports only mime + byte size; pixel
dimensions are sniffed by the renderer, which is the side that needs them.

The `read` tool checks for an image **before** reading: an image returns a short
description plus `details.images` instead of `buffer.toString("utf8")`. Do not
restore the old path — reinterpreting a 215 KB PNG as UTF-8 filled the context with
unusable garbage and billed real tokens for it. The model cannot see pixels through
a tool result, so it gets an honest description; the user sees the actual image.

## Extension architecture

CrewCoder extensions live at:

```txt
/.crewcoder/extensions/<extension-id>/crewcoder.extension.json
```

CrewCoder extensions are capability-based packages, not categorized starters. Do not reintroduce extension kinds like `provider`, `skill-pack`, or `prompt-pack` as the core model; one extension can declare any combination of contribution points.

Extensions are acquired with `crewcoder extension install <owner/repo|url|path>` (`src/extensions/extension-install.ts`). Install stages into a temp dir, validates the manifest there, and only then places the package at `<home>/extensions/<manifest.id>` — the directory name must equal `manifest.id` because trust/enable/`getExtensionDir()` all key off it. **Install never grants trust**: everything executable stays inert at the default `prompt-only` tier until `crewcoder extension trust <id> --tier ...`. Do not auto-trust on install and do not drop the printed capability summary; that summary is the only thing standing between `install` and running third-party code. See `docs/EXTENSION_INSTALL.md`.

Discovery is a separate, additive layer: `crewcoder extension search` over JSON registry indexes. The first-party registry (`DEFAULT_EXTENSION_REGISTRY` = `https://crewcoder-extensions.cortex-ai.icu/v1/index.json`, source in the separate `crewcoder-extensions` repo) is searched by default, plus any extras in `config.extensionRegistries`. It is a **flag** (`useDefaultExtensionRegistry`) rather than a seeded array entry because `config.json` is written on first read, so a seeded default would only reach installs created after that build. Keep the `/v1/` path segment: `RegistryIndex.version` is a hard gate, so a v2 format must live at `/v2/` while `/v1/` keeps serving old clients. `src/extensions/extension-registry-index.ts` resolves a **bare name** to a source spec and hands it to the existing install pipeline; anything containing `/`, `\`, `:`, a leading `.`/`~`, or passed via `--from` never touches a registry, so an explicit spec can never be redirected. First match wins and user registries sort before the built-in, so a private index can shadow a first-party id. `extension update` reinstalls from the recorded resolved `spec`, not the registry, so a later index edit cannot hijack an update. Remote indexes cache for 6h under `<home>/cache/registries`; a failed refetch serves the stale cache and says so, and a broken registry never breaks search across the others. A registry hit grants nothing — install still validates and stays prompt-only. See `docs/EXTENSION_REGISTRY.md`.

Supported contract contributions:

```txt
providers
skills
promptPacks
tools
commands
workflows
contextProviders
validators
approvalPolicies
hooks
ui
future/custom contribution points
```

Active today: providers, skills, promptPacks, commands, workflows, hooks, approvalPolicies, fileTriggers, and trusted tools.

`hooks` fire on `context`, `beforeToolCall`, `afterToolCall`, and `onError` (`src/extensions/extension-hooks.ts`, wired in `src/core/agent-loop.ts`). `beforeToolCall` can `allow`/`block`/`modify`; the other events are advisory context. `onError` runs only when `result.isError` and before `afterToolCall`, so extensions can subscribe to failures without inspecting every success. The declarative `matches: { tools, paths, commands }` filter gates which tool calls a hook sees — **an omitted/empty `matches` matches everything**, which is what keeps pre-existing hooks behaving unchanged. Hooks and `approvalPolicies` share `src/extensions/tool-call-matcher.ts` so pattern semantics cannot drift; note the intentional asymmetry, a policy with no matchers never matches while a hook with no matchers always matches. Hooks need `allowExtensionHooks=true` **and** the full `trusted` tier (not `sandboxed`). Inspect live hooks with `crewcoder extension hooks`. `compaction` hooks run on a prepared-but-uninstalled compaction proposal and may `summary`-replace or `append` to it; they chain (each sees the prior hook's summary) and run BEFORE the human preview so `/compact preview` shows the final text and a manual edit still wins. A failed or silent compaction hook leaves the summary untouched — compaction must never break because a hook misbehaved. See `docs/EXTENSION_HOOKS.md` (distinct from `docs/REACT_HOOKS.md`, which is unrelated React/Electron UI guidance).

`workflows` are deterministic linear sequences of `tool` and `prompt` steps (`src/extensions/extension-workflows.ts`), run with `crewcoder workflow list|show|run`. `workflow show` renders the exact plan before execution — that reviewability is the point of the contribution point, so keep it. Trust split: prompt-only workflows run at any tier because the agent's own approval gates still apply; any workflow with a `tool` step needs `sandboxed`/`trusted`, because a tool step executes with fixed args and no model judgement. Tool steps count a non-zero `details.exitCode` as failure, not just a thrown error — without that, a `bash`-wrapped `npm test` step always looks successful and every `when`/`onFailure` guard becomes meaningless. Keep the step grammar boring: linear steps, `steps.<id>.ok|failed` guards, `stop|continue` failure policy, `{{steps.<id>.output}}` templating. No loops or arithmetic. See `docs/WORKFLOWS.md`. Extension `commands` are reusable prompt commands exposed through `crewcoder command list/show` and TUI `/commands` as `ext.<extension-id>.<command-id>`. Extension tools must remain disabled unless both `allowExtensionTools=true` and the extension id is in `trustedExtensions`. Tool names are namespaced as `extension_<extension-id>_<tool-id>` and commands execute without a shell.

Enabled-extension `skills` and `promptPacks` are activated by the prompt composer
(`src/extensions/extension-activation.ts`) and composed into the system prompt:

```txt
skills       -> activate when a trigger appears in the prompt; activated skill `prompt`
                bodies are injected, all enabled skills are listed as available metadata
promptPacks  -> a prompt activates when the pack/prompt id or title is referenced in the
                prompt; `file` references are resolved relative to the extension dir
```

Activation is deterministic (case-insensitive substring matching) so it stays testable
(`src/tests/extension-activation.test.ts`). `runAgentLoop` returns the activated
contribution ids on `AgentLoopResult.activatedExtensions` (also merged into `activatedSkills`).

## Durable goals (`/goal`)

Detached goals are provider-independent CrewCoder orchestration. `src/core/goal-store.ts` owns atomic records under `~/.crewcoder/goals`; `src/core/goal-runner.ts` owns detached supervision, worker locking, continuation cycles, and durable approval decisions. Never move this behavior into `codex-provider.ts` or forward `/goal` text expecting the Responses endpoint to interpret it.

Without a configured checker, a goal completes only through the host-owned `complete_goal` tool with non-empty validation evidence. With `config.goals.checkModel`, the same-provider tool-free verifier runs after every successful supervisor cycle and its strict `continue|complete` verdict is authoritative; never silently fall back to maker self-grading after verifier failure. `maxTurns` counts supervisor cycles, while `timeoutMinutes` is wall-clock from initial creation. `pause_goal`, provider/verifier errors, limits, token budgets, explicit caps, and stalls pause recoverably. Approval-required tools set `awaiting_approval`; the detached worker remains blocked until `crewcoder goal approve|deny` supplies a durable decision. Do not auto-approve detached work. See `docs/DURABLE_GOALS.md`.

## Repository rules

CrewCoder loads repository-owned `.crewcoder/rules/**/*.md` through `src/core/rules-store.ts`. Files without frontmatter always apply; optional YAML `paths` lists activate scoped rules from a bounded workspace inventory. Rules are injected only as initial user-message background, not as executable hooks. Keep deterministic ordering (always-on before scoped), symlink/generated-directory exclusions, and file/context caps. Never auto-import `~/.claude/rules` or global personal rules into repositories. See `docs/REPOSITORY_RULES.md` and `docs/INSTRUCTION_LAYERS.md`.

## Agent loop ownership

Providers only answer: how to get the next assistant message.

The agent loop owns:

```txt
messages
tool calls
tool execution
events
sessions
mode routing
skills
docs retrieval
mutation log
validation continuation
```

Long-running behavior is non-negotiable. When an assistant response has `stopReason: "tool_calls"` and real `toolCall` parts, `src/core/agent-loop.ts` must execute those tools, append tool results, and continue the loop until the model produces a final answer or a real stop condition is hit. A provider returning JSON text that merely looks like a tool call is a bug, not an acceptable final response.

Parallel tool calls use two explicit gates. Providers/models advertise `parallelToolCalls` (model metadata overrides the provider default), and tools opt in with `executionMode: "parallel"`; missing values fail closed. The scheduler runs only adjacent parallel-safe calls concurrently, treats every sequential call as a barrier, and appends results in original model order. Mutations, extension command tools, approvals with shared state, and unknown tools stay sequential. Event/hook consumers must correlate interleaved parallel lifecycles by `toolCallId`. See `docs/PARALLEL_TOOL_CALLS.md`.

Review workflow issue-provider integrations are currently type/config-only (`src/core/git-workflow.ts`, `docs/REVIEW_WORKFLOW.md`). Do not add network, auth, token storage, or remote fetching until that provider boundary is explicitly designed.

Core files:

```txt
src/core/agent.ts
src/core/agent-loop.ts
src/core/events.ts
src/core/messages.ts
src/core/model-client.ts
src/core/session-store.ts
src/core/system-prompt.ts
src/core/tool-types.ts
```

Long-running session context:

```txt
src/core/repo-inspector.ts       -> cwd/repo/package/git context
src/core/session-compaction.ts   -> deterministic compacted background for resumed sessions
                                    + compactLiveMessages() token-triggered LLM compaction (fallback to deterministic)
src/core/usage.ts                -> per-model usage (byModel), lastInputTokens, currentContextTokens()
src/core/messages.ts             -> user message background metadata and provider-facing rendering
```

User-message `background` is deliberate. It should be passed to the model and visible in the TUI as background context, but it is not typed user text.

Interactive approvals are part of the live JSON-events control channel. `src/core/stdin-control.ts` accepts `{"type":"control","action":"approval","approvalId":"...","approved":true|false}` and `src/core/agent-loop.ts` waits for matching decisions when an approval signal is available. Do not replace this with saved-session polling; approvals must control the active run.

## Session durability

Sessions are saved **after every completed turn**, not just at the end of the run
(`persistTurn` in `src/core/agent-loop.ts`), plus once on `agent_error` before the
rethrow. Only the final save emits `session_saved`; incremental saves are silent so the
event contract is unchanged. Do not regress this to a single end-of-run save — that made
any `/stop`, Ctrl+C, provider failure, or crash discard the whole transcript, including
tool results for files already written to disk. The append-only delta store makes a save
cost ~2ms, so frequency is not a budget concern.

Incremental saves are best-effort (failure degrades to a `backend_debug` warn) because
killing a working run over a disk write is worse than losing durability; the final save is
strict. `installSignalFlush()` in `cli.ts` drains in-flight writes on SIGTERM/SIGINT before
exiting, because a JSONL append is not atomic and one truncated line makes a session
unreadable. A second signal exits immediately — the user insisting outranks the flush.
See `docs/SESSION_DURABILITY.md`.

## Session listing is header-only

Listings (`/sessions`, `crewcoder sessions`, `session list`, SDK admin) read **only the first JSONL line** of each session via `listSessionHeaders()`; every field they render lives in the `session` header entry. Never regress a listing to `listAllSessions`/`listSessions`, which fully parse messages, events, mutation logs, and model turns — those exist for replay, search, and export.

Two stacked O(store-size) bugs used to make `/sessions` slow: the full parse ran before the `cwd` filter (so a project with zero sessions still paid for all of them), and `printSessions` serialized whole `SessionRecord`s to JSON for the TUI to re-parse. Measured on 511 sessions / ~570 MB: listing 4241ms -> 183ms, and `session list --json` 7.77s/268MB -> 0.85s/64KB.

The header is written once and never rewritten, so it records the provider/model the session **started** on. Last-run `provider`/`model`/`effort` live in the fixed-size `runtime.json` sidecar beside `session.jsonl`, rewritten only when those values change, and overlaid onto both the full load and the header-only listing. That is what makes a resume continue on the settings the session was last run with instead of snapping back to its first ones. Keep the sidecar small enough that listings stay O(1) per session, keep it in `session-prune`'s `SESSION_FILES` (it is state, not an artifact), and keep it degrading to the header when it is missing or malformed. See `docs/SESSION_STORAGE.md`.

`messageCount` is the only summary field absent from the header, so it is opt-in via `includeMessageCount` and `toSessionSummary` must not derive it from a header record — that would report a confident `0` instead of an honest "not loaded", the same class of bug as `$0.00` for an unpriced model. Keep the header as the first line of `session.jsonl`. See `docs/SESSION_LISTING.md`.

`crewcoder session prune` (`src/core/session-prune.ts`) is the only sanctioned bulk deletion path for session data. It is **dry run unless `--apply`** and must never become automatic or gain an interactive prompt (a prompt breaks CI and trains reflexive `y`). `--artifacts` is the safe default because nothing it removes is reachable by any code path; `--checkpoints` and `--sessions` hard-error without `--older-than`, because a bare `--sessions` would otherwise wipe the store. Age comes from the header `startedAt`, never mtime — session files are rewritten on every save, so mtime measures last touch, not age. Targets are re-validated at delete time (inside the sessions dir, not the dir itself, not a symlink) because the plan is a mutable plain object; symlinks are refused, not followed. Failures are per-target so one bad path never abandons the rest. See `docs/SESSION_PRUNE.md`.

## Reproducible runs and searchable history

Provider-produced assistant messages carry stable `id`, `promptHash`, and `responseHash` fields. Exact per-turn `ModelInput` payloads are persisted in `SessionRecord.modelTurns`; do not rebuild or normalize them in `run --replay`, because byte-equivalent logical input is the reproducibility contract. `crewcoder search` scans durable message text and these hash identifiers. See `docs/REPRODUCIBLE_RUNS_AND_SEARCH.md`.

## Decision explanations (`/why`)

`crewcoder session why <id>` explains the agent's last decision in plain language, and TUI `/why`
renders it. It is a **one-shot model call outside the session**: it loads the durable record,
reconstructs the last assistant turn (request, reply, tool calls + results, changed files), and
calls the model with `availableTools: []`. It must never be turned into a prompt injected into the
live session — asking for an explanation must not add turns the next real turn would see, and the
explainer must not be able to run tools. Model failure degrades to a deterministic transcript
readout with `source: "transcript"` plus a `fallbackReason`; keep the two visually distinct
everywhere, for the same reason as the compaction summarizer. See `docs/WHY_COMMAND.md`.

## Token cost ledger

Every billed model turn is appended to `<home>/logs/cost.jsonl` from the agent loop's
`onUsage` hook, and `crewcoder cost` reports USD spend plus the full token breakdown
(`--today`, `--since`, `--by-model`, `--by-provider`, `--by-worker`, `--by-session`,
`--by-day`, `--json`). Rates resolve from `config.modelPricing` (`provider:model`, then
bare `model`) before the OpenRouter catalog, which now caches pricing alongside context
windows at cache `version: 2`.

An unpriced model must report as `unpriced`/absent `costUsd`, never `$0.00` — free and
unknown are different facts. A ledger write failure degrades to a `backend_debug` warning
and must never break a run. Cache accounting depends on `TokenUsage.cachedInputIncluded`,
set where the field is read (`prompt_tokens_details.cached_tokens` is inside
`inputTokens`; `cache_read_input_tokens` is alongside it) — do not replace it with a
numeric heuristic. Reasoning tokens live inside output tokens and are never billed twice.
See `docs/COST_LEDGER.md`.

## Model diff (`diff-models`)

`crewcoder diff-models <prompt> --models codex:gpt-5.6,opencode:claude-sonnet-4-6` races one
prompt across N models and reports response, cost, and latency. Like `session why`, it is a
**one-shot call per candidate with `availableTools: []` and no session write** — it must never
become an agent run or gain tools. Candidates run in parallel by default (`--sequential` when
measuring latency).

`--models` only treats `provider:` as a provider prefix when the left side is a **known provider
id**, because model ids contain colons (`qwen-2.5:free`); do not replace that with punctuation
splitting. A failed candidate is reported as a failed row and the command exits `1`, so one dead
provider never hides the others. Unpriced models read as `unpriced`, never `$0.00`. These are real
billed turns, so they are appended to the cost ledger unless `--no-ledger` is passed.
See `docs/contributor/MODEL_DIFF.md`.

## Auto-compaction & context tracking

Optional, token-aware mid-session compaction. See `docs/AUTO_COMPACTION.md` for the full contract. ACP must respect the same persisted `autoCompact` setting as every other host. Never force compaction or automatically rewrite/retry a session after provider context overflow when the setting is off; surface the error and require explicit `/compact`.

The LLM summarizer falls back to the deterministic transcript summary on any failure, and that fallback must never block the loop — but it must never be silent either. `summarizeWithModel` records a `fallbackReason` on all three failure paths (thrown error, `stopReason: "error"` response, empty text); it is surfaced as a `backend_debug` warn in the loop, a yellow line and a `fallbackReason` JSON field in `session compact`, and in the compaction-hook payload. Do not restore the bare `catch {}` — a degraded summary caused by expired auth is otherwise indistinguishable from a healthy one, and the only symptom is the agent quietly getting worse after long sessions.

```txt
config keys:   autoCompact (default false), autoCompactThresholdTokens (default 150000, clamp 10k-2M)
trigger:       currentContextTokens(usage) >= threshold, measured on the latest turn's input tokens
                (live context-window size, NOT cumulative lifetime spend); reset to 0 after a compaction
summary:       LLM-generated via the active model client, deterministic fallback if the call fails
events:        reuses session_compacted + SessionCompaction[] (no event-stream/schema changes)
manual:        crewcoder session compact <id>; TUI /compact, /compact on|off|status
```

Do not change `currentContextTokens` to use cumulative `totalTokens` as the primary metric — the
live `lastInputTokens` is what reflects real context-window pressure.

The retained window is snapped to a tool-group boundary by `retainedStartIndex()`; never regress it
to a bare `slice(-keepRecentMessages)`. A retained `toolResult` whose tool call was compacted away
serializes as an unmatched `function_call_output`/`tool_result`, and Codex answers that with an
empty stream — reported as "Codex stream ended without assistant text, tool calls, or completion
metadata" and repeated on every later resume. Every Responses/Messages-shaped provider adapter
(`codex-provider`, `websocket-provider`, `openai-responses-provider`, `http-provider`) keeps the
matching orphan guard, degrading an unmatched tool result to plain historical context.

Core tool output is a context-safety boundary, not just display formatting. `grep` caps each matching line at 500 characters and aggregate output at 50 KB; a match-count limit alone is insufficient because one generated/minified line can be multiple megabytes. `read` uses 50 KB/2,000-line head truncation with offset/limit continuation, `bash` keeps a labeled 50 KB/2,000-line tail, and `listFiles` is sorted with count plus byte limits. Truncation must always be explicit and actionable. A non-`replaceAll` `edit` target must be unique so the agent cannot silently mutate the wrong duplicate. CrewCoder deliberately does not persist full shell output to an implicit temp file because tool output can contain secrets. See `docs/TOOL_OUTPUT_SAFETY.md`.

## CrewCode app plugin testing

`crewcoder plugin test <dir>` executes a CrewCode app plugin in a sandboxed host and
checks it against plugin API v0. It complements `plugin validate` (static manifest
checks) by catching what only exists at runtime — above all a **permission mismatch**,
where a statically valid manifest omits a permission the plugin's code actually needs.

`src/core/plugin-host-contract.ts` is a deliberate port of CrewCode's
`src/main/plugin-contract.ts`, **including the exact error strings**. Do not
paraphrase them: a harness that denies a call for a different reason, or with a
different message, than the real host teaches plugin authors the wrong contract.
When CrewCode's contract changes, that file changes with it.

Plugin code runs in a `worker_threads` worker with `env: {}` (untrusted code must not
read the operator's keys out of `process.env`), a memory cap, and a per-entry timeout.
The worker source ships as a string via `new Worker(code, { eval: true })` because a
sibling-file path breaks between `src/` under vitest and `dist/` after a build.

The sandbox is a **stub DOM, not a browser**. Errors caused by browser APIs it does not
implement are classified as `unsupported-dom-api`/`framework-panel-unsupported`
**warnings**, never errors, against a deliberately narrow allowlist — the first build
failed 2 of 14 official example plugins for missing `navigator.clipboard` and
`MutationObserver`, and a tool that fails healthy plugins gets ignored. Keep the
allowlist narrow so a genuine bug (`myTypoedHelper is not defined`) stays a hard error,
and keep the `limitations` array in every report: a pass proves protocol and contract
conformance, never that the panel renders correctly. See `docs/contributor/PLUGIN_TESTING.md`.

## Agent modes

Modes are **explicit**. There is no `auto` mode and no prompt-keyword routing; `resolveMode`
is identity plus legacy coercion.

```txt
general    (default)  no manifest constraints enforced
plugin                CrewCode app plugins      -> crewcode.plugin.json
extension             CrewCoder extensions      -> crewcoder.extension.json
```

Do not reintroduce keyword routing. It silently changed which constraints were treated as
law, and the extension vocabulary (`hooks`, `skills`, `workflows`, `manifest`, `tools`)
overlaps ordinary coding vocabulary too heavily for any keyword list to be safe.

`auto` is a **persisted** legacy value living in old `config.json`, session records, and goal
records. `normalizeAgentMode()` coerces it to `general` on read so that state keeps loading,
but `config set defaultMode auto` is a hard error — read-tolerance must not let the removed
concept back into new state.

Extension mode mirrors plugin mode across four files, and the two knowledge sets are
deliberately separate:

```txt
src/knowledge/extension-constraints.ts     CREWCODER_EXTENSION_CONSTRAINTS
src/knowledge/crewcoder-extension-docs.ts  embedded extension docs
src/skills/crewcoder-extension/index.ts    extension authoring skill pack
src/core/system-prompt.ts                  "CrewCoder Extension Architect mode"
```

Never merge the extension and plugin knowledge sets. `crewcoder.extension.json` and
`crewcode.plugin.json` are different manifests with different trust models, and conflating
them is the most likely model error in this area; `src/tests/extension-mode.test.ts` asserts
the doc sets stay disjoint. `crewcoder docs query` searches both under separate headings.
See `docs/EXTENSION_MODE.md`.

### Embedded docs: id catalog in the prompt, body on demand

`EmbeddedDoc` is deliberately tiered, and the split is the point:

```txt
id               -> static catalog line in the system prompt (~120 tok, every run)
title + summary  -> returned BY the docs tool, never shipped in the prompt
content          -> full buildable reference (manifests, working code, build recipes),
                    loaded ONLY when the model calls the `docs` tool
```

The embedded knowledge exists to teach the model **how to build** a plugin or an extension.
A `summary`-only doc set is a table of contents and cannot do that — do not regress
`content` back into one-line descriptions. Because bodies load on demand, depth is free:
~8.3k tokens of extension reference and ~4.3k of plugin reference cost nothing until asked
for, while the prompt carries only a bare id list.

**Do not reintroduce prompt-matched doc selection.** The first version keyword-matched the
prompt and injected `id: title — summary` per match. Measured, an on-topic prompt cost
~134 tokens while an unrelated one cost ~655 — a miss fell back to querying `"extension"`,
which matched most of the set, so the least relevant prompts cost the most. It also hid docs
the matcher missed. `selectDocs()` now returns the whole catalog for the mode and
`buildSystemPrompt` renders ids only. Guarded by `src/tests/extension-mode.test.ts`, which
asserts ids-only rendering, a token budget on the section, and that an on-topic and an
off-topic prompt produce an identical catalog.

`src/tools/docs.ts` serves the bodies and is **mode-scoped** — plugin mode sees only plugin
docs, extension mode only extension docs, general mode both. That scoping is what stops a
`crewcode.plugin.json` reference leaking into an extension task. Keep `content` grounded in
`src/extensions/types.ts`, `src/extensions/api.ts`, `docs/EXTENSION_*.md`, and the real
`/CrewCode/examples/plugins` templates so it stays re-derivable rather than invented.
Guarded by `src/tests/docs-tool.test.ts`, which requires every doc to carry a real body and
asserts neither set mentions the other's manifest filename.

## CrewCode app plugin rules

Plugin mode must obey CrewCode v0:

```txt
- crewcode.apiVersion is "0.1"
- plugin UI is static assets
- plugin UI runs in sandboxed iframe
- no window.electronAPI
- workspace:listFiles/readFile require workspace:read
- workspace:writeFile requires workspace:write
- network:fetch and secrets:get are denied from plugin iframes
- MCP/provider contributions are manifest declarations
```

## Commands

`crewcoder` with no arguments launches the separately installed `crewcoder-tui` binary. Keep argument-bearing agent commands routed through this CLI.

```bash
crewcoder
crewcoder run --provider opencode "prompt"
crewcoder run --mode extension "add a compaction hook"
crewcoder providers
crewcoder extension registry add https://example.com/registry.json
crewcoder extension search nextjs workflows
crewcoder extension install nextjs-workflows
crewcoder extension install acme/nextjs-workflows
crewcoder extension install acme/pack@v1.2.0#packages/lint --trust sandboxed
crewcoder workflow list
crewcoder workflow show release-check
crewcoder workflow run release-check
crewcoder extension update <id>
crewcoder extension uninstall <id>
crewcoder extension create aider-provider --kind provider
crewcoder extension list
crewcoder plugin test ./my-panel --workspace ~/code/some-repo
crewcoder plugin list-templates
crewcoder plugin create my-panel --kind static-panel
crewcoder sessions
crewcoder session why <id>
crewcoder diff-models "explain generics" --models codex:gpt-5.6,opencode:claude-sonnet-4-6
crewcoder cost --today --by-model
crewcoder cost price codex:gpt-5.6-luna --input 1.25 --output 10
crewcoder doctor
```

## Verification notes

Prefer package-local validation from the monorepo root:

```bash
CREWCODER_HOME=/tmp/.crewcoder npm run typecheck -w @onpoint-dev-tools/crewcoder-agent
env -u OPENCODE_API_KEY CREWCODER_HOME=/tmp/.crewcoder npm test -w @onpoint-dev-tools/crewcoder-agent
```

Unset `OPENCODE_API_KEY` for provider-registry tests unless the test explicitly needs live auth. Use a `CREWCODER_HOME` value ending in `.crewcoder` when tests assert CrewCoder home paths.

Regression tests that protect thinking streams:

```txt
src/tests/http-provider.test.ts
src/tests/codex-provider.test.ts
src/tests/openai-responses-provider.test.ts
src/tests/websocket-provider.test.ts
```

`src/tests/http-provider.test.ts` also protects streamed OpenCode tool calls so README/read-file tasks do not terminate before the read tool executes.

## Iteration limits & stall detection

Agents are **not** bounded by an iteration count. `maxIterations` defaults to `0` (unlimited);
a turn counter measures nothing real and silently truncates working runs.

```txt
config keys:   maxIterations (default 0 = unlimited, clamp 0-1000)
               stallDetection (default true)
               stallRepeatThreshold (default 3)  -> identical consecutive tool calls
               stallErrorThreshold (default 8)   -> consecutive failing tool calls
guard model:   stall detection  -> always on, trips only on provable loops
               token budget     -> opt-in per session (--budget/--max-tokens), never a default
               auto-compaction  -> NOT a limiter; it lets runs go longer
```

`src/core/stall-detector.ts` is the only always-on runaway guard. Both counters reset when the
agent does something different or something succeeds, so a healthy long run never trips them.
Do not reintroduce a default iteration cap as a safety mechanism, and do not treat
auto-compaction as one — only budgets and stall detection actually stop a run.

This applies to delegated child workers too: `delegateWorker` defaults to unlimited turns.
Child workers are bounded by stall detection and `maxChildWorkerDepth` (recursion), never by a
turn count. A parent may still pass an explicit `maxIterations` to leash a specific delegation.

All three early-stop paths must report honestly and exit non-zero; a truncated or looping run
is not a successful run:

```txt
providerError        -> provider failed (auth/billing/network)
stallError           -> run was provably looping (agent_stalled event)
iterationCapReached  -> an explicit --max-iterations truncated the task
```

Guarded by `src/tests/stall-detector.test.ts` and `src/tests/agent-loop.test.ts`.

## Runtime guardrails

Filesystem checkpoints are default-on full bounded snapshots (up to 2,000 files/25 MB) and retain only the 10 newest per session; creating another checkpoint removes the oldest snapshot and its session metadata. `config.checkpointsEnabled=false` disables automatic pre-mutation snapshots for future runs without deleting existing checkpoints.

Per-session token budgets are cumulative provider-reported totals, distinct from `currentContextTokens()` live context occupancy. `--budget`/`--max-tokens` persist through `UsageSummary.tokenBudget`; emit warning at 80%, compact before continued tool-driven work when possible, and stop before pending tools or another model turn after the limit. Budget-exhaustion handoff creates a fresh parent-linked session whose only conversation input is the bounded compact summary; never copy the original transcript or exhausted usage into that child. Never change auto-compaction to use cumulative budget totals. `--verify` runs package typecheck/test scripts plus executable trusted extension `validators` and emits `verification_start`/`verification_end`. See `docs/RUNTIME_GUARDRAILS.md`.

## CI run contract

`crewcoder run --ci` is the machine-facing summary contract. It automatically enables
verification and writes exactly one versioned JSON document to stdout; progress and
diagnostics belong on stderr. Keep `--ci` mutually exclusive with `--json-events` and
`--replay`, because those commands have different stdout protocols.

Exit-code mapping lives in `src/core/ci-run.ts`: `0` success, `1` other failure,
`2` verification failure, `3` budget exceeded, `4` approval denied. Do not infer
approval denial from tool-result text; `AgentLoopResult.approvalDenied` is populated
from `approval_resolved`. Terminal stop reasons take precedence over verification.
See `docs/CI_RUNS.md`.

## CI integrations and generated Git hooks

The root `action.yml`, `.gitlab/crewcoder.gitlab-ci.yml`, and
`crewcoder-agent/scripts/run-ci.sh` are thin transports over `run --ci`; they must
preserve its stdout JSON and process exit code. The GitHub action builds from its
tagged source checkout by default so it runs the exact tagged revision. The GitLab
job requires a runner-provided binary or an explicit trusted
`CREWCODER_INSTALL_COMMAND`. See `docs/CI_INTEGRATIONS.md`.

Production builds use `tsconfig.build.json` and exclude `src/tests`; `typecheck`
still uses `tsconfig.json` and checks runtime plus tests. Do not make action
distribution depend on emitting test files into `dist`.

`crewcoder hook install` owns only the marker-delimited block generated by
`src/core/git-hooks.ts`. Preserve content outside those markers. Refuse unrelated
hooks unless `--force` moves the old hook to a timestamped backup. Never write a
resolved hooks path outside the repository/Git directory; a global
`core.hooksPath` is shared state, not a repository-local install target. The
generated pre-commit review uses non-interactive `--approval always` so mutation
attempts are denied.

## Supported TypeScript SDK

`@onpoint-dev-tools/crewcoder-sdk` is the supported in-process embedding API. Keep it as a
separate package from `@onpoint-dev-tools/crewcoder-agent`; the SDK may depend on the agent,
but it must consume only explicit agent exports. `src/sdk-runtime.ts` is the narrow
adapter for provider resolution, loop execution, durable resume, in-memory
continuation, events, approvals, follow-ups, extension UI, and cancellation. Do not
make the SDK import arbitrary `src/core/*` or `src/providers/*` files.

Persistent sessions remain the default. `AgentLoopOptions.persistSession=false` skips
the session JSONL write and `session_saved` event, but it does not disable tools,
extensions, audit logs, cost accounting, or other normal runtime effects. In-memory
continuation must carry messages, usage, compactions, checkpoints, model turns, and
extension entries forward without loading a session file.

The in-process SDK is not ACP or the JSON-events subprocess bridge. Remote fleet
access is a separate supported contract through `CrewCoderFleetClient`; keep its
HTTP/SSE/WebSocket types and security behavior distinct from `CrewCoderSession`.
Every SDK API change requires coverage under `crewcoder-sdk/src/tests` and an update
to `docs/SDK.md`.

## Standalone Linux x64 runner

`npm run build:standalone` compiles `src/cli.ts` with Bun target
`bun-linux-x64-baseline` into `dist-bin/crewcoder-linux-x64`. The artifact embeds
the Bun runtime so a Linux x64 VPS does not need Node.js, npm, or Bun. It is the
headless agent CLI, not `crewcoder-tui`; no-argument standalone execution must print
CLI help rather than trying to spawn the unbundled TUI.

Detached goals must self-spawn through `src/core/self-invocation.ts`. Node script
execution needs `node [execArgv] dist/cli.js ...`, while the compiled binary must run
`process.execPath ...` directly. Bun identifies the embedded entry under `/$bunfs`.
Do not restore direct `process.execPath + process.argv[1]` construction in
goal-runner.

`crewcoder deploy --binary <path>` uploads the executable and starts fleet mode on
loopback. This profile remains SSH-only even though fleet bearer authentication is
mandatory: a bearer token does not encrypt plaintext HTTP. Existing npm deployment
remains a separate compatibility path. A local `crewcoder-tui --remote` may execute
this deployed binary directly over SSH without using fleet HTTP; preserve CLI JSON
stream and stdin-control compatibility for that transport. The standalone build disables automatic
`.env` loading; do not re-enable it because deployment working directories may
contain unrelated secrets. See `docs/FLEET_MODE.md`.

## Fleet authentication

`src/core/fleet-auth.ts` owns the runner-wide 256-bit bearer token at
`<CREWCODER_HOME>/fleet-token`. Create and rotate it atomically with mode `0600`;
deployment creates the containing CrewCoder home with mode `0700`. `serve` may print
the token path but never the token. `fleet token` is the explicit secret-retrieval
command, and `fleet token --rotate` requires a server restart before the new value is
active.

Only `GET /health` is public. Run creation/status, SSE replay/live streams, controls,
and WebSocket upgrades all require authentication. HTTP/SSE use
`Authorization: Bearer`; browser WebSockets offer `crewcoder.v1` plus
`crewcoder.auth.<token>` and the server selects only `crewcoder.v1`. Never accept a
query-string token: URLs leak through histories, proxies, and logs. Compare token
derivatives with `crypto.timingSafeEqual`. Public network deployment still requires
HTTPS and operational controls; authentication alone does not authorize plaintext
internet exposure.

Fleet protocol 1.0 persists run metadata and append-only event records under
`<CREWCODER_HOME>/fleet-runs` with private permissions. Every event has a monotonic
per-run id, SSE emits `id:`, and HTTP/WebSocket replay accepts an `after` cursor.
Terminal streams close after `fleet_run_status`. On restart, recover terminal history
and mark formerly running records `failed` with `interrupted: true`; do not claim that
ordinary agent execution survived process death. Detached goals own that durability.
SDK reconnect must resume from the last delivered cursor without deliberate duplicate
replay. Treat persisted prompts/events as sensitive and preserve package/protocol tests.

## ACP adapter

`crewcoder acp` exposes CrewCoder as an **Agent Client Protocol** agent (JSON-RPC 2.0
over newline-delimited stdio) so ACP clients — CrewCode, Block's Buzz, Zed — can drive
the agent loop. ACP is asymmetric: CrewCoder is the **agent** (spawned child), the app is
the **client** (spawns it). CrewCode already implements the client half in
`src/main/agents/hermes-bridge.ts`; never build an ACP agent inside CrewCode.

**Stdout is reserved for JSON-RPC frames.** `src/acp/stdio.ts` captures the real writer,
hands it to the protocol, then redirects `process.stdout.write` to stderr so a stray
`console.log` is loud instead of silently corrupting the stream. Do not remove that guard
and do not hand `process.stdout` straight to `ndJsonStream`.

Built on `@agentclientprotocol/sdk` (official; replaces the deprecated
`@zed-industries/agent-client-protocol`). Protocol version **1** is the stable wire and
matches what CrewCode sends.

The adapter targets **hermes ACP parity**, because that is the dialect existing clients
already speak. Where the 1.x schema and hermes disagree, follow hermes: the schema
dropped the model API, but `session/new` still returns
`models.availableModels[] = { modelId: "provider:model", name }` and `session/set_model`
is served through the SDK's `extMethod` escape hatch. Clients read both. Do not "clean
this up" to match the bare schema — it silently breaks CrewCode's model picker. Verified
the SDK does not strip unknown response fields. `session/prompt` reports usage twice:
`_meta["crewcoder/usage"]` (full summary) plus a top-level `usage` mirror for
hermes-shaped clients. `session/load` reattaches a durable session and replays message
text as `user_message_chunk`/`agent_message_chunk`; unknown ids return `resourceNotFound`
rather than silently creating a session. `session/set_external_directories` is another intentional
ACP extension: CrewCode calls it after new/load, including with `[]` to revoke stale grants.
CrewCoder validates roots on the agent host, persists them in session metadata, and authorizes file
tools through `ToolContext.externalDirectories`; never replace this with a process-global allowlist
or an environment variable. See `docs/EXTERNAL_DIRECTORIES.md`.

When a client advertises `clientCapabilities.fs`, `read`/`write`/`edit` route text I/O
through `fs/read_text_file`/`fs/write_text_file` instead of `node:fs`, which is how
CrewCoder sees unsaved editor buffers and remote (SFTP-proxied) workspaces.
`src/tools/text-file-io.ts` is the single choke point; `ToolContext.textFiles` carries an
optional `TextFileHost` that is deliberately host-agnostic, not ACP-specific. Read and
write capabilities are **independent** — wire and fall back per method, because
all-or-nothing gating silently disables writes for read-only clients. `mkdir` runs only
on the local path (a host filesystem owns its own directory creation), and image reads
always use local disk since ACP `fs/*` is text-only. `terminal/*` stays unused: shell
commands run locally even when files are served remotely.

```txt
assistant_delta       -> agent_message_chunk
thinking_delta        -> agent_thought_chunk
tool_execution_start  -> tool_call        (kind, status, rawInput, locations, title)
tool_delta/end        -> tool_call_update (rawOutput, completed | failed)
```

CrewCode reads `rawInput`/`rawOutput`/`status`/`title` by name; renaming them empties the
tool rows. Events with no faithful ACP shape (checkpoints, cost ledger, goals, compaction,
budgets, verification) are **dropped**, not force-fitted — their future home is a
namespaced `_crewcoder/*` ext channel, which must be introduced before any of that data
ships, because retrofitting the namespace is the breaking part.

Approvals: CrewCoder emits `approval_required` **before** `tool_execution_start`, so the
adapter announces a `pending` `tool_call` first, then calls `session/request_permission`;
otherwise the prompt references a row the client has never seen. Decisions feed the
loop's `approvalSignal` (same channel as stdin control) — never saved-session polling.
Permission responses are matched **by id prefix**, because clients answer with shortened
ids (CrewCode replies `reject`, not `reject_once`).

Provider and stall failures are raised as JSON-RPC errors, never `stopReason: "end_turn"`;
a failed run reported as a successful turn is the same class of bug as a provider error
rendered as assistant text. Capabilities are reported honestly (`loadSession: true`,
`promptCapabilities.image: false`) rather than advertising methods that would throw.

`createAcpServer({ input, output })` takes streams as parameters so
`src/tests/acp-adapter.test.ts` can drive the real wire with no subprocess. Keep it that
way. See `docs/ACP_ADAPTER.md`.

## Code intelligence tools

Built-in code intelligence lives in `src/tools/lsp-client.ts`, `src/tools/lsp.ts`, and `src/tools/edit-symbol.ts`. The LSP tools require external language-server commands on `PATH`; TypeScript uses `typescript-language-server` as the LSP adapter over tsserver, Python uses `pyright-langserver`, and Go uses `gopls`. `edit_symbol` currently uses the TypeScript compiler AST for `.ts`, `.tsx`, `.js`, and `.jsx` files and must remain syntax-validating and ambiguity-safe. See `docs/CODE_INTELLIGENCE_TOOLS.md`.

## Next build priorities

```txt
1. Structured provider output/tool-call parsing
2. session resume/branch
3. risky tool approvals
4. extension skills and prompt-pack activation (done — src/extensions/extension-activation.ts)
5. trusted extension tools
6. improve --propose / improve --apply
7. JSON schema validation for both manifest types
```

## Milestone 5 TUI backend contract

This package now includes the backend contract needed before building `crewcoder/crewcoder-tui`.

New core files:

```txt
src/core/json-event-stream.ts
src/core/approval.ts
src/core/session-loader.ts
src/core/session-branch.ts
src/core/agent-loop-continue.ts
src/providers/output-parser.ts
src/extensions/extension-registry.ts
docs/contributor/ROADMAP.md
docs/contributor/TUI_BACKEND_CONTRACT.md
```

The TUI should consume `crewcoder run --json-events` and `crewcoder session resume <id> --json-events` instead of importing private internals.

Keep the JSON event stream backwards-compatible once TUI work begins.

## Workers & identity system

CrewCoder supports multiple named **workers** (agent identities) the user can switch between. Workers are global, stored under the CrewCoder home:

```txt
~/.crewcoder/workers/<WorkerName>/identity.json
~/.crewcoder/workers/<WorkerName>/IDENTITY.md
```

- `identity.json` — structured identity: `workerName`, `ownerName`, `ownerHandle`, `description`.
- `IDENTITY.md` (per worker) — freeform persona/instructions for that worker. Its body is embedded in the worker identity block in the system prompt. Defines WHO the worker is and HOW it behaves.

The **active worker** is stored in `config.json` as `activeWorker` (default `"Crew"`). A default `Crew` worker is auto-created on first use; a legacy single `identity.json` is migrated into it once.

### Two instruction layers — keep them separate

```txt
Per-worker IDENTITY.md -> runtime persona/instructions embedded in the system prompt
Repo AGENTS.md         -> rules for the codebase in the working dir (normal AGENTS.md convention)
This AGENTS.md         -> CrewCoder package docs/standards, documentation ONLY
```

Identity assembly lives in `src/core/identity.ts` (`getActiveWorker`, `buildIdentityPrompt`). The agent loop passes the identity block, including the `IDENTITY.md` body, to `buildSystemPrompt` as `identityPrompt`, so it sits at the top of the system prompt on every run. Fresh installs auto-create `Crew` with owner placeholders `CrewCoder User` / `@CrewCoderUser` and a useful general-purpose starter identity; never overwrite an existing worker's customized files.

### Worker commands

```bash
crewcoder workers                 # list workers (active marked with *)
crewcoder workers list --json     # machine-readable list (TUI /workers backend)
crewcoder workers use <name>      # switch active worker
crewcoder workers create <name> --owner <n> --handle <h> --description <text>
crewcoder workers show [name]     # show a worker (active if omitted)
crewcoder workers set <name> <key> <value>   # keys: owner-name, owner-handle, description
crewcoder workers path [name]     # print worker IDENTITY.md path to edit
crewcoder workers delete <name>
crewcoder identity show|set       # shortcut: operate on the active worker
```
