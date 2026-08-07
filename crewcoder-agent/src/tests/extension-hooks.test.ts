import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../core/config.js";
import { collectExtensionContext, extensionHooksFromManifest, loadTrustedExtensionHooks, runAfterToolHooks, runBeforeToolHooks, runCompactionHooks, runErrorHooks } from "../extensions/extension-hooks.js";
import { validateExtensionManifest } from "../extensions/extension-loader.js";
import { hasAnyMatcher, matchesToolCall } from "../extensions/tool-call-matcher.js";
import type { ToolCallPart, ToolResultMessage } from "../core/messages.js";
import type { CrewCoderExtensionManifest, LoadedCrewCoderExtension } from "../extensions/types.js";

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-ext-hooks-"));
  process.env.CREWCODER_HOME = home;
  return home;
}

describe("trusted extension hooks", () => {
  it("adapts executable hook contributions", () => {
    const hooks = extensionHooksFromManifest(loadedExtension({
      id: "policy-pack",
      contributes: {
        hooks: [{ id: "guard", title: "Guard", event: "beforeToolCall", command: process.execPath, args: ["hook.js"] }]
      }
    }));
    expect(hooks).toMatchObject([{ extensionId: "policy-pack", hookId: "guard", event: "beforeToolCall", command: process.execPath }]);
  });

  it("loads hooks only when hook execution is allowed and trusted", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      const extensionDir = path.join(home, "extensions", "trusted-hooks");
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "crewcoder.extension.json"), JSON.stringify({
        id: "trusted-hooks",
        name: "Trusted Hooks",
        version: "0.1.0",
        crewcoder: { apiVersion: "0.1" },
        contributes: { hooks: [{ id: "ctx", title: "Context", command: process.execPath }] }
      }), "utf8");

      expect(await loadTrustedExtensionHooks()).toHaveLength(0);
      writeConfig({ ...readConfig(), allowExtensionHooks: true, trustedExtensions: ["trusted-hooks"] });
      expect((await loadTrustedExtensionHooks()).map((hook) => hook.hookId)).toEqual(["ctx"]);
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("collects context hook output", async () => {
    const hooks = extensionHooksFromManifest(loadedExtension({
      id: "ctx-pack",
      contributes: {
        hooks: [{ id: "ctx", title: "Context", event: "context", command: process.execPath, args: ["-e", "console.log(JSON.stringify({context:'repo rule'}))"] }]
      }
    }));
    await expect(collectExtensionContext(hooks, { cwd: process.cwd(), sessionId: "s1", prompt: "hi", mode: "general" })).resolves.toEqual(["[ctx-pack/ctx]\nrepo rule"]);
  });

  it("supports before-tool block and modify decisions", async () => {
    const blockHooks = extensionHooksFromManifest(loadedExtension({
      id: "block-pack",
      contributes: { hooks: [{ id: "block", title: "Block", event: "beforeToolCall", command: process.execPath, args: ["-e", "console.log(JSON.stringify({action:'block',reason:'nope'}))"] }] }
    }));
    await expect(runBeforeToolHooks(blockHooks, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "rm -rf ." } }, { cwd: process.cwd(), mode: "general", sessionId: "s1", mutationLog: [] })).resolves.toMatchObject({ action: "block", reason: "nope" });

    const modifyHooks = extensionHooksFromManifest(loadedExtension({
      id: "modify-pack",
      contributes: { hooks: [{ id: "mod", title: "Modify", event: "beforeToolCall", command: process.execPath, args: ["-e", "console.log(JSON.stringify({action:'modify',args:{command:'echo safe'}}))"] }] }
    }));
    await expect(runBeforeToolHooks(modifyHooks, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo unsafe" } }, { cwd: process.cwd(), mode: "general", sessionId: "s1", mutationLog: [] })).resolves.toMatchObject({ action: "modify", args: { command: "echo safe" } });
  });
});

const context = { cwd: process.cwd(), mode: "general" as const, sessionId: "s1", mutationLog: [] };
const toolCall = (name: string, args: Record<string, unknown> = {}): ToolCallPart => ({ type: "toolCall", id: "t1", name, arguments: args });
const errorResult = (text: string): ToolResultMessage => ({ role: "toolResult", toolCallId: "t1", toolName: "edit", content: [{ type: "text", text }], isError: true, timestamp: Date.now() });
const okResult = (): ToolResultMessage => ({ role: "toolResult", toolCallId: "t1", toolName: "edit", content: [{ type: "text", text: "done" }], isError: false, timestamp: Date.now() });

describe("hook manifest validation", () => {
  const manifestWith = (hooks: unknown[]): CrewCoderExtensionManifest =>
    ({ id: "h", name: "H", version: "1.0.0", crewcoder: { apiVersion: "0.1" }, contributes: { hooks } }) as unknown as CrewCoderExtensionManifest;

  it("accepts onError as a hook event", () => {
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A", event: "onError", command: "true" }]))).not.toThrow();
  });

  it("rejects an unknown hook event", () => {
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A", event: "whenever", command: "true" }]))).toThrow(/event must be one of/);
  });

  it("validates the matches filter shape", () => {
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A", command: "true", matches: { tools: ["edit"], paths: ["*.lock"] } }]))).not.toThrow();
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A", command: "true", matches: ["edit"] }]))).toThrow(/matches must be an object/);
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A", command: "true", matches: { tools: "edit" } }]))).toThrow(/matches.tools/);
  });
});

describe("tool call matcher", () => {
  it("treats an empty matcher set as matching everything", () => {
    expect(matchesToolCall({}, toolCall("edit"))).toBe(true);
    expect(hasAnyMatcher({})).toBe(false);
  });

  it("ANDs matcher groups and ORs patterns within a group", () => {
    expect(matchesToolCall({ tools: ["edit", "write"] }, toolCall("write"))).toBe(true);
    expect(matchesToolCall({ tools: ["edit"] }, toolCall("read"))).toBe(false);
    expect(matchesToolCall({ tools: ["edit"], paths: ["*.lock"] }, toolCall("edit", { path: "package-lock.json" }))).toBe(false);
    expect(matchesToolCall({ tools: ["edit"], paths: ["*.lock"] }, toolCall("edit", { path: "yarn.lock" }))).toBe(true);
  });

  it("supports regex command patterns", () => {
    expect(matchesToolCall({ commands: ["/^npm /"] }, toolCall("bash", { command: "npm test" }))).toBe(true);
    expect(matchesToolCall({ commands: ["/^npm /"] }, toolCall("bash", { command: "yarn test" }))).toBe(false);
  });
});

describe("hook matches filter and error hooks", () => {
  it("defaults matches to empty so an unfiltered hook fires for every tool call", () => {
    const [hook] = extensionHooksFromManifest(loadedExtension({
      id: "pack", contributes: { hooks: [{ id: "h", title: "H", command: process.execPath }] }
    }));
    expect(hook.matches).toEqual({});
    expect(matchesToolCall(hook.matches, toolCall("anything"))).toBe(true);
  });

  it("carries the declared matches filter through", () => {
    const [hook] = extensionHooksFromManifest(loadedExtension({
      id: "pack", contributes: { hooks: [{ id: "h", title: "H", command: process.execPath, matches: { tools: ["edit"] } }] }
    }));
    expect(hook.matches).toEqual({ tools: ["edit"] });
  });

  it("does not run a before-tool hook whose matches filter excludes the call", async () => {
    const hooks = extensionHooksFromManifest(loadedExtension({
      id: "pack",
      contributes: { hooks: [{ id: "block", title: "Block", event: "beforeToolCall", command: process.execPath, args: ["-e", "console.log(JSON.stringify({action:'block',reason:'nope'}))"], matches: { paths: ["*.lock"] } }] }
    }));
    await expect(runBeforeToolHooks(hooks, toolCall("edit", { path: "src/index.ts" }), context)).resolves.toMatchObject({ action: "allow" });
    await expect(runBeforeToolHooks(hooks, toolCall("edit", { path: "yarn.lock" }), context)).resolves.toMatchObject({ action: "block" });
  });

  it("runs afterToolCall hooks only for matching tools", async () => {
    const hooks = extensionHooksFromManifest(loadedExtension({
      id: "pack",
      contributes: { hooks: [
        { id: "lint", title: "Lint", event: "afterToolCall", command: process.execPath, args: ["-e", "console.log(JSON.stringify({context:'ran lint'}))"], matches: { tools: ["edit"] } },
        { id: "other", title: "Other", event: "afterToolCall", command: process.execPath, args: ["-e", "console.log(JSON.stringify({context:'should not fire'}))"], matches: { tools: ["bash"] } }
      ] }
    }));
    await expect(runAfterToolHooks(hooks, toolCall("edit", { path: "a.ts" }), okResult(), context)).resolves.toEqual(["[pack/lint] ran lint"]);
  });

  it("lets a compaction hook replace the summary", async () => {
    const hooks = extensionHooksFromManifest(loadedExtension({
      id: "pack",
      contributes: { hooks: [{ id: "rewrite", title: "Rewrite", event: "compaction", command: process.execPath, args: ["-e", "console.log(JSON.stringify({summary:'REPLACED'}))"] }] }
    }));

    const result = await runCompactionHooks(hooks, { summary: "original", source: "model", originalMessageCount: 20, retainedMessageCount: 8, cwd: process.cwd(), sessionId: "s1" });

    expect(result.summary).toBe("REPLACED");
  });

  it("appends to the summary and chains hooks in order", async () => {
    const hooks = extensionHooksFromManifest(loadedExtension({
      id: "pack",
      contributes: { hooks: [
        { id: "first", title: "First", event: "compaction", command: process.execPath, args: ["-e", "console.log(JSON.stringify({append:'pinned: deploy key rotates monthly'}))"] },
        { id: "second", title: "Second", event: "compaction", command: process.execPath, args: ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.stringify({append:'saw:'+JSON.parse(d).summary.split('\\n').length+' lines'})))"] }
      ] }
    }));

    const result = await runCompactionHooks(hooks, { summary: "original", source: "model", originalMessageCount: 20, retainedMessageCount: 8, cwd: process.cwd(), sessionId: "s1" });

    // Second hook must observe the first hook's output, not the untouched original.
    expect(result.summary).toBe("original\npinned: deploy key rotates monthly\nsaw:2 lines");
  });

  it("leaves the summary untouched when a compaction hook returns nothing", async () => {
    const hooks = extensionHooksFromManifest(loadedExtension({
      id: "pack",
      contributes: { hooks: [{ id: "noop", title: "Noop", event: "compaction", command: process.execPath, args: ["-e", ""] }] }
    }));

    const result = await runCompactionHooks(hooks, { summary: "original", source: "deterministic", originalMessageCount: 20, retainedMessageCount: 8, cwd: process.cwd(), sessionId: "s1" });

    expect(result.summary).toBe("original");
  });

  it("ignores hooks bound to other events during compaction", async () => {
    const hooks = extensionHooksFromManifest(loadedExtension({
      id: "pack",
      contributes: { hooks: [{ id: "ctx", title: "Ctx", event: "context", command: process.execPath, args: ["-e", "console.log(JSON.stringify({summary:'should not apply'}))"] }] }
    }));

    const result = await runCompactionHooks(hooks, { summary: "original", source: "model", originalMessageCount: 20, retainedMessageCount: 8, cwd: process.cwd(), sessionId: "s1" });

    expect(result.summary).toBe("original");
  });

  it("runs onError hooks with the error text and ignores other events", async () => {
    const hooks = extensionHooksFromManifest(loadedExtension({
      id: "pack",
      contributes: { hooks: [
        { id: "report", title: "Report", event: "onError", command: process.execPath, args: ["-e", "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.stringify({context:JSON.parse(d).error})))"] },
        { id: "after", title: "After", event: "afterToolCall", command: process.execPath, args: ["-e", "console.log(JSON.stringify({context:'not an error hook'}))"] }
      ] }
    }));
    await expect(runErrorHooks(hooks, toolCall("edit"), errorResult("ENOENT: missing file"), context)).resolves.toEqual(["[pack/report] ENOENT: missing file"]);
  });
});
