import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexHostedModelCatalog } from "../providers/codex-hosted-model-catalog.js";

async function fixture(output: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-hosted-catalog-"));
  const script = path.join(root, "catalog.cjs");
  await fs.writeFile(script, `process.stdout.write(${JSON.stringify(output)});`);
  return { root, script };
}

describe("hosted Codex model catalog", () => {
  it("omits native patching while preserving the selected model and every other capability", async () => {
    const model = {
      slug: "custom-alias", apply_patch_tool_type: "freeform", context_window: 123456,
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
      base_instructions: "custom instructions", tool_mode: "code_mode_only", experimental_supported_tools: ["custom"],
    };
    const original = JSON.stringify({ models: [model, { ...model, slug: "second" }] });
    const { root, script } = await fixture(original);
    const catalog = await codexHostedModelCatalog(process.execPath, root, [script], "custom-alias");
    expect(JSON.parse(await fs.readFile(catalog, "utf8"))).toEqual({ models: [
      { ...model, apply_patch_tool_type: null }, { ...model, slug: "second", apply_patch_tool_type: null },
    ] });
    expect(await codexHostedModelCatalog(process.execPath, root, [script], "custom-alias")).toBe(catalog);
    expect(await fs.readFile(script, "utf8")).toContain(JSON.stringify(original));
  });

  it.each(['{"models":[]}', '{"models":[{"slug":""}]}', 'not JSON'])("rejects unusable catalog %s before inference", async output => {
    const { root, script } = await fixture(output);
    await expect(codexHostedModelCatalog(process.execPath, root, [script])).rejects.toThrow();
  });

  it("refuses to silently substitute another model", async () => {
    const { root, script } = await fixture('{"models":[{"slug":"other"}]}');
    await expect(codexHostedModelCatalog(process.execPath, root, [script], "requested")).rejects.toThrow("selected model requested");
  });

  it("cancels discovery on Stop", async () => {
    const { root, script } = await fixture("");
    await fs.writeFile(script, "setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const operation = codexHostedModelCatalog(process.execPath, root, [script], undefined, controller.signal);
    controller.abort();
    await expect(operation).rejects.toThrow("cancelled");
  });

  it("reports bounded redacted CLI diagnostics without guessing that an update is needed", async () => {
    const { root, script } = await fixture("");
    await fs.writeFile(script, `process.stderr.write(${JSON.stringify("Error: url is not supported for stdio\nin `mcp_servers.openaiDeveloperDocs`\nAPI_TOKEN=private-fixture-token\nBearer abcdefghijklmnop\n")}); process.exit(1);`);
    let message = "";
    try { await codexHostedModelCatalog(process.execPath, root, [script]); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain("code 1");
    expect(message).toContain("url is not supported for stdio");
    expect(message).toContain("mcp_servers.openaiDeveloperDocs");
    expect(message).not.toContain("private-fixture-token");
    expect(message).not.toContain("abcdefghijklmnop");
    expect(message).not.toContain("update the installed");
  });
});
