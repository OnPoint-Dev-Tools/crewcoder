import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTemplates } from "../generators/template-registry.js";
import { createPlugin } from "../generators/plugin-generator.js";

describe("template registry", () => {
  it("maps known CrewCode plugin kinds to template names", () => {
    const templates = listTemplates(process.cwd());
    expect(templates.some((template) => template.kind === "static-panel")).toBe(true);
    expect(templates.some((template) => template.templateName === "static-panel-template")).toBe(true);
  });

  it("uses repo-local examples/plugins templates when available", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-repo-"));
    const templateDir = path.join(repo, "examples", "plugins", "static-panel-template");
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, "crewcode.plugin.json"), JSON.stringify({ id: "template-id", name: "Template Name", version: "0.1.0", crewcode: { apiVersion: "0.1" }, permissions: [], contributes: {} }));
    fs.writeFileSync(path.join(templateDir, "TEMPLATE_MARKER.txt"), "yes");
    const out = path.join(repo, "out");
    const files = await createPlugin("custom-panel", "static-panel", out);
    expect(files).toContain("TEMPLATE_MARKER.txt");
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "custom-panel", "crewcode.plugin.json"), "utf8"));
    expect(manifest.id).toBe("custom-panel");
    expect(manifest.name).toBe("Custom Panel");
  });
});
