# Built-in Providers

CrewCoder maintains provider-specific authentication and payload adapters while sharing checked
process, HTTP/SSE, and WebSocket lifecycle contracts.

## Available providers

| Provider id | API | Credential | Default model |
| --- | --- | --- | --- |
| `codex-cli` | The user's own Codex CLI app-server | `codex login` (CrewCoder never holds the tokens) | `gpt-5.6-luna` |
| `claude` | Claude Code Agent SDK | local Claude Code login | `claude-sonnet-5-5` |
| `openai` | OpenAI Responses | `OPENAI_API_KEY` | `gpt-5.4` |
| `anthropic` | Anthropic Messages | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| `openrouter` | OpenRouter Chat Completions | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.6` |
| `xai` | xAI Chat Completions | `XAI_API_KEY` | `grok-4.1-fast` |
| `grok` | Grok CLI over ACP stdio | `grok login` or `XAI_API_KEY` | `grok-4.5` |
| `deepseek` | DeepSeek Chat Completions | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `mistral` | Mistral Chat Completions | `MISTRAL_API_KEY` | `mistral-large-latest` |
| `opencode` | OpenCode Zen | `OPENCODE_API_KEY` | `gpt-5.5` |
| `opencode-go` | OpenCode Zen Go | `OPENCODE_API_KEY` | `minimax-m3` |

`codex-cli` is the sole Codex provider and the fresh-install default. The former
CrewCoder-managed `codex` provider and its OAuth login flow have been removed.
Existing configurations that name it must select the installed CLI:

```bash
crewcoder config set defaultProvider codex-cli
```

Provider model catalogs change faster than CrewCoder releases. The listed models are usable defaults,
not an allowlist. Pass any model supported by the selected account:

```bash
crewcoder run --provider openrouter --model google/gemini-3.1-pro-preview "inspect this repository"
crewcoder run --provider deepseek --model deepseek-reasoner "debug this failure"
```

## Automatic model discovery

`crewcoder providers --json`, the TUI model picker, and ACP `session/new` and
`session/load` use discovered provider catalogs:

- `codex-cli` calls the installed Codex CLI's `model/list` with its own login and
  configuration. `CREWCODER_CODEX_PATH` selects an alternate executable.
- `claude` calls Agent SDK `supportedModels()` using `CREWCODER_CLAUDE_PATH`, or
  the installed `claude` executable on `PATH`. Discovery and inference use the
  same executable resolver and native authentication. If neither is available,
  the SDK's bundled executable is used. Claude aliases and their reported
  canonical model IDs are included. An older SDK bundle can expose fewer models
  than an up-to-date installed Claude Code; the installed CLI takes precedence.

No inference prompt is sent. Claude discovery disables tools, MCP servers,
filesystem settings, hooks, skills, and session persistence. Each native lookup
has a five-second deadline. Codex pagination and catalog sizes are bounded;
hidden and malformed entries are excluded.

Successful native catalogs are cached for five minutes within the backend
process; simultaneous requests share one lookup. Failed lookups retain the last
successful catalog in that process and retry after 30 seconds. A fresh process
without a successful catalog uses the bundled list when discovery fails. Account
and executable changes invalidate the cache where observable; OS-keychain changes
are picked up after cache expiry. Reopening a picker requests the catalog again.

The bundled default stays selected if the runtime still lists it. Otherwise,
CrewCoder uses the runtime's recommended default, or its first model. Explicit
`--model` selections remain accepted. Known context metadata is retained for
matching IDs; unknown context limits are resolved separately and never guessed.
Running a model resolves only the selected provider, so it does not start other
native providers just to discover their models.

New models appear when the installed Codex/Claude runtime reports them. Discovery
does not upgrade those dependencies, guarantee account entitlement, or bypass a
runtime's own cached/bundled catalog. An older runtime may need updating before
it exposes a new release. `crewcoder auth --json` skips all
model discovery and remains read-only.

See the official [Codex model-list protocol](https://learn.chatgpt.com/docs/app-server#list-models-modellist).

## Credentials

Use environment variables directly or import visible API keys into CrewCoder's mode-0600 auth file:

```bash
export ANTHROPIC_API_KEY=...
export OPENROUTER_API_KEY=...
crewcoder auth import-env anthropic
crewcoder auth import-env openrouter
crewcoder auth
```

An extension provider can read an API key stored under its own provider id or its declared
environment variable. It cannot consume OAuth credentials or alias another stored auth entry.

## Sign-in status as JSON

`crewcoder auth --json` prints `{ "schemaVersion": 1, "providers": [{ id, title, state, source?, detail? }] }`. `state` is `signed-in`, `signed-out`, `not-installed`, or `unknown`.

- It is read-only: no token refresh, no auth file writes, no model discovery or network calls of its own.
- `codex-cli` runs `codex login status`; `claude` runs `claude auth status --json` and forwards only the auth method, never the email or organization.
- Other providers report stored keys or environment variables. ACP and process providers report `unknown` because their own CLI owns sign-in.
- Hosts such as Crew Nodes forward this output to a relay, so it must never carry account identity or key material.

See [Bring-your-own Codex CLI](CODEX_CLI_PROVIDER.md) for the `codex-cli` provider.

## Endpoint overrides

Self-hosted gateways and compatible enterprise endpoints can be selected without changing source:

```txt
CREWCODER_OPENAI_ENDPOINT
CREWCODER_ANTHROPIC_ENDPOINT
CREWCODER_OPENROUTER_ENDPOINT
CREWCODER_XAI_ENDPOINT
CREWCODER_DEEPSEEK_ENDPOINT
CREWCODER_MISTRAL_ENDPOINT
```

Endpoint compatibility still means payload compatibility. An OpenAI Chat Completions gateway is not
an OpenAI Responses or Anthropic Messages gateway.

`grok` has no endpoint override because it is a local CLI, not an HTTP endpoint. Point CrewCoder at a
specific binary with `CREWCODER_GROK_PATH` instead. See [ACP_CLIENT_PROVIDER.md](ACP_CLIENT_PROVIDER.md).

## Transport behavior

OpenAI, Anthropic, OpenRouter, xAI, DeepSeek, and Mistral currently use HTTP streaming. They do
not opt into WebSocket merely because a vendor has a realtime voice or browser socket API. A
provider receives WebSocket continuation only after CrewCoder implements and tests its official
agent/model protocol, authentication, continuation state, replay boundary, and fallback behavior.

Codex CLI uses official app-server durable threads and its own login. It has no HTTP/WebSocket fallback.
Claude uses its Agent SDK process/session transport with hybrid native-read and CrewCoder-MCP tools.
See [`CLAUDE_AGENT_SDK.md`](./CLAUDE_AGENT_SDK.md), [`CODEX_TRANSPORT.md`](./CODEX_TRANSPORT.md), and
[`PROVIDER_TRANSPORTS.md`](./contributor/PROVIDER_TRANSPORTS.md).

## Virtual and remote filesystem custody

When CrewCoder is hosted over ACP or an SDK with a virtual filesystem, such as an SSH/SFTP
workspace, the client-provided file host is authoritative. Provider behavior is classified by
runtime and enforced before dispatch:

ACP filesystem capabilities are independent from this classification: they can serve local
unsaved buffers as well as remote files. ACP custody is enabled only by an explicit
`initialize._meta["crewcode/virtualFilesystem"] === true`.

| Runtime | Virtual workspace behavior |
| --- | --- |
| HTTP/SSE and generic WebSocket model adapters | Safe: models receive only CrewCoder tool schemas |
| Claude Agent SDK | Safe: native file tools are removed and equivalent operations route through CrewCoder MCP |
| Codex CLI | Native file/command tools disabled, read-only sandbox, CrewCoder dynamic tools own file I/O |
| ACP client agents, generic process, model-command | Refused: the subprocess may access local disk outside the virtual host |

Unsupported runtimes fail before their command is spawned and name the provider, runtime, and
affected workspace. Local workspaces are unchanged. A new provider runtime must be added to the
exhaustive custody policy before TypeScript accepts it; a provider with native tools also needs an
adapter regression proving those tools are disabled or bypassed under a virtual host.

## Compatibility expectations

The OpenAI Chat Completions adapter supports:

- streamed assistant text;
- streamed reasoning fields used by compatible providers;
- function tool calls and incremental JSON arguments;
- multimodal `image_url` input;
- final usage chunks when returned by the provider;
- provider error envelopes delivered inside HTTP 200 streams.

Provider-specific features outside that common contract require a dedicated adapter rather than
conditional model-name behavior. Reasoning-effort controls, prompt caching, structured output, and
vendor-specific tool extensions may therefore differ even when basic Chat Completions is compatible.

Parallel tool calls are capability-gated. Built-ins advertise support; extension providers default to
disabled and may opt in through `capabilities.parallelToolCalls`, with an optional
`modelCatalog[].parallelToolCalls` override for mixed catalogs. The OpenAI-compatible request flag and
the host-side parallel-safe tool scheduler are documented in [PARALLEL_TOOL_CALLS.md](PARALLEL_TOOL_CALLS.md).
