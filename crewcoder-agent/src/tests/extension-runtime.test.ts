import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../core/config.js";
import { clearCrewCoderExtensionRuntimeCache, collectContextEventResults, emitCrewCoderExtensionEvent, loadTrustedCrewCoderExtensionRuntime, normalizeBeforeToolEventResults, seedCrewCoderExtensionEntries, type LoadedCrewCoderExtensionRuntime } from "../extensions/extension-runtime.js";
import { loadTrustedExtensionTools } from "../extensions/extension-tools.js";
import { listAvailablePromptCommands, runAvailablePromptCommand } from "../extensions/extension-commands.js";
import { createExtensionUiBridge } from "../core/extension-ui-bridge.js";
import type { AgentEvent } from "../core/events.js";

function withTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-ext-runtime-"));
  process.env.CREWCODER_HOME = home;
  clearCrewCoderExtensionRuntimeCache();
  return home;
}

function writeExtension(home: string, id: string, moduleSource: string): void {
  const dir = path.join(home, "extensions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.mjs"), moduleSource, "utf8");
  fs.writeFileSync(path.join(dir, "crewcoder.extension.json"), JSON.stringify({
    id,
    name: id,
    version: "0.1.0",
    crewcoder: { apiVersion: "0.1" },
    main: "index.mjs"
  }), "utf8");
}

describe("CrewCoderExtAPI defineX runtime", () => {
  it("loads trusted module extensions only when module execution is enabled", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      writeExtension(home, "api-pack", `export default function (crew) { crew.defineTool({ name: 'hello', description: 'Say hello', async execute() { return { content: [{ type: 'text', text: 'hello' }] }; } }); }`);
      expect((await loadTrustedCrewCoderExtensionRuntime()).tools).toHaveLength(0);

      writeConfig({ ...readConfig(), allowExtensionModules: true, allowExtensionTools: true, trustedExtensions: ["api-pack"] });
      clearCrewCoderExtensionRuntimeCache();
      const runtime = await loadTrustedCrewCoderExtensionRuntime();
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["hello"]);
    } finally {
      clearCrewCoderExtensionRuntimeCache();
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("adapts API-registered tools into model-callable tools", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      writeExtension(home, "tool-pack", `export default function (crew) { crew.defineTool({ name: 'hello', description: 'Say hello', parameters: { type: 'object', properties: { name: { type: 'string' } } }, async execute(_id, args) { return { content: [{ type: 'text', text: 'hello ' + args.name }] }; } }); }`);
      writeConfig({ ...readConfig(), allowExtensionModules: true, allowExtensionTools: true, trustedExtensions: ["tool-pack"] });
      clearCrewCoderExtensionRuntimeCache();

      const tools = await loadTrustedExtensionTools();
      const tool = tools.find((item) => item.name === "extension_tool-pack_hello");
      expect(tool).toBeTruthy();
      await expect(tool!.execute({ name: "Crew" }, { cwd: process.cwd(), mode: "general", sessionId: "s1", mutationLog: [] })).resolves.toMatchObject({
        content: [{ type: "text", text: "hello Crew" }],
        details: { extensionId: "tool-pack", toolId: "hello" }
      });
    } finally {
      clearCrewCoderExtensionRuntimeCache();
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("lists and runs API-defined commands", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      const marker = path.join(home, "command-output.txt");
      writeExtension(home, "cmd-pack", `import fs from 'node:fs'; export default function (crew) { crew.defineCommand('hello', { description: 'Say hello', async handler(args, ctx) { ctx.ui.notify('hello ' + (args || 'empty'), 'success'); fs.writeFileSync(${JSON.stringify(marker)}, args || 'empty', 'utf8'); } }); }`);
      writeConfig({ ...readConfig(), allowExtensionModules: true, trustedExtensions: ["cmd-pack"] });
      clearCrewCoderExtensionRuntimeCache();

      const commands = await listAvailablePromptCommands();
      expect(commands.find((command) => command.name === "ext.cmd-pack.hello")).toMatchObject({ description: "Say hello", extensionId: "cmd-pack" });

      const result = await runAvailablePromptCommand("ext.cmd-pack.hello", "Crew args", process.cwd());
      expect(fs.readFileSync(marker, "utf8")).toBe("Crew args");
      expect(result.notifications).toEqual([{ extensionId: "cmd-pack", message: "hello Crew args", level: "success" }]);
    } finally {
      clearCrewCoderExtensionRuntimeCache();
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("runs context and before_tool_call event handlers", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      writeExtension(home, "hook-pack", `export default function (crew) { crew.handleEvent('context', () => ({ context: 'extra repo context' })); crew.handleEvent('before_tool_call', (event) => event.toolCall.name === 'bash' ? { action: 'block', reason: 'no shell' } : undefined); }`);
      writeConfig({ ...readConfig(), allowExtensionModules: true, trustedExtensions: ["hook-pack"] });
      clearCrewCoderExtensionRuntimeCache();
      const runtime = await loadTrustedCrewCoderExtensionRuntime();

      const contexts = collectContextEventResults(await emitCrewCoderExtensionEvent(runtime, "context", { cwd: process.cwd(), sessionId: "s1", prompt: "hi", mode: "general" }));
      expect(contexts).toEqual(["extra repo context"]);

      const decision = normalizeBeforeToolEventResults(await emitCrewCoderExtensionEvent(runtime, "before_tool_call", {
        toolCall: { type: "toolCall", id: "t1", name: "bash", arguments: { command: "pwd" } },
        context: { cwd: process.cwd(), mode: "general", sessionId: "s1", mutationLog: [] }
      }));
      expect(decision).toMatchObject({ action: "block", reason: "no shell" });
    } finally {
      clearCrewCoderExtensionRuntimeCache();
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("filters agent_event handlers by requested event types", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      writeExtension(home, "event-filter-pack", `export default function (crew) { crew.handleEvent('agent_event', { types: ['tool_execution_end'] }, (event) => { crew.writeSessionEntry('filtered', event.type); }); crew.handleEvent('agent_event', (event) => { crew.writeSessionEntry('all', event.type); }); }`);
      writeConfig({ ...readConfig(), allowExtensionModules: true, trustedExtensions: ["event-filter-pack"] });
      clearCrewCoderExtensionRuntimeCache();
      const runtime = await loadTrustedCrewCoderExtensionRuntime();

      await emitCrewCoderExtensionEvent(runtime, "agent_event", { type: "agent_start", sessionId: "s1" });
      await emitCrewCoderExtensionEvent(runtime, "agent_event", {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 },
        isError: false
      });

      expect(runtime.entries.map((entry) => ({ type: entry.customType, data: entry.data }))).toEqual([
        { type: "all", data: "agent_start" },
        { type: "filtered", data: "tool_execution_end" },
        { type: "all", data: "tool_execution_end" }
      ]);
    } finally {
      clearCrewCoderExtensionRuntimeCache();
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("persists writeSessionEntry calls into the runtime, scoped per extension", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      writeExtension(home, "entry-pack", `export default function (crew) { crew.writeSessionEntry('note', { value: 1 }); crew.writeSessionEntry('note', { value: 2 }); }`);
      writeConfig({ ...readConfig(), allowExtensionModules: true, trustedExtensions: ["entry-pack"] });
      clearCrewCoderExtensionRuntimeCache();

      const runtime = await loadTrustedCrewCoderExtensionRuntime();
      expect(runtime.entries).toHaveLength(2);
      expect(runtime.entries.map((entry) => ({ extensionId: entry.extensionId, customType: entry.customType, data: entry.data }))).toEqual([
        { extensionId: "entry-pack", customType: "note", data: { value: 1 } },
        { extensionId: "entry-pack", customType: "note", data: { value: 2 } }
      ]);
      expect(runtime.entries.every((entry) => typeof entry.timestamp === "number")).toBe(true);
    } finally {
      clearCrewCoderExtensionRuntimeCache();
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("routes command ctx.ui calls through a host UI bridge", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      const marker = path.join(home, "ui-output.txt");
      writeExtension(home, "ui-pack", `import fs from 'node:fs'; export default function (crew) { crew.defineCommand('ask', { description: 'Ask', async handler(_args, ctx) { ctx.ui.notify('starting', 'info'); const ok = await ctx.ui.confirm('Proceed?'); fs.writeFileSync(${JSON.stringify(marker)}, ok ? 'yes' : 'no', 'utf8'); } }); }`);
      writeConfig({ ...readConfig(), allowExtensionModules: true, trustedExtensions: ["ui-pack"] });
      clearCrewCoderExtensionRuntimeCache();

      const events: AgentEvent[] = [];
      let bridge!: ReturnType<typeof createExtensionUiBridge>;
      bridge = createExtensionUiBridge({
        hasUI: true,
        emit: (event) => {
          events.push(event);
          if (event.type === "extension_ui_request") bridge.resolveResponse(event.requestId, true);
        }
      });

      await runAvailablePromptCommand("ext.ui-pack.ask", "", process.cwd(), { uiBridge: bridge });

      expect(fs.readFileSync(marker, "utf8")).toBe("yes");
      expect(events.some((event) => event.type === "extension_ui_notify" && event.extensionId === "ui-pack" && event.message === "starting")).toBe(true);
      expect(events.some((event) => event.type === "extension_ui_request" && event.uiKind === "confirm" && event.extensionId === "ui-pack")).toBe(true);
      expect(bridge.hasPending()).toBe(false);
    } finally {
      clearCrewCoderExtensionRuntimeCache();
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("handles a durable UI action idempotently across a resume replay", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      writeExtension(home, "triage-pack", `export default function (crew) {
        crew.defineCommand('triage', {
          description: 'Triage a finding with a durable decision',
          async handler(args, ctx) {
            const key = (args || '').trim() || 'default';
            const prior = ctx.getSessionEntries().find((entry) => entry.customType === 'triage-decision' && entry.data && entry.data.key === key);
            if (prior) {
              ctx.ui.notify('Already decided ' + key + ': ' + prior.data.action, 'info');
              return;
            }
            const action = await ctx.ui.component('Triage ' + key, { kind: 'actionList', actions: [{ id: 'fix', label: 'Fix now' }, { id: 'ignore', label: 'Ignore' }] });
            ctx.writeSessionEntry('triage-decision', { key, action: action || 'skipped' });
            ctx.ui.notify('Recorded ' + key + ': ' + (action || 'skipped'), 'success');
          }
        });
      }`);
      writeConfig({ ...readConfig(), allowExtensionModules: true, trustedExtensions: ["triage-pack"] });
      clearCrewCoderExtensionRuntimeCache();

      // First turn: no prior decision, so the extension opens an action component and records the choice.
      const firstEvents: AgentEvent[] = [];
      let firstBridge!: ReturnType<typeof createExtensionUiBridge>;
      firstBridge = createExtensionUiBridge({
        hasUI: true,
        emit: (event) => {
          firstEvents.push(event);
          if (event.type === "extension_ui_request") firstBridge.resolveResponse(event.requestId, "fix");
        }
      });

      await runAvailablePromptCommand("ext.triage-pack.triage", "auth-bug", process.cwd(), { uiBridge: firstBridge });
      expect(firstEvents.some((event) => event.type === "extension_ui_request" && event.uiKind === "component")).toBe(true);
      expect(firstEvents.some((event) => event.type === "extension_ui_notify" && event.message === "Recorded auth-bug: fix" && event.level === "success")).toBe(true);

      // The durable payload the agent loop would persist to SessionRecord.extensionEntries.
      const savedEntries = (await loadTrustedCrewCoderExtensionRuntime()).entries.map((entry) => ({ ...entry }));
      expect(savedEntries).toHaveLength(1);
      expect(savedEntries[0]).toMatchObject({ extensionId: "triage-pack", customType: "triage-decision", data: { key: "auth-bug", action: "fix" } });

      // Resume: fresh runtime, replay the persisted entries the way session resume does.
      clearCrewCoderExtensionRuntimeCache();
      const resumed = await loadTrustedCrewCoderExtensionRuntime();
      seedCrewCoderExtensionEntries(resumed, savedEntries);

      // Second turn after resume: the recorded decision short-circuits the prompt (no new action request).
      const secondEvents: AgentEvent[] = [];
      let secondBridge!: ReturnType<typeof createExtensionUiBridge>;
      secondBridge = createExtensionUiBridge({
        hasUI: true,
        emit: (event) => {
          secondEvents.push(event);
          if (event.type === "extension_ui_request") secondBridge.resolveResponse(event.requestId, "ignore");
        }
      });

      await runAvailablePromptCommand("ext.triage-pack.triage", "auth-bug", process.cwd(), { uiBridge: secondBridge });
      expect(secondEvents.some((event) => event.type === "extension_ui_request")).toBe(false);
      expect(secondEvents.some((event) => event.type === "extension_ui_notify" && event.message === "Already decided auth-bug: fix" && event.level === "info")).toBe(true);
      expect(resumed.entries).toHaveLength(1);
    } finally {
      clearCrewCoderExtensionRuntimeCache();
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });
});

describe("seedCrewCoderExtensionEntries", () => {
  function emptyRuntime(): LoadedCrewCoderExtensionRuntime {
    return { tools: [], commands: [], handlers: new Map(), entries: [], warnings: [] };
  }

  it("replays prior entries and is idempotent across re-seeds", () => {
    const runtime = emptyRuntime();
    const prior = [
      { extensionId: "a", customType: "note", data: { n: 1 }, timestamp: 1000 },
      { extensionId: "a", customType: "note", data: { n: 2 }, timestamp: 2000 },
      { extensionId: "b", customType: "log", data: undefined, timestamp: 1000 }
    ];

    seedCrewCoderExtensionEntries(runtime, prior);
    expect(runtime.entries).toHaveLength(3);

    // Re-seeding the same entries (e.g. a second resume on a cached runtime) must not duplicate.
    seedCrewCoderExtensionEntries(runtime, prior);
    expect(runtime.entries).toHaveLength(3);

    // A genuinely new entry still gets appended.
    seedCrewCoderExtensionEntries(runtime, [{ extensionId: "a", customType: "note", data: { n: 3 }, timestamp: 3000 }]);
    expect(runtime.entries).toHaveLength(4);
  });

  it("does nothing for an empty replay set", () => {
    const runtime = emptyRuntime();
    seedCrewCoderExtensionEntries(runtime, []);
    expect(runtime.entries).toHaveLength(0);
  });
});
