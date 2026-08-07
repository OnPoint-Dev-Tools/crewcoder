import type { ProviderDefinition } from "./types.js";

const directCapabilities = {
  streaming: true,
  toolCalling: true,
  parallelToolCalls: true,
  sessionResume: true,
  acceptsSystemPrompt: true,
  acceptsWorkingDirectory: false
};

export const builtinProviders: ProviderDefinition[] = [
  {
    id: "codex",
    title: "OpenAI Codex",
    kind: "builtin",
    runtime: "openai-codex-responses",
    command: "http",
    args: [],
    endpoint: process.env.CREWCODER_CODEX_ENDPOINT ?? "https://chatgpt.com/backend-api/codex/responses",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
    defaultModel: "gpt-5.6-luna",
    capabilities: directCapabilities,
    transport: { channel: "process", continuation: "provider-session", fallback: "http-sse", replay: "never" },
    description: "- OAuth ChatGPT subscription. Run: crewcoder login codex."
  },
  {
    id: "claude",
    title: "Claude Code Agent SDK",
    kind: "builtin",
    runtime: "claude-agent-sdk",
    command: "sdk",
    args: [],
    models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-4-6"],
    defaultModel: "claude-sonnet-5",
    capabilities: directCapabilities,
    transport: { channel: "process", continuation: "provider-session", replay: "never" },
    description: "- Claude Code Agent SDK using the local Claude login. Run Claude Code login first."
  },
  {
    id: "grok",
    title: "Grok CLI",
    kind: "builtin",
    runtime: "acp-client",
    command: process.env.CREWCODER_GROK_PATH ?? "grok",
    // Flag order matters: `--model`/`--reasoning-effort` belong to `grok agent`,
    // NOT to the `stdio` subcommand, which rejects them with a usage error.
    args: ["agent", "{{modelArg:--model}}", "{{effortArg:--reasoning-effort}}", "stdio"],
    apiKeyEnv: "XAI_API_KEY",
    // Verified against `grok models` on a logged-in CLI, not from docs. The CLI
    // exposes only what the signed-in account grants, and these are NOT the xAI
    // HTTP API ids (`grok-4.1-fast`, `grok-code-fast-1`) carried by `xai`.
    models: ["grok-4.5"],
    defaultModel: "grok-4.5",
    // ACP `session/new` carries an explicit cwd, unlike the direct HTTP providers.
    capabilities: { ...directCapabilities, acceptsWorkingDirectory: true },
    transport: { channel: "process", continuation: "provider-session", replay: "never" },
    description: "- Grok CLI over ACP stdio. Install the grok CLI, then `grok login` or set XAI_API_KEY."
  },
  {
    id: "openai",
    title: "OpenAI API",
    kind: "builtin",
    runtime: "openai-responses",
    command: "http",
    args: [],
    endpoint: process.env.CREWCODER_OPENAI_ENDPOINT ?? "https://api.openai.com/v1/responses",
    apiKeyEnv: "OPENAI_API_KEY",
    models: ["gpt-5.4", "gpt-5.4-mini"],
    defaultModel: "gpt-5.4",
    capabilities: directCapabilities,
    transport: { channel: "http-sse", continuation: "none", replay: "pre-stream-only" },
    description: "- Official OpenAI Responses API. Set OPENAI_API_KEY."
  },
  {
    id: "anthropic",
    title: "Anthropic API",
    kind: "builtin",
    runtime: "anthropic-messages",
    command: "http",
    args: [],
    endpoint: process.env.CREWCODER_ANTHROPIC_ENDPOINT ?? "https://api.anthropic.com/v1/messages",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    authScheme: "anthropic-key",
    models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-4-6"],
    defaultModel: "claude-sonnet-5",
    capabilities: directCapabilities,
    transport: { channel: "http-sse", continuation: "none", replay: "pre-stream-only" },
    description: "- Official Anthropic Messages API. Set ANTHROPIC_API_KEY."
  },
  {
    id: "openrouter",
    title: "OpenRouter",
    kind: "builtin",
    runtime: "openai-chat-completions",
    command: "http",
    args: [],
    endpoint: process.env.CREWCODER_OPENROUTER_ENDPOINT ?? "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: ["anthropic/claude-sonnet-4.6", "openai/gpt-5.4", "google/gemini-3.1-pro-preview"],
    defaultModel: "anthropic/claude-sonnet-4.6",
    capabilities: directCapabilities,
    transport: { channel: "http-sse", continuation: "none", replay: "pre-stream-only" },
    description: "- OpenRouter Chat Completions. Set OPENROUTER_API_KEY."
  },
  {
    id: "xai",
    title: "xAI",
    kind: "builtin",
    runtime: "openai-chat-completions",
    command: "http",
    args: [],
    endpoint: process.env.CREWCODER_XAI_ENDPOINT ?? "https://api.x.ai/v1/chat/completions",
    apiKeyEnv: "XAI_API_KEY",
    models: ["grok-4.1-fast", "grok-code-fast-1"],
    defaultModel: "grok-4.1-fast",
    capabilities: directCapabilities,
    transport: { channel: "http-sse", continuation: "none", replay: "pre-stream-only" },
    description: "- xAI Chat Completions. Set XAI_API_KEY."
  },
  {
    id: "deepseek",
    title: "DeepSeek",
    kind: "builtin",
    runtime: "openai-chat-completions",
    command: "http",
    args: [],
    endpoint: process.env.CREWCODER_DEEPSEEK_ENDPOINT ?? "https://api.deepseek.com/chat/completions",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    capabilities: directCapabilities,
    transport: { channel: "http-sse", continuation: "none", replay: "pre-stream-only" },
    description: "- DeepSeek Chat Completions. Set DEEPSEEK_API_KEY."
  },
  {
    id: "mistral",
    title: "Mistral AI",
    kind: "builtin",
    runtime: "openai-chat-completions",
    command: "http",
    args: [],
    endpoint: process.env.CREWCODER_MISTRAL_ENDPOINT ?? "https://api.mistral.ai/v1/chat/completions",
    apiKeyEnv: "MISTRAL_API_KEY",
    models: ["mistral-large-latest", "codestral-latest"],
    defaultModel: "mistral-large-latest",
    capabilities: directCapabilities,
    transport: { channel: "http-sse", continuation: "none", replay: "pre-stream-only" },
    description: "- Mistral Chat Completions. Set MISTRAL_API_KEY."
  },
  {
    id: "opencode",
    title: "OpenCode Zen",
    kind: "builtin",
    runtime: "anthropic-messages",
    command: "http",
    args: [],
    endpoint: process.env.CREWCODER_OPENCODE_ENDPOINT ?? "https://opencode.ai/zen/v1/messages",
    apiKeyEnv: "OPENCODE_API_KEY",
    models: ["gpt-5.5", "gpt-5.4", "claude-opus-4-8", "grok-build-0.1"],
    defaultModel: "gpt-5.5",
    capabilities: directCapabilities,
    transport: { channel: "http-sse", continuation: "none", replay: "pre-stream-only" },
    description: "- OpenCode Zen. Set OPENCODE_API_KEY."
  },
  {
    id: "opencode-go",
    title: "OpenCode Zen Go",
    kind: "builtin",
    runtime: "anthropic-messages",
    command: "http",
    args: [],
    endpoint: process.env.CREWCODER_OPENCODE_GO_ENDPOINT ?? "https://opencode.ai/zen/go/v1/messages",
    apiKeyEnv: "OPENCODE_API_KEY",
    models: ["minimax-m3", "kimi-k2.7-code", "deepseek-v4-flash"],
    defaultModel: "minimax-m3",
    capabilities: directCapabilities,
    transport: { channel: "http-sse", continuation: "none", replay: "pre-stream-only" },
    description: "- OpenCode Go. Set OPENCODE_API_KEY."
  }
];
