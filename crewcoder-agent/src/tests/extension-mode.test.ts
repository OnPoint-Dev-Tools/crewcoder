import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../core/system-prompt.js";
import { runAgentLoop } from "../core/agent-loop.js";
import { queryCrewCoderExtensionDocs, embeddedCrewCoderExtensionDocs } from "../knowledge/crewcoder-extension-docs.js";
import { queryCrewCodeDocs } from "../knowledge/crewcode-docs.js";
import { crewcoderExtensionSkills } from "../skills/crewcoder-extension/index.js";

describe("extension mode", () => {
  it("puts CrewCoder extension constraints in the system prompt", () => {
    const prompt = buildSystemPrompt({ mode: "extension", skills: [], docs: [] });

    expect(prompt).toContain("CrewCoder Extension Architect mode");
    expect(prompt).toContain("crewcoder.extension.json");
    expect(prompt).toContain("prompt-only");
  });

  it("tells the model extension mode is not the CrewCode plugin system", () => {
    // The two manifests are the single easiest thing for a model to conflate.
    const prompt = buildSystemPrompt({ mode: "extension", skills: [], docs: [] });

    expect(prompt).toContain("NOT the CrewCode desktop app plugin system");
    expect(prompt).not.toContain("sandboxed iframe");
  });

  it("keeps plugin mode free of extension constraints", () => {
    const prompt = buildSystemPrompt({ mode: "plugin", skills: [], docs: [] });

    expect(prompt).toContain("CrewCode Plugin Architect mode");
    expect(prompt).not.toContain("crewcoder.extension.json");
  });

  it("labels the embedded docs section per mode", () => {
    const docs = [{ id: "d", title: "T", summary: "S", tags: [] }];

    expect(buildSystemPrompt({ mode: "extension", skills: [], docs })).toContain("Embedded CrewCoder extension docs:");
    expect(buildSystemPrompt({ mode: "plugin", skills: [], docs })).toContain("Embedded CrewCode plugin docs:");
  });

  it("puts only doc ids in the prompt, never titles or summaries", () => {
    // Summaries in the prompt are what this design deliberately removed: they cost
    // tokens on every turn and were never enough to build from anyway.
    const docs = [{ id: "extension-hooks", title: "Building extension hooks", summary: "A long summary that must not ship.", tags: [] }];
    const prompt = buildSystemPrompt({ mode: "extension", skills: [], docs });

    expect(prompt).toContain("extension-hooks");
    expect(prompt).not.toContain("A long summary that must not ship.");
    expect(prompt).not.toContain("Building extension hooks");
  });

  it("keeps the doc catalog small and identical regardless of the prompt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-doc-catalog-"));
    const [onTopic, offTopic] = await Promise.all([
      runAgentLoop({ prompt: "write a crewcoder.extension.json hook", requestedMode: "extension", cwd }, { maxIterations: 1 }),
      runAgentLoop({ prompt: "refactor this unrelated parser", requestedMode: "extension", cwd }, { maxIterations: 1 })
    ]);

    // The old keyword matcher spent the MOST tokens on the LEAST relevant prompt.
    expect(offTopic.retrievedDocs).toEqual(onTopic.retrievedDocs);
    expect(onTopic.retrievedDocs).toEqual(embeddedCrewCoderExtensionDocs.map((doc) => doc.id));
  });

  it("keeps the rendered catalog under a token budget", () => {
    const prompt = buildSystemPrompt({ mode: "extension", skills: [], docs: embeddedCrewCoderExtensionDocs });
    const section = prompt.slice(prompt.indexOf("Embedded CrewCoder extension docs:"));

    // ~4 chars/token. Guards against someone reintroducing summaries into the prompt.
    expect(Math.round(section.length / 4)).toBeLessThan(250);
  });

  it("keeps the two knowledge sets disjoint", () => {
    // A plugin-only concept must not resolve out of the extension doc set.
    expect(queryCrewCoderExtensionDocs("crewcode.plugin.json")).toHaveLength(0);
    expect(queryCrewCodeDocs("crewcoder.extension.json")).toHaveLength(0);
  });

  it("falls back to the extension doc set when a query matches nothing", () => {
    expect(queryCrewCoderExtensionDocs("qqqzzzxyw").length).toBe(0);
    expect(queryCrewCoderExtensionDocs("extension").length).toBeGreaterThan(0);
  });

  it("matches extension skills on authoring triggers", () => {
    const hookSkill = crewcoderExtensionSkills.find((skill) => skill.id === "crewcoder.extension.hooks");

    expect(hookSkill?.matches("add a beforeToolCall hook")).toBe(true);
    expect(hookSkill?.matches("rename this react component")).toBe(false);
  });

  it("activates extension skills and docs on a real run", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-extension-mode-"));
    const result = await runAgentLoop(
      { prompt: "write a crewcoder.extension.json manifest", requestedMode: "extension", cwd },
      { maxIterations: 1 }
    );

    expect(result.mode).toBe("extension");
    expect(result.activatedSkills.some((id) => id.startsWith("crewcoder.extension."))).toBe(true);
    expect(result.retrievedDocs.length).toBeGreaterThan(0);
    expect(result.notes.join(" ")).toContain("Extension mode is active");
  });
});
