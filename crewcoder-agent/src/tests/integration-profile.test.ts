import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectCrewCodeProject, readProjectIntegrationProfile, resolveIntegrationProfile, setCrewCodeProfilePromptDismissed, setProjectIntegrationProfile } from "../core/integration-profile.js";
import { createToolRegistry } from "../tools/index.js";
import { runAgentLoop } from "../core/agent-loop.js";
import { assistantText } from "../core/messages.js";

const roots: string[] = [];
function tempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-profile-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("integration profiles", () => {
  it("defaults to standalone and lets a repository override the user profile", () => {
    const cwd = tempRepo();
    expect(resolveIntegrationProfile(cwd, { integrationProfile: "standalone" })).toBe("standalone");
    expect(resolveIntegrationProfile(cwd, { integrationProfile: "crewcode" })).toBe("crewcode");

    setProjectIntegrationProfile(cwd, "standalone");
    expect(readProjectIntegrationProfile(cwd)).toBe("standalone");
    expect(resolveIntegrationProfile(cwd, { integrationProfile: "crewcode" })).toBe("standalone");
  });

  it("preserves teams when writing a project profile", () => {
    const cwd = tempRepo();
    fs.writeFileSync(path.join(cwd, "crewcoder.json"), JSON.stringify({ teams: { feature: { roles: ["builder"] } } }), "utf8");
    setProjectIntegrationProfile(cwd, "crewcode");
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "crewcoder.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.integrationProfile).toBe("crewcode");
    expect(manifest.teams).toBeDefined();
  });

  it("detects a root CrewCode marker and persists one-time dismissal", () => {
    const cwd = tempRepo();
    fs.writeFileSync(path.join(cwd, "crewcode.plugin.json"), "{}\n", "utf8");
    expect(detectCrewCodeProject(cwd)).toMatchObject({ detected: true, markers: ["crewcode.plugin.json"], shouldPrompt: true });

    setCrewCodeProfilePromptDismissed(cwd);
    expect(detectCrewCodeProject(cwd)).toMatchObject({ dismissed: true, shouldPrompt: false });

    setProjectIntegrationProfile(cwd, "crewcode");
    expect(detectCrewCodeProject(cwd)).toMatchObject({ hasProjectProfile: true, dismissed: false, shouldPrompt: false });
  });

  it("scopes built-in authoring tools by explicit mode and profile", () => {
    const authoring = ["createCrewCoderExtension", "docs", "createPlugin", "validatePlugin", "listPluginTemplates"];
    const general = createToolRegistry("crewcode", "general").map((tool) => tool.name);
    const extension = createToolRegistry("standalone", "extension").map((tool) => tool.name);
    const plugin = createToolRegistry("crewcode", "plugin").map((tool) => tool.name);
    const unavailablePlugin = createToolRegistry("standalone", "plugin").map((tool) => tool.name);

    expect(general.filter((name) => authoring.includes(name))).toEqual([]);
    expect(extension.filter((name) => authoring.includes(name))).toEqual(["createCrewCoderExtension", "docs"]);
    expect(plugin.filter((name) => authoring.includes(name))).toEqual(["docs", "createPlugin", "validatePlugin", "listPluginTemplates"]);
    expect(unavailablePlugin.filter((name) => authoring.includes(name))).toEqual([]);
    expect(createToolRegistry("standalone", "extension").find((tool) => tool.name === "docs")?.description).toContain("CrewCoder extension");
    expect(createToolRegistry("crewcode", "plugin").find((tool) => tool.name === "docs")?.description).toContain("CrewCode app plugin");
  });

  it.each([
    ["general", []],
    ["plugin", ["docs", "createPlugin", "validatePlugin", "listPluginTemplates"]],
    ["extension", ["createCrewCoderExtension", "docs"]],
  ] as const)("sends only %s-mode authoring tools to the model", async (mode, expected) => {
    const cwd = tempRepo();
    let names: string[] = [];
    await runAgentLoop(
      { prompt: "inspect the available tools", requestedMode: mode, cwd },
      {
        integrationProfile: "crewcode",
        persistSession: false,
        maxIterations: 1,
        modelClient: {
          async complete(input) {
            names = input.availableTools.map((tool) => tool.name);
            return assistantText("done");
          }
        }
      }
    );

    const authoring = new Set(["createCrewCoderExtension", "docs", "createPlugin", "validatePlugin", "listPluginTemplates"]);
    expect(names.filter((name) => authoring.has(name))).toEqual([...expected]);
  });
});
