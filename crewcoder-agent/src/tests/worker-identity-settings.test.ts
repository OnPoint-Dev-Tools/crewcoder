import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../core/agent-loop.js";
import { readConfig, setConfigValue } from "../core/config.js";
import { createWorker, setActiveWorker } from "../core/identity.js";
import { assistantText } from "../core/messages.js";
import { saveSystemPrompt } from "../core/system-prompt-store.js";
import type { ModelClient } from "../core/model-client.js";
import { isolatedCrewCoderTestHome } from "./test-home-setup.js";

let home: string;
let cwd: string;
beforeEach(() => {
  fs.mkdirSync(isolatedCrewCoderTestHome, { recursive: true });
  home = fs.mkdtempSync(path.join(isolatedCrewCoderTestHome, "identity-setting-"));
  cwd = path.join(home, "workspace");
  fs.mkdirSync(cwd);
  vi.stubEnv("CREWCODER_HOME", home);
});
afterEach(() => vi.unstubAllEnvs());

async function promptForRun(options: { worker?: string; hostIdentity?: boolean; custom?: string } = {}): Promise<string> {
  let systemPrompt = "";
  const modelClient: ModelClient = {
    async complete(input) {
      systemPrompt = input.systemPrompt;
      return assistantText("done");
    }
  };
  const custom = options.custom ? saveSystemPrompt("identity-test", options.custom) : undefined;
  await runAgentLoop({ cwd, prompt: "Inspect this project", requestedMode: "general" }, {
    modelClient, persistSession: false, maxIterations: 1, workerName: options.worker,
    workerIdentity: options.hostIdentity, systemPromptName: custom?.name,
    clientSystemPrompt: "HOST-SYSTEM-MARKER"
  });
  return systemPrompt;
}

describe("optional worker identity", () => {
  it("defaults identity off and validates persisted boolean settings without changing the selected worker", () => {
    expect(readConfig()).toMatchObject({ workerIdentityEnabled: false, activeWorker: "Crew" });
    createWorker("Reviewer");
    setActiveWorker("Reviewer");
    setConfigValue("workerIdentityEnabled", "false");
    expect(readConfig()).toMatchObject({ workerIdentityEnabled: false, activeWorker: "Reviewer" });
    expect(() => setConfigValue("workerIdentityEnabled", "off")).toThrow("must be true or false");
    expect(readConfig().workerIdentityEnabled).toBe(false);
    setConfigValue("workerIdentityEnabled", "true");
    expect(readConfig()).toMatchObject({ workerIdentityEnabled: true, activeWorker: "Reviewer" });
  });

  it("omits automatic identity without creating a worker while preserving default, custom and host system prompts", async () => {
    const prompt = await promptForRun({ custom: "CUSTOM-SYSTEM-MARKER" });
    expect(prompt).toContain("You are in General Coding Agent mode.");
    expect(prompt).toContain("CUSTOM-SYSTEM-MARKER");
    expect(prompt).toContain("HOST-SYSTEM-MARKER");
    expect(prompt).not.toContain("the active worker for this CrewCoder instance");
    expect(prompt).not.toContain("Worker identity (IDENTITY.md)");
    expect(fs.existsSync(path.join(home, "workers"))).toBe(false);
  });

  it.each([undefined, false, "true", "false", 1, null])("requires explicit boolean opt-in in saved config (%s)", (value) => {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ activeWorker: "Reviewer", workerIdentityEnabled: value }), "utf8");
    expect(readConfig()).toMatchObject({ workerIdentityEnabled: false, activeWorker: "Reviewer" });
  });

  it("preserves explicit workers and restores their identity after re-enabling", async () => {
    const worker = createWorker("Reviewer", { ownerName: "OWNER-MARKER", description: "DESCRIPTION-MARKER" });
    const file = path.join(worker.dir, "IDENTITY.md");
    fs.writeFileSync(file, "PERSONA-MARKER", "utf8");
    setActiveWorker("Reviewer");
    setConfigValue("workerIdentityEnabled", "false");
    const disabled = await promptForRun({ worker: "Reviewer" });
    for (const marker of ["OWNER-MARKER", "DESCRIPTION-MARKER", "PERSONA-MARKER"]) expect(disabled).not.toContain(marker);
    expect(fs.readFileSync(file, "utf8")).toBe("PERSONA-MARKER");
    setConfigValue("workerIdentityEnabled", "true");
    const enabled = await promptForRun();
    for (const marker of ["OWNER-MARKER", "DESCRIPTION-MARKER", "PERSONA-MARKER"]) expect(enabled).toContain(marker);
    expect(readConfig().activeWorker).toBe("Reviewer");
  });

  it.each([
    { configured: false, hostIdentity: true },
    { configured: true, hostIdentity: false }
  ])("requires both user and host identity settings to permit identity ($configured/$hostIdentity)", async ({ configured, hostIdentity }) => {
    setConfigValue("workerIdentityEnabled", String(configured));
    const prompt = await promptForRun({ hostIdentity });
    expect(prompt).not.toContain("the active worker for this CrewCoder instance");
    expect(prompt).toContain("HOST-SYSTEM-MARKER");
    expect(fs.existsSync(path.join(home, "workers"))).toBe(false);
  });

  it("still validates an explicitly selected worker when identity is disabled", async () => {
    setConfigValue("workerIdentityEnabled", "false");
    await expect(promptForRun({ worker: "missing" })).rejects.toThrow("Worker not found: missing");
  });

  it("preserves host identity suppression when a named child worker is invoked", async () => {
    setConfigValue("workerIdentityEnabled", "true");
    createWorker("Researcher", { description: "CHILD-IDENTITY-MARKER" });
    let calls = 0;
    const modelClient: ModelClient = {
      async complete(input) {
        calls += 1;
        expect(input.systemPrompt).not.toContain("the active worker for this CrewCoder instance");
        expect(input.systemPrompt).not.toContain("CHILD-IDENTITY-MARKER");
        if (calls === 1) {
          return { role: "assistant", content: [{ type: "toolCall", id: "delegate-1", name: "delegateWorker", arguments: { worker: "Researcher", task: "Inspect a detail", maxIterations: 1 } }], stopReason: "tool_calls", timestamp: Date.now() };
        }
        return assistantText(calls === 2 ? "child done" : "parent done");
      }
    };
    const result = await runAgentLoop({ cwd, prompt: "Coordinate work", requestedMode: "general" }, {
      modelClient, persistSession: false, maxIterations: 2, workerIdentity: false
    });
    expect(calls).toBe(3);
    expect(result.summary).toContain("parent done");
  });
});
