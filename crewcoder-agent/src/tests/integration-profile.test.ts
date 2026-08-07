import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectCrewCodeProject, readProjectIntegrationProfile, resolveIntegrationProfile, setCrewCodeProfilePromptDismissed, setProjectIntegrationProfile } from "../core/integration-profile.js";
import { createToolRegistry } from "../tools/index.js";

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

  it("omits CrewCode plugin tools in standalone mode", () => {
    const standalone = createToolRegistry("standalone").map((tool) => tool.name);
    const crewcode = createToolRegistry("crewcode").map((tool) => tool.name);
    expect(standalone).not.toContain("createPlugin");
    expect(standalone).not.toContain("validatePlugin");
    expect(crewcode).toContain("createPlugin");
    expect(crewcode).toContain("validatePlugin");
    const standaloneDocs = createToolRegistry("standalone").find((tool) => tool.name === "docs")?.description;
    expect(standaloneDocs).not.toContain("CrewCode app");
    expect(standaloneDocs).not.toContain("crewcode.plugin.json");
    expect(createToolRegistry("crewcode").find((tool) => tool.name === "docs")?.description).toContain("CrewCode app");
  });
});
