import type { ProviderRunInput, ProviderRuntime } from "./types.js";

export type VirtualFileSystemPolicy = "crewcoder-tool-loop" | "adapter-routed" | "unsupported";

const VIRTUAL_FILESYSTEM_POLICIES: Record<ProviderRuntime, VirtualFileSystemPolicy> = {
  "anthropic-messages": "crewcoder-tool-loop",
  "openai-chat-completions": "crewcoder-tool-loop",
  "openai-responses": "crewcoder-tool-loop",
  websocket: "crewcoder-tool-loop",
  "claude-agent-sdk": "adapter-routed",
  "openai-codex-responses": "adapter-routed",
  "acp-client": "unsupported",
  "model-command": "unsupported",
  process: "unsupported"
};

export function virtualFileSystemPolicy(runtime: ProviderRuntime): VirtualFileSystemPolicy {
  return VIRTUAL_FILESYSTEM_POLICIES[runtime];
}

export function enforceProviderFileCustody(input: Pick<ProviderRunInput, "provider" | "modelInput" | "cwd">): void {
  if (input.modelInput?.useProviderNativeFileTools !== false) return;
  if (virtualFileSystemPolicy(input.provider.runtime) !== "unsupported") return;
  throw new Error(
    `Virtual filesystem custody unavailable for provider "${input.provider.id}" `
    + `(runtime ${input.provider.runtime}) at ${input.cwd}: this runtime may access the local host `
    + "outside CrewCoder's ACP/SDK file boundary. Select a CrewCoder tool-routed provider for this remote workspace."
  );
}
