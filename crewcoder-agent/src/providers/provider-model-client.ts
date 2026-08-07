import type { AssistantMessage } from "../core/messages.js";
import { assistantText, getText } from "../core/messages.js";
import { parseProviderOutput, providerErrorMessage, providerResponseToAssistantMessage } from "./output-parser.js";
import type { ModelClient, ModelInput, ModelStreamCallbacks } from "../core/model-client.js";
import { findProvider } from "./provider-registry.js";
import { runProcessProvider } from "./process-provider.js";
import { runHttpMessagesProvider } from "./http-provider.js";
import { runOpenAIResponsesProvider } from "./openai-responses-provider.js";
import { runCodexProvider } from "./codex-provider.js";
import { closeCodexWebSocketSessions } from "./codex-websocket-transport.js";
import { resolveProviderModel } from "./model-resolution.js";
import { runWebSocketProvider } from "./websocket-provider.js";
import { runClaudeAgentSdkProvider } from "./claude-agent-sdk-provider.js";
import { runAcpClientProvider } from "./acp-client-provider.js";
import type { BackendDebugLogger } from "../core/backend-debug-logger.js";
import { resolveProviderTransport } from "./provider-transport.js";

export class ProviderModelClient implements ModelClient {
  constructor(private readonly providerId: string, private readonly cwd: string, private readonly model?: string, private readonly debug?: BackendDebugLogger, private readonly reasoningEffort?: string) {}

  resetSessionContinuation(sessionId: string): void {
    if (this.providerId === "codex") closeCodexWebSocketSessions(sessionId);
  }

  async complete(input: ModelInput, signal?: AbortSignal, stream?: ModelStreamCallbacks): Promise<AssistantMessage> {
    const provider = await findProvider(this.providerId);
    if (!provider) {
      await this.debug?.event({ level: "error", source: "provider.registry", message: "provider not found", details: { providerId: this.providerId } });
      return { ...assistantText(`Provider not found: ${this.providerId}`, "error"), errorMessage: `Provider not found: ${this.providerId}` };
    }

    const last = input.messages[input.messages.length - 1];
    const prompt = [input.systemPrompt, last ? getText(last) : ""].filter(Boolean).join("\n\nUser request:\n");
    const model = resolveProviderModel(provider, this.model);
    const transport = resolveProviderTransport(provider);
    await this.debug?.event({ level: "debug", source: "provider.client", message: "provider prompt prepared", details: { providerId: this.providerId, model, promptChars: prompt.length, transport: transport.channel, continuation: transport.continuation, replay: transport.replay } });
    const request = { provider, prompt, cwd: this.cwd, model, reasoningEffort: this.reasoningEffort, modelInput: input, session: input.session, debug: this.debug, stream };
    const result = provider.runtime === "claude-agent-sdk"
      ? await runClaudeAgentSdkProvider(request, signal)
      : provider.runtime === "acp-client"
      ? await runAcpClientProvider(request, signal)
      : provider.runtime === "anthropic-messages" || provider.runtime === "openai-chat-completions"
      ? await runHttpMessagesProvider(request, signal)
      : provider.runtime === "openai-responses"
        ? await runOpenAIResponsesProvider(request, signal)
        : provider.runtime === "openai-codex-responses"
          ? await runCodexProvider(request, signal)
          : provider.runtime === "websocket"
            ? await runWebSocketProvider(request, signal)
            : await runProcessProvider(request, signal);
    if (result.usage) await stream?.onUsage?.(result.usage);
    if (result.exitCode !== 0) {
      const message = providerErrorMessage(result.stderr.trim() || result.text);
      await this.debug?.event({ level: "error", source: "provider.client", message: "provider request failed", details: { providerId: this.providerId, model, exitCode: result.exitCode, error: message } });
      return { ...assistantText(`${this.providerId} request failed: ${message}`, "error"), errorMessage: message };
    }
    return providerResponseToAssistantMessage(parseProviderOutput(result.text));
  }
}
