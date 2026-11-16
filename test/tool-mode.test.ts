import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig, setConfigValue, writeConfig } from "../crewcoder-agent/src/core/config.js";
import { runAgentLoop } from "../crewcoder-agent/src/core/agent-loop.js";
import { runAgentLoopContinue } from "../crewcoder-agent/src/core/agent-loop-continue.js";
import { assistantText } from "../crewcoder-agent/src/core/messages.js";
import type { ModelInput, ModelClient } from "../crewcoder-agent/src/core/model-client.js";
import { loadSessionRecord as loadSession, saveSession, type SessionRecord } from "../crewcoder-agent/src/core/session-store.js";
import { resolveToolMode } from "../crewcoder-agent/src/core/tool-mode.js";
import { createWorker } from "../crewcoder-agent/src/core/identity.js";
import { writeTool } from "../crewcoder-agent/src/tools/write.js";
import { editTool } from "../crewcoder-agent/src/tools/edit.js";
import type { ApprovalMode } from "../crewcoder-agent/src/core/approval.js";
import type { ApprovalControlDecision } from "../crewcoder-agent/src/core/stdin-control.js";
import { ProviderModelClient } from "../crewcoder-agent/src/providers/provider-model-client.js";
import { enforceProviderFileCustody } from "../crewcoder-agent/src/providers/provider-file-custody.js";

const inputs: ModelInput[] = [];
const modelClient: ModelClient = { complete: async input => { inputs.push(input); return assistantText("done"); } };
const cwd = () => { fs.mkdirSync(process.env.CREWCODER_HOME!, { recursive: true }); return fs.mkdtempSync(path.join(process.env.CREWCODER_HOME!, "mode-")); };
afterEach(() => { inputs.length = 0; setConfigValue("toolMode", "native"); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("tool mode policy and session lifecycle", () => {
  it.each(["review", "always"] as const)("honors denied hosted edits under %s approval", async approvalMode => {
    const writeTextFile = vi.fn(async () => {});
    const approvalSignal: { decisions: ApprovalControlDecision[] } = { decisions: [] };
    await runAgentLoop({ cwd: cwd(), prompt: "edit marker", requestedMode: "general" }, {
      approvalMode, approvalSignal, virtualFilesystem: true, tools: [editTool],
      textFiles: { readTextFile: async () => "before", writeTextFile },
      emit: event => {
        if (event.type === "approval_required") approvalSignal.decisions.push({ approvalId: event.approvalId, approved: false });
      },
      modelClient: { complete: async (_input, _signal, stream) => {
        const result = await stream!.executeTool!({ type: "toolCall", id: "denied-edit", name: "edit", arguments: { path: "marker.txt", find: "before", replace: "after" } });
        expect(result.isError).toBe(true);
        return assistantText("denied");
      } }
    });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it.each<ApprovalMode>(["never", "review", "always", "full-access", "sandboxed"])("writes and edits through hosted tools under %s approval", async approvalMode => {
    const root = cwd();
    const files = new Map<string, string>();
    const approvalSignal: { decisions: ApprovalControlDecision[] } = { decisions: [] };
    let approvals = 0;
    await runAgentLoop({ cwd: root, prompt: "write and edit marker", requestedMode: "general" }, {
      approvalMode, approvalSignal, virtualFilesystem: true, tools: [writeTool, editTool],
      textFiles: {
        readTextFile: async file => files.get(file) ?? "",
        writeTextFile: async (file, content) => { files.set(file, content); }
      },
      emit: event => {
        if (event.type !== "approval_required") return;
        expect(files.get(path.join(root, "marker.txt"))).toBe(approvals === 0 ? undefined : "before");
        approvals++;
        approvalSignal.decisions.push({ approvalId: event.approvalId, approved: true });
      },
      modelClient: { complete: async (_input, _signal, stream) => {
        const written = await stream!.executeTool!({ type: "toolCall", id: "write-marker", name: "write", arguments: { path: "marker.txt", content: "before" } });
        expect(written.isError).toBe(false);
        const edited = await stream!.executeTool!({ type: "toolCall", id: "edit-marker", name: "edit", arguments: { path: "marker.txt", find: "before", replace: "after" } });
        expect(edited.isError).toBe(false);
        return assistantText("done");
      } }
    });
    expect(files.get(path.join(root, "marker.txt"))).toBe("after");
    expect(approvals).toBe(approvalMode === "review" || approvalMode === "always" ? 2 : 0);
    expect(fs.existsSync(path.join(root, "marker.txt"))).toBe(false);
  });

  it("defaults to native execution and validates saved values", () => {
    vi.stubEnv("CREWCODER_HOME", cwd());
    expect(readConfig().toolMode).toBe("native");
    expect(setConfigValue("toolMode", "native").toolMode).toBe("native");
    expect(readConfig().toolMode).toBe("native");
    expect(() => setConfigValue("toolMode", "both")).toThrow("toolMode must be");
    expect(readConfig().toolMode).toBe("native");
  });

  it.each([
    { hostedToolsOnly: true }, { virtualFilesystem: true }, { suppliedTools: [] },
    { mode: "crewcoder" }, { mode: "plugin" }, { mode: "extension" }
  ])("host and workflow policy override native preference: %j", policy => {
    expect(resolveToolMode("native", { mode: "general", ...policy })).toBe("crewcoder");
  });

  it("offers CrewCoder tools with local file custody kept separate", async () => {
    await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, { modelClient, providerId: "codex-cli", toolMode: "crewcoder" });
    expect(inputs[0]?.toolMode).toBe("crewcoder");
    expect(inputs[0]?.useProviderNativeFileTools).toBe(true);
    expect(inputs[0]?.availableTools.map(t => t.name)).toContain("bash");
  });

  it.each(["codex-cli", "claude"])("combines %s native execution with specialized tools by default", async providerId => {
    vi.stubEnv("CREWCODER_TASKS_ENABLED", "true");
    await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, { providerId, modelClient });
    const input = inputs[0]!;
    expect(input.toolMode).toBe("native");
    expect(input.useProviderNativeFileTools).toBe(true);
    const names = input.availableTools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(["lsp_definition", "lsp_hover", "lsp_diagnostics", "edit_symbol", "edit_transaction", "TaskCreate", "TaskUpdate", "remember", "delegateWorker", "git_log"]));
    for (const name of ["read", "write", "edit", "grep", "listFiles", "bash", "background_job"]) expect(names).not.toContain(name);
    expect(input.systemPrompt).toContain("crew-tasks is enabled");
    expect(input.systemPrompt).toContain("specialized tools and trusted extension tools remain available");
  });

  it("keeps specialized tools in native delegated workers", async () => {
    createWorker("native-researcher", { description: "Research" });
    let calls = 0;
    await runAgentLoop({ cwd: cwd(), prompt: "delegate research", requestedMode: "general" }, {
      providerId: "codex-cli", maxIterations: 2,
      modelClient: { complete: async input => {
        calls++;
        expect(input.toolMode).toBe("native");
        expect(input.availableTools.map(t => t.name)).toContain("remember");
        expect(input.availableTools.map(t => t.name)).not.toContain("bash");
        if (calls === 1) return { role: "assistant", content: [{ type: "toolCall", id: "native-delegate", name: "delegateWorker", arguments: {
          worker: "native-researcher", task: "Research the fixture", maxIterations: 1
        } }], stopReason: "tool_calls", timestamp: Date.now() };
        return assistantText(calls === 2 ? "child summary" : "parent done");
      } }
    });
    expect(calls).toBe(3);
  });

  it("keeps additive host tools alongside native execution", async () => {
    await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, { providerId: "codex-cli", modelClient, additionalTools: [writeTool] });
    expect(inputs[0]?.toolMode).toBe("native");
    expect(inputs[0]?.availableTools.map(t => t.name)).toContain("write");
    expect(resolveToolMode("native", { mode: "general", additionalTools: [writeTool] })).toBe("native");
  });

  it.each(["opencode", "openai"])("falls back to full CrewCoder tools for %s", async providerId => {
    await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, { providerId, modelClient });
    expect(inputs[0]?.toolMode).toBe("crewcoder");
    expect(inputs[0]?.availableTools.map(t => t.name)).toEqual(expect.arrayContaining(["read", "write", "bash", "remember", "edit_transaction"]));
  });

  it("uses CrewCoder execution for Claude when OS sandboxing is required", async () => {
    await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, {
      providerId: "claude", approvalMode: "sandboxed", modelClient
    });
    expect(inputs[0]?.toolMode).toBe("crewcoder");
    expect(inputs[0]?.availableTools.map(t => t.name)).toContain("bash");
    expect(inputs[0]?.approvalMode).toBe("sandboxed");
  });

  it("executes transactional edits through the CrewCoder executor in native mode", async () => {
    const root = cwd();
    fs.writeFileSync(path.join(root, "marker.txt"), "before");
    await runAgentLoop({ cwd: root, prompt: "edit marker", requestedMode: "general" }, {
      providerId: "codex-cli", approvalMode: "full-access",
      modelClient: { complete: async (input, _signal, stream) => {
        expect(input.toolMode).toBe("native");
        const result = await stream!.executeTool!({ type: "toolCall", id: "transaction", name: "edit_transaction", arguments: {
          edits: [{ path: "marker.txt", find: "before", replace: "after" }]
        } });
        expect(result.isError).toBe(false);
        return assistantText("done");
      } }
    });
    expect(fs.readFileSync(path.join(root, "marker.txt"), "utf8")).toBe("after");
  });

  it("keeps specialized mutation approval enforceable with native execution", async () => {
    const root = cwd();
    fs.writeFileSync(path.join(root, "marker.txt"), "before");
    const approvalSignal: { decisions: ApprovalControlDecision[] } = { decisions: [] };
    await runAgentLoop({ cwd: root, prompt: "edit", requestedMode: "general" }, {
      providerId: "claude", approvalMode: "review", approvalSignal,
      emit: event => {
        if (event.type === "approval_required") approvalSignal.decisions.push({ approvalId: event.approvalId, approved: false });
      },
      modelClient: { complete: async (input, _signal, stream) => {
        expect(input.toolMode).toBe("native");
        const result = await stream!.executeTool!({ type: "toolCall", id: "denied-transaction", name: "edit_transaction", arguments: {
          edits: [{ path: "marker.txt", find: "before", replace: "after" }]
        } });
        expect(result.isError).toBe(true);
        return assistantText("denied");
      } }
    });
    expect(fs.readFileSync(path.join(root, "marker.txt"), "utf8")).toBe("before");
  });

  it("preserves a native preference across provider changes and API fallback", async () => {
    const first = await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, { modelClient, providerId: "codex-cli" });
    await runAgentLoopContinue({ sessionId: first.sessionId, prompt: "api" }, { modelClient, providerId: "opencode" });
    expect(inputs.at(-1)?.toolMode).toBe("crewcoder");
    expect((await loadSession(first.sessionId)).toolMode).toBe("native");
    await runAgentLoopContinue({ sessionId: first.sessionId, prompt: "native again" }, { modelClient, providerId: "claude" });
    expect(inputs.at(-1)?.toolMode).toBe("native");
    expect(inputs.at(-1)?.availableTools.map(t => t.name)).toContain("remember");
  });

  it("retains trusted extension tools in native mode without granting trust", async () => {
    const extensionDir = path.join(process.env.CREWCODER_HOME!, "extensions", "native-pack");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(path.join(extensionDir, "crewcoder.extension.json"), JSON.stringify({
      id: "native-pack", name: "Native Pack", version: "0.1.0", crewcoder: { apiVersion: "0.1" },
      contributes: { tools: [{ id: "hello", title: "Hello", command: process.execPath, args: ["-e", "console.log('hi')"] }] }
    }));
    const original = readConfig();
    try {
      writeConfig({ ...original, allowExtensionTools: true, trustedExtensions: [] });
      await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, { modelClient, providerId: "codex-cli" });
      expect(inputs.at(-1)?.availableTools.map(t => t.name)).not.toContain("extension_native-pack_hello");
      writeConfig({ ...original, allowExtensionTools: true, trustedExtensions: ["native-pack"] });
      await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, { modelClient, providerId: "codex-cli" });
      expect(inputs.at(-1)?.toolMode).toBe("native");
      expect(inputs.at(-1)?.availableTools.map(t => t.name)).toContain("extension_native-pack_hello");
    } finally {
      writeConfig(original);
    }
  });

  it("writes locally through CrewCoder tools with a custom model client", async () => {
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
    const first = await runAgentLoop({ cwd: cwd(), prompt: "hi", requestedMode: "general" }, { modelClient, providerId: "codex-cli" });
    expect((await loadSession(first.sessionId)).toolMode).toBe(initial);
    setConfigValue("toolMode", initial === "native" ? "crewcoder" : "native");
    await runAgentLoopContinue({ sessionId: first.sessionId, prompt: "again" }, { modelClient, providerId: "codex-cli" });
    expect(inputs.at(-1)?.toolMode).toBe(initial);
    const fresh = await runAgentLoop({ cwd: cwd(), prompt: "fresh", requestedMode: "general" }, { modelClient, providerId: "codex-cli" });
    expect((await loadSession(fresh.sessionId)).toolMode).not.toBe(initial);
  });

  it("keeps pre-setting sessions on their previous adapter behavior", async () => {
    const record: SessionRecord = { id: "legacy-mode", cwd: cwd(), startedAt: new Date().toISOString(),
      requestedMode: "general", resolvedMode: "general", prompt: "old", events: [], messages: [], mutationLog: [] };
    await saveSession(record);
    setConfigValue("toolMode", "native");
    await runAgentLoopContinue({ sessionId: record.id, prompt: "again" }, { modelClient, providerId: "codex-cli" });
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
