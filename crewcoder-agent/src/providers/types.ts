import type { ModelInput, ModelSessionContext, ModelStreamCallbacks } from "../core/model-client.js";
import type { ModelUsage } from "../core/usage.js";

export type ProviderKind = "builtin" | "extension";
export type ProviderAuthScheme = "bearer" | "anthropic-key" | "bearer-and-anthropic-key";
export type ProviderRuntime = "process" | "model-command" | "claude-agent-sdk" | "acp-client" | "anthropic-messages" | "openai-chat-completions" | "openai-responses" | "openai-codex-responses" | "websocket";

export type ProviderModel = {
  id: string;
  title?: string;
  contextWindow?: number;
  /** Model-specific override for emitting multiple tool calls in one response. */
  parallelToolCalls?: boolean;
};

export type ProviderTransportChannel = "process" | "http-sse" | "websocket";
export type ProviderContinuationMode = "none" | "response-id" | "connection-cache" | "provider-session";
export type ProviderReplayPolicy = "never" | "pre-stream-only";

export type ProviderTransportProfile = {
  /** Physical request channel implemented by the selected provider runtime. */
  channel: ProviderTransportChannel;
  /** How later model turns avoid resending already-accepted context. */
  continuation: ProviderContinuationMode;
  /** Vetted fallback implemented by the runtime; declaration alone never enables one. */
  fallback?: ProviderTransportChannel;
  /** Requests may only be replayed according to this stream-boundary policy. */
  replay: ProviderReplayPolicy;
};

export type ProviderCapabilities = {
  streaming: boolean;
  toolCalling: boolean;
  /** Provider default for emitting multiple tool calls in one response. */
  parallelToolCalls: boolean;
  sessionResume: boolean;
  acceptsSystemPrompt: boolean;
  acceptsWorkingDirectory: boolean;
};

export type ProviderDefinition = {
  id: string;
  title: string;
  kind: ProviderKind;
  runtime: ProviderRuntime;
  command: string;
  args: string[];
  endpoint?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  authScheme?: ProviderAuthScheme;
  headers?: Record<string, string>;
  models?: string[];
  modelCatalog?: ProviderModel[];
  defaultModel?: string;
  env?: Record<string, string>;
  description?: string;
  extensionId?: string;
  capabilities?: Partial<ProviderCapabilities>;
  /** Checked transport behavior. Omitted profiles use the runtime's core default. */
  transport?: ProviderTransportProfile;
};

export type ProviderRunInput = {
  provider: ProviderDefinition;
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  modelInput?: ModelInput;
  session?: ModelSessionContext;
  debug?: {
    event(event: { level: "debug" | "info" | "warn" | "error"; source: string; message: string; details?: Record<string, unknown> }): Promise<void>;
  };
  stream?: ModelStreamCallbacks;
};

export type ProviderRunResult = {
  providerId: string;
  text: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  usage?: ModelUsage;
};
