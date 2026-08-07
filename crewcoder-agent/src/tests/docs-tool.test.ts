import { describe, expect, it } from "vitest";
import { docsTool } from "../tools/docs.js";
import type { ResolvedAgentMode, } from "../core/types.js";
import type { ToolContext } from "../core/tool-types.js";
import { embeddedCrewCodeDocs } from "../knowledge/crewcode-docs.js";
import { embeddedCrewCoderExtensionDocs } from "../knowledge/crewcoder-extension-docs.js";

function context(mode: ResolvedAgentMode, integrationProfile: "standalone" | "crewcode" = "crewcode"): ToolContext {
  return { cwd: process.cwd(), mode, integrationProfile, sessionId: "test-session", mutationLog: [] };
}

async function run(mode: ResolvedAgentMode, args: Record<string, unknown>, integrationProfile: "standalone" | "crewcode" = "crewcode"): Promise<string> {
  const result = await docsTool.execute(docsTool.parse(args), context(mode, integrationProfile));
  return result.content[0]?.text ?? "";
}

describe("docs tool", () => {
  it("returns the full buildable body, not just the summary", async () => {
    const text = await run("extension", { id: "extension-hooks" });

    expect(text).toContain('"event": "beforeToolCall"');
    expect(text).toContain("process.stdin.on");
    expect(text.length).toBeGreaterThan(1500);
  });

  it("serves a complete plugin manifest and panel code", async () => {
    const text = await run("plugin", { id: "plugins" });

    expect(text).toContain('"crewcode": { "apiVersion": "0.1" }');
    expect(text).toContain("window.crewcode.workspace.listFiles()");
    expect(text).toContain("crewcode-plugin-api.js");
  });

  it("does not print the doc title twice", async () => {
    const text = await run("extension", { id: "extension-hooks" });
    const headings = text.split("\n").filter((line) => line.startsWith("# Building extension hooks"));

    expect(headings).toHaveLength(1);
  });

  it("scopes plugin mode to plugin docs only", async () => {
    const text = await run("plugin", { id: "extension-hooks" });

    expect(text).toContain('No embedded doc has id "extension-hooks"');
  });

  it("scopes extension mode to extension docs only", async () => {
    const text = await run("extension", { id: "plugin-permissions" });

    expect(text).toContain('No embedded doc has id "plugin-permissions"');
  });

  it("gives CrewCode-profile general mode both sets", async () => {
    const index = await run("general", {});

    expect(index).toContain("CrewCode app plugins");
    expect(index).toContain("CrewCoder extensions");
  });

  it("keeps CrewCode docs out of standalone general mode", async () => {
    const index = await run("general", {}, "standalone");
    const direct = await run("general", { id: "plugin-permissions" }, "standalone");

    expect(index).not.toContain("CrewCode app plugins");
    expect(index).toContain("CrewCoder extensions");
    expect(direct).toContain('No embedded doc has id "plugin-permissions"');
  });

  it("lists every doc id when called with no arguments", async () => {
    const index = await run("extension", {});

    for (const doc of embeddedCrewCoderExtensionDocs) expect(index).toContain(doc.id);
  });

  it("returns the full body directly when a query matches exactly one doc", async () => {
    const text = await run("extension", { query: "workflow" });

    expect(text).toContain("{{steps.<id>.output}}");
  });

  it("returns a chooser when a query matches several docs", async () => {
    const text = await run("extension", { query: "trust" });

    expect(text).toMatch(/docs matched/);
    expect(text).toContain('{ "id": "<id>" }');
  });

  it("suggests valid ids when an unknown id is requested", async () => {
    const text = await run("extension", { id: "does-not-exist" });

    expect(text).toContain("Available ids:");
    expect(text).toContain("extension-manifest");
  });

  it("every doc carries a real buildable body", () => {
    // The whole point of the doc set is teaching how to build. An index-only entry
    // silently regresses that, so require content on all of them.
    for (const doc of [...embeddedCrewCodeDocs, ...embeddedCrewCoderExtensionDocs]) {
      expect(doc.content, `${doc.id} has no content`).toBeTruthy();
      expect(doc.content!.length, `${doc.id} content is too thin`).toBeGreaterThan(400);
    }
  });

  it("keeps manifest examples in the correct doc set", () => {
    for (const doc of embeddedCrewCoderExtensionDocs) {
      expect(doc.content, `${doc.id} leaks a plugin manifest`).not.toContain("crewcode.plugin.json");
    }
    for (const doc of embeddedCrewCodeDocs) {
      expect(doc.content, `${doc.id} leaks an extension manifest`).not.toContain("crewcoder.extension.json");
    }
  });
});
