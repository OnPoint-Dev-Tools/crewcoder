import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../core/config.js";
import { extensionToolName, extensionToolsFromManifest, loadTrustedExtensionTools } from "../extensions/extension-tools.js";
import type { LoadedCrewCoderExtension } from "../extensions/types.js";

function loadedExtension(partial: Partial<LoadedCrewCoderExtension["manifest"]> & { id: string }): LoadedCrewCoderExtension {
  return {
    dir: `/tmp/${partial.id}`,
    warnings: [],
    manifest: {
      id: partial.id,
      name: partial.name ?? partial.id,
      version: partial.version ?? "0.1.0",
      crewcoder: { apiVersion: "0.1" },
      contributes: partial.contributes
    }
  };
}

function withTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-ext-tools-"));
  process.env.CREWCODER_HOME = home;
  return home;
}

describe("trusted extension tools", () => {
  it("generates provider-safe namespaced tool names", () => {
    expect(extensionToolName("my.extension", "repo.audit")).toBe("extension_my_extension_repo_audit");
  });

  it("adapts manifest tool declarations into executable tools", async () => {
    const [tool] = extensionToolsFromManifest(loadedExtension({
      id: "echo-pack",
      contributes: {
        tools: [{
          id: "echo",
          title: "Echo",
          description: "Echo a message.",
          icon: "◎",
          category: "diagnostics",
          renderer: "echo.summary",
          command: process.execPath,
          args: ["-e", "console.log(process.argv[1])", "{{arg:message}}"],
          parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
          isMutation: false
        }]
      }
    }));

    expect(tool?.name).toBe("extension_echo-pack_echo");
    expect(tool?.isMutation).toBe(false);
    const result = await tool!.execute({ message: "hello" }, { cwd: process.cwd(), mode: "general", sessionId: "s1", mutationLog: [] });
    expect(result.content[0]?.text).toBe("hello");
    expect(result.details).toMatchObject({ extensionId: "echo-pack", toolId: "echo", label: "Echo", icon: "◎", category: "diagnostics", renderer: "echo.summary" });
  });

  it("loads tools only when extension tools are allowed and trusted", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      const extensionDir = path.join(home, "extensions", "trusted-pack");
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "crewcoder.extension.json"), JSON.stringify({
        id: "trusted-pack",
        name: "Trusted Pack",
        version: "0.1.0",
        crewcoder: { apiVersion: "0.1" },
        contributes: {
          tools: [{ id: "hello", title: "Hello", command: process.execPath, args: ["-e", "console.log('hi')"] }]
        }
      }), "utf8");

      expect(await loadTrustedExtensionTools()).toHaveLength(0);

      const config = readConfig();
      writeConfig({ ...config, allowExtensionTools: true, trustedExtensions: ["trusted-pack"] });
      const tools = await loadTrustedExtensionTools();
      expect(tools.map((tool) => tool.name)).toEqual(["extension_trusted-pack_hello"]);
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("loads sandboxed-tier tools and runs them inside the sandbox (fail closed with no backend)", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const previousBackend = process.env.CREWCODER_SANDBOX_BACKEND;
    const home = withTempHome();
    process.env.CREWCODER_SANDBOX_BACKEND = "none";
    try {
      const extensionDir = path.join(home, "extensions", "sandboxed-pack");
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "crewcoder.extension.json"), JSON.stringify({
        id: "sandboxed-pack",
        name: "Sandboxed Pack",
        version: "0.1.0",
        crewcoder: { apiVersion: "0.1" },
        contributes: { tools: [{ id: "hello", title: "Hello", command: process.execPath, args: ["-e", "console.log('hi')"] }] }
      }), "utf8");

      const config = readConfig();
      writeConfig({ ...config, allowExtensionTools: true, sandboxedExtensions: ["sandboxed-pack"] });
      const tools = await loadTrustedExtensionTools();
      expect(tools.map((tool) => tool.name)).toEqual(["extension_sandboxed-pack_hello"]);
      // No sandbox backend available -> must refuse rather than run unsandboxed.
      await expect(tools[0]!.execute({}, { cwd: process.cwd(), mode: "general", sessionId: "s1", mutationLog: [] })).rejects.toThrow(/requires a sandbox backend/i);
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
      if (previousBackend === undefined) delete process.env.CREWCODER_SANDBOX_BACKEND;
      else process.env.CREWCODER_SANDBOX_BACKEND = previousBackend;
    }
  });
});
