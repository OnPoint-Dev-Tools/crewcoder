import { describe, expect, it } from "vitest";
import { pickerEntries } from "../palette-model.js";
import { paletteCommands } from "../commands.js";
import { SessionController } from "../session-controller.js";
import { FakeBridge } from "./fake-bridge.js";
import { FakeCli, flush } from "./fake-cli.js";

function setup(): { bridge: FakeBridge; cli: FakeCli; controller: SessionController } {
  const bridge = new FakeBridge();
  const cli = new FakeCli();
  return { bridge, cli, controller: new SessionController(bridge, undefined, cli) };
}

/** Move the cursor to the entry with this id and select it. */
function choose(controller: SessionController, id: string): void {
  const entries = pickerEntries(controller.picker?.items ?? [], controller.pickerQuery);
  const index = entries.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`${id} is not in ${controller.picker?.kind}: ${entries.map((item) => item.id).join(", ")}`);
  controller.movePickerCursor(index - controller.pickerCursor);
  controller.selectPickerItem();
}

describe("slash palette", () => {
  it("lists every picker command and opens the chosen picker", async () => {
    const { controller, cli } = setup();
    cli.providerList = [{ id: "opencode", title: "OpenCode", models: ["sonnet"] }];
    controller.openCommandPalette();
    expect(controller.picker?.items.map((item) => item.id)).toEqual(paletteCommands("standalone").map((item) => item.id));

    choose(controller, "/provider");
    expect(controller.picker).toMatchObject({ kind: "provider", loading: true });
    await flush();
    expect(controller.picker).toMatchObject({ kind: "provider", loading: false });
    expect(controller.picker?.items.map((item) => item.id)).toEqual(["opencode"]);
  });

  it("lists /plugins only under the crewcode profile", () => {
    const { controller } = setup();
    controller.openCommandPalette();
    expect(controller.picker?.items.map((item) => item.id)).not.toContain("/plugins");
    controller.closePicker();
    controller.state.integrationProfile = "crewcode";
    controller.openCommandPalette();
    expect(controller.picker?.items.map((item) => item.id)).toContain("/plugins");
  });
});

describe("picker commands with arguments", () => {
  async function typed(controller: SessionController, command: string): Promise<void> {
    controller.submit(command);
    await flush();
  }

  it("/effort applies a supported level and lists the levels for a bad one", async () => {
    const { controller } = setup();
    Object.assign(controller.state, { provider: "opencode", model: "sonnet", effort: "low" });
    await typed(controller, "/effort high");
    expect(controller.picker).toBeUndefined();
    expect(controller.state.effort).toBe("high");
    expect(controller.currentAlert).toMatchObject({ variant: "success", title: "Reasoning effort: high" });
    await typed(controller, "/effort xhigh");
    expect(controller.state.effort).toBe("high");
    expect(controller.currentAlert).toMatchObject({ variant: "error", body: expect.stringContaining("none, low, medium, high") });
  });

  it("/provider validates the id and keeps a model the provider offers", async () => {
    const { controller, cli } = setup();
    cli.providerList = [{ id: "opencode", title: "OpenCode", models: ["sonnet", "opus"], defaultModel: "sonnet" }];
    Object.assign(controller.state, { provider: "codex-cli", model: "gpt-6-luna", effort: "xhigh" });
    await typed(controller, "/provider nope");
    expect(controller.state.provider).toBe("codex-cli");
    expect(controller.currentAlert).toMatchObject({ variant: "error", title: "Unknown provider: nope" });
    await typed(controller, "/provider opencode");
    expect(controller.state).toMatchObject({ provider: "opencode", model: "sonnet" });
    expect(controller.state.effort).not.toBe("xhigh");
  });

  it("/model sets the model directly", async () => {
    const { controller } = setup();
    await typed(controller, "/model gpt-6-sol");
    expect(controller.state.model).toBe("gpt-6-sol");
  });

  it("/modes and /workers accept a mode or a saved worker", async () => {
    const { controller, cli } = setup();
    cli.json("workers list --json", [{ name: "builder", active: false, ownerName: null }]);
    await typed(controller, "/modes crewcoder");
    expect(controller.state.mode).toBe("crewcoder");
    await typed(controller, "/workers builder");
    expect(controller.state.worker).toBe("builder");
    await typed(controller, "/worker ghost");
    expect(controller.currentAlert).toMatchObject({ variant: "error", title: "No mode or worker named ghost" });
  });

  it("/tool-mode, /profile, /prompts, /skills, /commands apply their argument", async () => {
    const { controller, cli } = setup();
    cli.json("config show", { toolMode: "crewcoder" });
    cli.json("config set toolMode native", {});
    cli.responses.set("profile use crewcode --project", { stdout: "", stderr: "", exitCode: 0 });
    cli.json("system-prompt show terse --json", { name: "terse" });
    cli.json("skill show tdd --json", { name: "tdd", description: "", body: "Test first." });
    cli.json("command show review --json --arg target=src", { content: "Review src" });
    await typed(controller, "/tool-mode status");
    expect(controller.currentAlert).toMatchObject({ title: "Tool mode for new sessions: crewcoder" });
    await typed(controller, "/tool-mode native");
    expect(cli.ran("config set toolMode native")).toBe(true);
    await typed(controller, "/profile crewcode");
    expect(controller.state.integrationProfile).toBe("crewcode");
    await typed(controller, "/profile both");
    expect(controller.currentAlert).toMatchObject({ title: "Usage" });
    await typed(controller, "/prompts terse");
    expect(controller.state.systemPrompt).toBe("terse");
    await typed(controller, "/skills tdd");
    expect(controller.currentAlert).toMatchObject({ title: "Skill attached: tdd" });
    await typed(controller, "/commands review target=src");
    expect(controller.composerDraft).toBe("Review src");
  });

  it("/sessions and /resume take an id or a unique prefix", async () => {
    const { controller, cli, bridge } = setup();
    const session = (id: string) => ({ id, startedAt: "2026-11-16T10:00:00Z", cwd: "/r", requestedMode: "general", resolvedMode: "general", prompt: "p" });
    cli.sessionList = [session("abc-111"), session("abc-222"), session("xyz-333")];
    await typed(controller, "/resume abc");
    expect(controller.currentAlert).toMatchObject({ variant: "error", title: "2 sessions start with abc" });
    await typed(controller, "/sessions xyz");
    expect(bridge.resumes.at(-1)).toMatchObject({ sessionId: "xyz-333" });
  });

  it("/rewind latest uses the newest checkpoint", async () => {
    const { controller, cli } = setup();
    controller.state.sessionId = "s-1";
    controller.state.checkpoints = [
      { id: "cp-1", sessionId: "s-1", reason: "a", fileCount: 1, totalBytes: 1, truncated: false },
      { id: "cp-2", sessionId: "s-1", reason: "b", fileCount: 1, totalBytes: 1, truncated: false }
    ];
    cli.json("session rewind-preview s-1 cp-2 --json", { restoreFiles: ["a.ts"], deleteFiles: [] });
    cli.json("session rewind s-1 cp-2 --json", { restoredFiles: 1, deletedFiles: 0 });
    await typed(controller, "/rewind latest");
    expect(cli.ran("session rewind s-1 cp-2 --json")).toBe(true);
  });

  it("/handoff passes the worker and continuation prompt", async () => {
    const { controller, cli } = setup();
    Object.assign(controller.state, { sessionId: "s-1", provider: "codex-cli", model: "m", mode: "general", effort: "low" });
    cli.json("crew handoff worker:reviewer s-1 check the tests --provider codex-cli --mode general --effort low --approval review --model m --json", { sessionId: "s-2" });
    await typed(controller, "/handoff worker:reviewer check the tests");
    expect(controller.state).toMatchObject({ sessionId: "s-2", worker: "reviewer" });
  });
});

describe("provider, model, and effort", () => {
  it("chains provider into model into effort and clamps unsupported effort", async () => {
    const { controller, cli } = setup();
    cli.providerList = [{ id: "opencode", title: "OpenCode", models: ["sonnet", "opus"], defaultModel: "sonnet" }];
    controller.state.effort = "xhigh";

    controller.submit("/provider");
    await flush();
    choose(controller, "opencode");
    await flush();
    expect(controller.picker?.kind).toBe("model");
    choose(controller, "opus");
    await flush();
    // opencode has no xhigh; the effort picker opens on the clamped level.
    expect(controller.picker?.kind).toBe("effort");
    expect(controller.picker?.items.map((item) => item.id)).not.toContain("xhigh");
    choose(controller, "high");
    await flush();

    expect(controller.picker).toBeUndefined();
    expect(controller.state).toMatchObject({ provider: "opencode", model: "opus", effort: "high" });
  });

  it("falls back to the built-in catalog when provider discovery fails", async () => {
    const { controller, cli } = setup();
    cli.providers = async () => { throw new Error("offline"); };
    controller.submit("/provider");
    await flush();
    expect(controller.picker?.items.map((item) => item.id)).toContain("codex-cli");
  });

  it("opens the cursor on the current value", async () => {
    const { controller, cli } = setup();
    cli.providerList = [{ id: "codex-cli", title: "Codex", models: ["a", "b", "c"] }];
    controller.state.model = "c";
    controller.submit("/model");
    await flush();
    expect(pickerEntries(controller.picker!.items, "")[controller.pickerCursor]?.id).toBe("c");
  });
});

describe("modes and workers", () => {
  it("shows built-in modes at once, adds workers when listed, and sets a session worker", async () => {
    const { controller, cli } = setup();
    cli.json("workers list --json", [{ name: "builder", active: false, ownerName: null }]);
    controller.submit("/modes");
    expect(controller.picker?.items.map((item) => item.id)).toEqual(["general", "crewcoder", "extension"]);
    await flush();
    choose(controller, "worker:builder");
    await flush();
    expect(controller.state.worker).toBe("builder");

    controller.submit("/workers");
    await flush();
    choose(controller, "crewcoder");
    await flush();
    expect(controller.state).toMatchObject({ mode: "crewcoder", worker: undefined });
  });
});

describe("sessions", () => {
  it("resumes the chosen session with its saved settings and a supported effort", async () => {
    const { controller, cli, bridge } = setup();
    cli.sessionList = [{
      id: "s-7", startedAt: "2026-11-15T10:00:00Z", cwd: "/repo", requestedMode: "crewcoder", resolvedMode: "crewcoder",
      prompt: "fix the build", provider: "opencode", model: "sonnet", effort: "xhigh", externalDirectories: ["/data"]
    }];
    controller.submit("/resume");
    await flush();
    choose(controller, "s-7");
    await flush();

    expect(bridge.resumes).toEqual([expect.objectContaining({ sessionId: "s-7", provider: "opencode", model: "sonnet", mode: "crewcoder", externalDirectories: ["/data"] })]);
    expect(bridge.resumes[0]?.prompt).toBeUndefined();
    expect(controller.state.effort).not.toBe("xhigh");
    expect(controller.state.running).toBe(true);
  });
});

describe("content pickers", () => {
  it("attaches a skill to the next prompt only, without showing it as typed text", async () => {
    const { controller, cli, bridge } = setup();
    cli.json("skill list --json", [{ name: "tdd", description: "Test first" }]);
    cli.json("skill show tdd --json", { name: "tdd", description: "Test first", body: "Write the test first." });
    controller.submit("/skills");
    await flush();
    choose(controller, "tdd");
    await flush();

    controller.submit("add a parser");
    expect(bridge.runs[0]?.prompt).toContain("Write the test first.");
    expect(bridge.runs[0]?.prompt).toContain("add a parser");
    expect(controller.state.blocks.find((block) => block.type === "user")).toMatchObject({ text: "add a parser" });

    bridge.emit({ type: "agent_end" });
    controller.submit("again");
    expect(bridge.runs.at(-1)?.prompt ?? bridge.resumes.at(-1)?.prompt).toBe("again");
  });

  it("puts a multi-line prompt command into the composer unchanged", async () => {
    const { controller, cli } = setup();
    cli.json("command list --json", [{ name: "review", path: "/x/review.md" }]);
    cli.json("command show review --json", { content: "Review this diff\nfor bugs" });
    controller.submit("/commands");
    await flush();
    choose(controller, "review");
    await flush();

    expect(controller.composerDraft).toBe("Review this diff\nfor bugs");
    expect(controller.composerDraftVersion).toBe(1);
    expect(controller.currentAlert).toBeUndefined();
  });

  it("verifies a system prompt exists before selecting it", async () => {
    const { controller, cli } = setup();
    cli.json("system-prompt list --json", [{ name: "terse", path: "/p/terse.md" }]);
    cli.fail("system-prompt show terse --json", "not found: terse");
    controller.submit("/prompts");
    await flush();
    choose(controller, "terse");
    await flush();

    expect(controller.state.systemPrompt).toBeUndefined();
    expect(controller.currentAlert).toMatchObject({ variant: "error", body: "not found: terse" });
  });

  it("shows the empty-list message instead of a blank picker", async () => {
    const { controller, cli } = setup();
    cli.json("skill list --json", []);
    controller.submit("/skills");
    await flush();
    expect(controller.picker).toMatchObject({ kind: "skill", loading: false, items: [], emptyText: expect.stringContaining("No skills") });
  });

  it("drops a picker's results when the user already closed it", async () => {
    const { controller, cli } = setup();
    cli.json("skill list --json", [{ name: "tdd", description: "" }]);
    controller.submit("/skills");
    controller.closePicker();
    await flush();
    expect(controller.picker).toBeUndefined();
  });
});

describe("settings pickers", () => {
  it("saves Tool mode through the CLI and refuses while a run is active", async () => {
    const { controller, cli } = setup();
    cli.json("config show", { toolMode: "native" });
    cli.json("config set toolMode crewcoder", {});
    controller.submit("/tool-mode");
    await flush();
    expect(controller.picker?.items.find((item) => item.current)?.id).toBe("native");
    choose(controller, "crewcoder");
    await flush();
    expect(cli.ran("config set toolMode crewcoder")).toBe(true);

    controller.submit("start");
    controller.submit("/tool-mode");
    expect(controller.picker).toBeUndefined();
    expect(controller.currentAlert).toMatchObject({ variant: "warning", title: expect.stringContaining("Wait for the current run") });
  });

  it("switching to standalone leaves plugin mode", async () => {
    const { controller, cli } = setup();
    controller.state.integrationProfile = "crewcode";
    controller.state.mode = "plugin";
    cli.responses.set("profile use standalone --project", { stdout: "Profile: standalone", stderr: "", exitCode: 0 });
    controller.submit("/profile");
    choose(controller, "standalone");
    await flush();
    expect(controller.state).toMatchObject({ integrationProfile: "standalone", mode: "general" });
  });

  it("removes an external directory from an unsaved session locally", async () => {
    const { controller } = setup();
    controller.state.externalDirectories = ["/a", "/b"];
    controller.submit("/remove-dir");
    choose(controller, "/a");
    await flush();
    expect(controller.state.externalDirectories).toEqual(["/b"]);
  });
});

describe("rewind and handoff", () => {
  const checkpoint = { id: "cp-1", sessionId: "s-1", reason: "edit", toolName: "edit", fileCount: 2, totalBytes: 10, truncated: false };

  it("asks before a rewind that deletes files, defaulting to Cancel", async () => {
    const { controller, cli } = setup();
    controller.state.sessionId = "s-1";
    controller.state.checkpoints = [checkpoint];
    cli.json("session rewind-preview s-1 cp-1 --json", { restoreFiles: ["a.ts"], deleteFiles: ["new.ts"] });
    cli.json("session rewind s-1 cp-1 --json", { restoredFiles: 1, deletedFiles: 1 });

    controller.submit("/rewind");
    choose(controller, "cp-1");
    await flush();
    expect(controller.picker?.kind).toBe("rewindConfirm");
    expect(pickerEntries(controller.picker!.items, "")[controller.pickerCursor]?.id).toBe("cancel");
    controller.selectPickerItem();
    await flush();
    expect(cli.ran("session rewind s-1 cp-1 --json")).toBe(false);

    controller.submit("/rewind");
    choose(controller, "cp-1");
    await flush();
    choose(controller, "restore:cp-1");
    await flush();
    expect(cli.ran("session rewind s-1 cp-1 --json")).toBe(true);
    expect(controller.currentAlert).toMatchObject({ variant: "success", body: "Restored 1 files, deleted 1 files." });
  });

  it("hands the saved session to a worker and switches to the new session", async () => {
    const { controller, cli } = setup();
    controller.state.sessionId = "s-1";
    cli.json("workers list --json", [{ name: "reviewer", active: false, ownerName: null }]);
    cli.json("crew handoff worker:reviewer s-1 --provider codex-cli --mode general --effort low --approval review --model gpt-5.6-luna --json", { sessionId: "s-2", summary: "Picked up." });
    Object.assign(controller.state, { provider: "codex-cli", model: "gpt-5.6-luna", mode: "general", effort: "low" });

    controller.submit("/handoff");
    await flush();
    choose(controller, "reviewer");
    await flush();
    expect(controller.state).toMatchObject({ sessionId: "s-2", worker: "reviewer" });
    expect(controller.state.blocks.at(-1)).toMatchObject({ type: "assistant", text: "Picked up." });
  });

  it("refuses a handoff before there is a saved session", () => {
    const { controller } = setup();
    controller.submit("/handoff");
    expect(controller.picker).toBeUndefined();
    expect(controller.currentAlert).toMatchObject({ variant: "warning", title: expect.stringContaining("saved session") });
  });
});
