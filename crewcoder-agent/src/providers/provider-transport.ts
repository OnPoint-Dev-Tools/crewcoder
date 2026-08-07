import type { ProviderDefinition, ProviderRuntime, ProviderTransportProfile } from "./types.js";

const DEFAULT_TRANSPORTS: Record<ProviderRuntime, ProviderTransportProfile> = {
  process: { channel: "process", continuation: "none", replay: "never" },
  "model-command": { channel: "process", continuation: "provider-session", replay: "never" },
  "claude-agent-sdk": { channel: "process", continuation: "provider-session", replay: "never" },
  "acp-client": { channel: "process", continuation: "provider-session", replay: "never" },
  "anthropic-messages": { channel: "http-sse", continuation: "none", replay: "pre-stream-only" },
  "openai-chat-completions": { channel: "http-sse", continuation: "none", replay: "pre-stream-only" },
  "openai-responses": { channel: "http-sse", continuation: "none", replay: "pre-stream-only" },
  "openai-codex-responses": { channel: "process", continuation: "provider-session", fallback: "http-sse", replay: "never" },
  websocket: { channel: "websocket", continuation: "provider-session", replay: "never" }
};

const EXTENSION_RUNTIMES = new Set<ProviderRuntime>([
  "process",
  "model-command",
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
  "websocket"
]);

export function resolveProviderTransport(provider: ProviderDefinition): ProviderTransportProfile {
  const profile = provider.transport ?? DEFAULT_TRANSPORTS[provider.runtime];
  validateProviderTransport(provider.runtime, profile, provider.kind);
  return profile;
}

export function validateProviderTransport(runtime: ProviderRuntime, profile: ProviderTransportProfile, kind: ProviderDefinition["kind"]): void {
  if (kind === "extension" && !EXTENSION_RUNTIMES.has(runtime)) {
    throw new Error(`Extension providers cannot use credential-owning runtime ${runtime}`);
  }

  const allowedChannels = runtime === "process" || runtime === "model-command" || runtime === "claude-agent-sdk" || runtime === "acp-client"
    ? new Set(["process"])
    : runtime === "anthropic-messages" || runtime === "openai-chat-completions" || runtime === "openai-responses"
      ? new Set(["http-sse"])
      : runtime === "openai-codex-responses"
        ? new Set(["process"])
        : new Set(["websocket"]);
  if (!allowedChannels.has(profile.channel)) {
    throw new Error(`Provider runtime ${runtime} cannot use ${profile.channel} transport`);
  }
  if (profile.fallback === profile.channel) throw new Error("Provider transport fallback must differ from its primary channel");
  if (profile.continuation === "connection-cache" && profile.channel !== "websocket") {
    throw new Error("Connection-cached continuation requires WebSocket transport");
  }
  if (profile.continuation === "provider-session" && profile.channel !== "process" && profile.channel !== "websocket") {
    throw new Error("Provider-session continuation requires process or WebSocket transport");
  }
  if (profile.fallback !== undefined && runtime !== "openai-codex-responses") {
    throw new Error(`Provider runtime ${runtime} does not implement transport fallback`);
  }
  if (profile.replay === "pre-stream-only" && profile.channel === "process") {
    throw new Error(`Provider runtime ${runtime} does not expose a stream boundary for safe replay`);
  }

  const defaults = DEFAULT_TRANSPORTS[runtime];
  const matchesFixedContract = profile.channel === defaults.channel
    && profile.continuation === defaults.continuation
    && profile.fallback === defaults.fallback
    && profile.replay === defaults.replay;
  if (!matchesFixedContract) throw new Error(`Provider runtime ${runtime} has a fixed transport contract`);
}

export function defaultProviderTransport(runtime: ProviderRuntime): ProviderTransportProfile {
  return { ...DEFAULT_TRANSPORTS[runtime] };
}
