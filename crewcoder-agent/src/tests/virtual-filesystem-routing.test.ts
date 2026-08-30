import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { virtualFilesystemFromMeta } from "../acp/client-files.js";
import { runAgentLoop } from "../core/agent-loop.js";
import { assistantText } from "../core/messages.js";
import type { ModelClient, ModelInput } from "../core/model-client.js";

describe("virtual filesystem routing", () => {
  it("reads virtual custody only from the explicit CrewCode metadata flag", () => {
    expect(virtualFilesystemFromMeta({ "crewcode/virtualFilesystem": true })).toBe(true);
    expect(virtualFilesystemFromMeta({ "crewcode/virtualFilesystem": false })).toBe(false);
    expect(virtualFilesystemFromMeta({ "crewcode/virtualFilesystem": "true" })).toBe(false);
    expect(virtualFilesystemFromMeta(undefined)).toBe(false);
  });

  it("keeps provider-native files enabled for a local ACP file host", async () => {
    const input = await captureModelInput(false);
    expect(input.useProviderNativeFileTools).toBe(true);
  });

  it("disables provider-native files for a remote virtual ACP file host", async () => {
    const input = await captureModelInput(true);
    expect(input.useProviderNativeFileTools).toBe(false);
  });
});

async function captureModelInput(virtualFilesystem: boolean): Promise<ModelInput> {
  let captured: ModelInput | undefined;
  const modelClient: ModelClient = {
    async complete(input) {
      captured = input;
      return assistantText("done");
    }
  };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-virtual-routing-"));

  await runAgentLoop(
    { prompt: "inspect the workspace", requestedMode: "general", cwd },
    {
      maxIterations: 1,
      persistSession: false,
      modelClient,
      textFiles: { readTextFile: async () => "host content" },
      virtualFilesystem
    }
  );

  if (!captured) throw new Error("Model input was not captured");
  return captured;
}
