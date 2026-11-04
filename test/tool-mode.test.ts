import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig, setConfigValue } from "../crewcoder-agent/src/core/config.js";
import { runAgentLoop } from "../crewcoder-agent/src/core/agent-loop.js";
import { runAgentLoopContinue } from "../crewcoder-agent/src/core/agent-loop-continue.js";
import { assistantText } from "../crewcoder-agent/src/core/messages.js";
import type { ModelInput, ModelClient } from "../crewcoder-agent/src/core/model-client.js";
import { loadSessionRecord as loadSession, saveSession, type SessionRecord } from "../crewcoder-agent/src/core/session-store.js";
import { resolveToolMode } from "../crewcoder-agent/src/core/tool-mode.js";
import { writeTool } from "../crewcoder-agent/src/tools/write.js";
import { ProviderModelClient } from "../crewcoder-agent/src/providers/provider-model-client.js";
import { enforceProviderFileCustody } from "../crewcoder-agent/src/providers/provider-file-custody.js";

const inputs: ModelInput[] = [];
const modelClient: ModelClient = { complete: async input => { inputs.push(input); return assistantText("done"); } };
const cwd = () => { fs.mkdirSync(process.env.CREWCODER_HOME!, { recursive: true }); return fs.mkdtempSync(path.join(process.env.CREWCODER_HOME!, "mode-")); };
afterEach(() => { inputs.length = 0; setConfigValue("toolMode", "crewcoder"); vi.restoreAllMocks(); });

describe("tool mode policy and session lifecycle", () => {
  it("defaults to CrewCoder and validates saved values", () => {
    expect(readConfig().toolMode).toBe("crewcoder");
    expect(setConfigValue("toolMode", "native").toolMode).toBe("native");
    expect(readConfig().toolMode).toBe("native");
    expect(() => setConfigValue("toolMode", "both")).toThrow("toolMode must be");
    expect(readConfig().toolMode).toBe("native");
  });

  it.each([
    { hostedToolsOnly: true }, { virtualFilesystem: true }, { suppliedTools: [] },
    { additionalTools: [writeTool] }, { mode: "crewcoder" }, { mode: "plugin" }, { mode: "extension" }
  ])("host and workflow policy override native preference: %j", policy => {
    expect(resolveToolMode("native", { mode: "general", ...policy })).toBe("crewcoder");
  });

  it("offers CrewCoder tools with local file custody kept separate", async () => {
    await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, { modelClient });
    expect(inputs[0]?.toolMode).toBe("crewcoder");
    expect(inputs[0]?.useProviderNativeFileTools).toBe(true);
    expect(inputs[0]?.availableTools.map(t => t.name)).toContain("bash");
  });

  it("offers no CrewCoder coding tools in native mode", async () => {
    setConfigValue("toolMode", "native");
    await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, { modelClient });
    expect(inputs[0]?.toolMode).toBe("native");
    expect(inputs[0]?.availableTools).toEqual([]);
  });

  it("writes locally through CrewCoder tools in the default mode", async () => {
    const root = cwd();
    await runAgentLoop({ cwd: root, prompt: "write marker", requestedMode: "general" }, {
      modelClient: { complete: async (_input, _signal, stream) => {
        const result = await stream!.executeTool!({ type: "toolCall", id: "local-write", name: "write", arguments: { path: "marker.txt", content: "tool-mode-marker" } });
        expect(result.isError).toBe(false);
        return assistantText("done");
      } }
    });
    expect(fs.readFileSync(path.join(root, "marker.txt"), "utf8")).toBe("tool-mode-marker");
  });

  it("refuses subprocess providers that cannot enforce CrewCoder tool ownership", () => {
    expect(() => enforceProviderFileCustody({
      provider: { id: "custom", title: "Custom", kind: "extension", runtime: "process", command: "custom", args: [] }, cwd: cwd(),
      modelInput: { systemPrompt: "", messages: [], availableTools: [], toolMode: "crewcoder", useProviderNativeFileTools: true }
    })).toThrow("custody unavailable");
  });

  it.each(["crewcoder", "native"] as const)("pins %s through save, config change, and resume", async initial => {
    setConfigValue("toolMode", initial);
    const first = await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, { modelClient });
    expect((await loadSession(first.sessionId)).toolMode).toBe(initial);
    setConfigValue("toolMode", initial === "native" ? "crewcoder" : "native");
    await runAgentLoopContinue({ sessionId: first.sessionId, prompt: "again" }, { modelClient });
    expect(inputs.at(-1)?.toolMode).toBe(initial);
    const fresh = await runAgentLoop({ cwd: cwd(), prompt: "fresh", requestedMode: "general" }, { modelClient });
    expect((await loadSession(fresh.sessionId)).toolMode).not.toBe(initial);
  });

  it("keeps pre-setting sessions on their previous adapter behavior", async () => {
    const record: SessionRecord = { id: "legacy-mode", cwd: cwd(), startedAt: new Date().toISOString(),
      requestedMode: "general", resolvedMode: "general", prompt: "old", events: [], messages: [], mutationLog: [] };
    await saveSession(record);
    setConfigValue("toolMode", "native");
    await runAgentLoopContinue({ sessionId: record.id, prompt: "again" }, { modelClient });
    expect(inputs.at(-1)?.toolMode).toBeUndefined();
    expect(inputs.at(-1)?.availableTools.map(t => t.name)).toContain("bash");
  });

  it("keeps approved host tools writable despite a native preference", async () => {
    setConfigValue("toolMode", "native");
    let written = "";
    const client: ModelClient = { complete: async (input, _signal, stream) => {
      expect(input.toolMode).toBe("crewcoder");
      expect(input.useProviderNativeFileTools).toBe(false);
      const result = await stream!.executeTool!({ type: "toolCall", id: "write", name: "write", arguments: { path: "record", content: "marker" } });
      expect(result.isError).toBe(false);
      return assistantText("done");
    } };
    await runAgentLoop({ cwd: cwd(), prompt: "write", requestedMode: "general" }, {
      hostedToolsOnly: true, tools: [writeTool], modelClient: client,
      textFiles: { readTextFile: async () => "", writeTextFile: async (_path, content) => { written = content; } }
    });
    expect(written).toBe("marker");
  });

  it("rejects native mode for API-only providers before any request", async () => {
    await expect(new ProviderModelClient("opencode", cwd()).complete({
      systemPrompt: "", messages: [], availableTools: [], toolMode: "native"
    })).rejects.toThrow("does not expose native tools");
  });
});
