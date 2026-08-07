# Built-in Providers

CrewCoder maintains provider-specific authentication and payload adapters while sharing checked
process, HTTP/SSE, and WebSocket lifecycle contracts.

## Available providers

| Provider id | API | Credential | Default model |
| --- | --- | --- | --- |
| `codex` | ChatGPT OAuth Codex Responses | `crewcoder login codex` | `gpt-5.6-luna` |
| `claude` | Claude Code Agent SDK | local Claude Code login | `claude-sonnet-5` |
| `openai` | OpenAI Responses | `OPENAI_API_KEY` | `gpt-5.4` |
| `anthropic` | Anthropic Messages | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| `openrouter` | OpenRouter Chat Completions | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.6` |
| `xai` | xAI Chat Completions | `XAI_API_KEY` | `grok-4.1-fast` |
| `grok` | Grok CLI over ACP stdio | `grok login` or `XAI_API_KEY` | `grok-4.5` |
| `deepseek` | DeepSeek Chat Completions | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `mistral` | Mistral Chat Completions | `MISTRAL_API_KEY` | `mistral-large-latest` |
| `opencode` | OpenCode Zen | `OPENCODE_API_KEY` | `gpt-5.5` |
| `opencode-go` | OpenCode Zen Go | `OPENCODE_API_KEY` | `minimax-m3` |

Provider model catalogs change faster than CrewCoder releases. The listed models are usable defaults,
not an allowlist. Pass any model supported by the selected account:

```bash
crewcoder run --provider openrouter --model google/gemini-3.1-pro-preview "inspect this repository"
crewcoder run --provider deepseek --model deepseek-reasoner "debug this failure"
```

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

Codex currently has that implementation through official app-server durable threads, with direct cached WebSocket/SSE as a guarded fallback.
Claude uses its Agent SDK process/session transport with hybrid native-read and CrewCoder-MCP tools.
See [`CLAUDE_AGENT_SDK.md`](./CLAUDE_AGENT_SDK.md), [`CODEX_TRANSPORT.md`](./CODEX_TRANSPORT.md), and
[`PROVIDER_TRANSPORTS.md`](./contributor/PROVIDER_TRANSPORTS.md).

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
