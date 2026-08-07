# Provider Transport Architecture

CrewCoder uses a hybrid provider model:

- Famous providers receive maintained built-in adapters for their authentication, payload format,
  streaming events, tool calls, usage, errors, and continuation semantics.
- Extension providers may select vetted generic process, HTTP/SSE, or WebSocket runtimes.
- Extensions may not provide arbitrary transport code or select adapters that own CrewCoder-stored
  OAuth/session credentials.

## Protocol adapters are not transports

A physical channel does not define a provider protocol. Two providers can both use WebSockets while
requiring incompatible authentication headers, request envelopes, event types, continuation IDs,
and replay rules. CrewCoder therefore keeps these concerns separate:

- `ProviderRuntime` selects the checked payload/auth adapter.
- `ProviderTransportProfile` describes the adapter's implemented channel and lifecycle behavior.

```ts
type ProviderTransportProfile = {
  channel: "process" | "http-sse" | "websocket";
  continuation: "none" | "response-id" | "connection-cache" | "provider-session";
  fallback?: "process" | "http-sse" | "websocket";
  replay: "never" | "pre-stream-only";
};
```

A manifest declaration never invents functionality. Every current runtime has one fixed core
profile; an explicit manifest profile must match it exactly. For example, adding
`fallback: "http-sse"` does not give a generic WebSocket provider an SSE serializer. A new behavior
requires a new or upgraded core runtime that implements and tests that lifecycle.

## Current curated profiles

| Runtime | Primary channel | Continuation | Fallback | Extension use |
| --- | --- | --- | --- | --- |
| `process` | process | none | none | allowed |
| `model-command` | process | provider session | none | allowed |
| `claude-agent-sdk` | SDK-managed process | provider session | none | **built-in only** |
| `anthropic-messages` | HTTP/SSE | none | none | allowed |
| `openai-chat-completions` | HTTP/SSE | none | none | allowed |
| `openai-responses` | HTTP/SSE | none | none | allowed |
| `websocket` | WebSocket | provider session | none | allowed |
| `openai-codex-responses` | app-server process | durable provider thread | HTTP/SSE | **built-in only** |

Codex and Claude Agent SDK are built-in only because they own provider authentication/session state. Codex's adapter reads CrewCoder's stored ChatGPT OAuth credential. An
extension-controlled endpoint must never receive that credential. Extension providers may read an
API key stored under their own provider id or their explicitly named environment variable, but they
cannot alias another auth-store entry through `apiKeyEnv` and cannot consume OAuth credentials.

## Adding a famous provider

Before adding a built-in provider, document and test:

1. Official authentication and credential ownership.
2. Payload and tool-call schema.
3. Text, thinking, usage, completion, and provider-error events.
4. Whether continuation is stateless, response-ID based, connection-scoped, or provider-native.
5. Whether WebSocket is officially supported for agent/model traffic—not merely realtime voice.
6. The exact point after which replay could duplicate output or tool calls.
7. Cancellation and idle connection cleanup.
8. Request-size telemetry, output limits, compaction behavior, and nested transport errors.
9. Credential, model, system-prompt, and tool-contract changes that invalidate continuation.
10. A conformance suite covering initial request, continuation, fallback, partial-stream failure,
    cancellation, and credential isolation.

Do not label an API "OpenAI-compatible" and assume Responses, Chat Completions, tool calls,
reasoning, SSE, and WebSockets are all compatible. Add a dedicated core runtime when semantics
differ.

## Expansion direction

Implemented adapter families now include Anthropic Messages, OpenAI Responses, and a separate
OpenAI Chat Completions runtime used by OpenRouter, xAI, DeepSeek, and Mistral. Remaining
families include:

- Google Gemini generate/stream APIs.
- Azure OpenAI with Azure authentication and endpoint conventions.
- AWS Bedrock with signed SDK transport.
- Local HTTP streaming for Ollama-compatible servers.
- Provider-native agent/session protocols where vendors expose them.

Each family may serve multiple named providers, but every built-in provider still owns an explicit
endpoint, auth policy, model catalog, and checked transport profile.

## CLI inspection

`crewcoder providers` displays the resolved channel, continuation mode, and fallback. JSON output
includes the complete checked `transport` profile for SDK/TUI consumers.
