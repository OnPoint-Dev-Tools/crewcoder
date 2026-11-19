import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alertLines, alertRows, MAX_ALERT_BODY_LINES } from "../alert-model.js";
import { SLASH_COMMANDS } from "../commands.js";
import { pickerEntries } from "../palette-model.js";
import { SessionController } from "../session-controller.js";
import { FakeBridge } from "./fake-bridge.js";
import { FakeCli, flush } from "./fake-cli.js";

function setup(): { bridge: FakeBridge; cli: FakeCli; controller: SessionController } {
  const bridge = new FakeBridge();
  const cli = new FakeCli();
  const controller = new SessionController(bridge, undefined, cli);
  Object.assign(controller.state, { provider: "codex-cli", model: "gpt-6-luna", effort: "low", mode: "general" });
  return { bridge, cli, controller };
}

async function run(controller: SessionController, command: string): Promise<void> {
  controller.submit(command);
  await flush();
}

function choose(controller: SessionController, id: string): void {
  const entries = pickerEntries(controller.picker?.items ?? [], controller.pickerQuery);
  const index = entries.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`${id} not in ${entries.map((item) => item.id).join(", ")}`);
  controller.movePickerCursor(index - controller.pickerCursor);
  controller.selectPickerItem();
}

afterEach(() => vi.unstubAllEnvs());

describe("palette catalog", () => {
  it("lists every requested command and skips /crew", () => {
    const labels = SLASH_COMMANDS.map((item) => item.label);
    for (const name of ["/branch", "/compact", "/compact preview", "/export", "/reload", "/goal", "/thinking", "/workers", "/identity",
      "/full-access", "/checkpoints", "/memory", "/remember", "/set-budget", "/add-dir", "/remove-dir", "/commands", "/extensions",
      "/review-summary", "/why", "/task", "/teams", "/team", "/approve", "/approve-plan", "/deny", "/follow-up", "/clear", "/help",
      "/sidebar", "/file-changes"]) {
      expect(labels).toContain(name);
    }
    expect(labels).not.toContain("/crew");
    expect(new Set(SLASH_COMMANDS.map((item) => item.id)).size).toBe(SLASH_COMMANDS.length);
  });

  it("puts argument commands into the composer instead of running them", () => {
    const { controller, bridge } = setup();
    controller.openCommandPalette();
    choose(controller, "draft:/remember ");
    expect(controller.composerDraft).toBe("/remember ");
    expect(bridge.runs).toHaveLength(0);
  });

  it("/help opens the palette", async () => {
    const { controller } = setup();
    await run(controller, "/help");
    expect(controller.picker?.kind).toBe("commands");
  });
});

describe("on/off/status commands", () => {
  it("opens a menu with the current config value marked, then saves the choice", async () => {
    const { controller, cli } = setup();
    cli.json("config show", { thinkingEnabled: false });
    cli.json("config set thinkingEnabled true", {});
    await run(controller, "/thinking");
    expect(controller.picker?.items.find((item) => item.current)?.id).toBe("/thinking off");
    choose(controller, "/thinking on");
    await flush();
    expect(cli.ran("config set thinkingEnabled true")).toBe(true);
    expect(controller.state.thinkingEnabled).toBe(true);
    expect(controller.currentAlert).toMatchObject({ variant: "success", title: "Provider thinking turned on" });
  });

  it("reports status using the backend defaults", async () => {
    const { controller, cli } = setup();
    cli.json("config show", {});
    await run(controller, "/checkpoints status");
    // Checkpoints are opt-in: a config without the key means off.
    expect(controller.currentAlert).toMatchObject({ variant: "info", title: "Automatic checkpoints: off" });
    await run(controller, "/identity status");
    expect(controller.currentAlert).toMatchObject({ title: "Worker identity: off" });
    await run(controller, "/compact status");
    expect(controller.currentAlert).toMatchObject({ title: "Automatic compaction: on" });
  });

  it("rejects bad values with a usage alert and never saves", async () => {
    const { controller, cli } = setup();
    await run(controller, "/thinking maybe");
    expect(controller.currentAlert).toMatchObject({ variant: "warning", title: "Usage" });
    expect(cli.calls).toEqual([]);
  });

  it("/full-access warns when enabled and is session state", async () => {
    const { controller, bridge } = setup();
    await run(controller, "/full-access on");
    expect(controller.currentAlert).toMatchObject({ variant: "warning", title: "Full access enabled" });
    controller.submit("go");
    expect(bridge.runs[0]).toMatchObject({ approval: "full-access" });
  });

  it("/task on|off is instance-local and never touches the shared config", async () => {
    const { controller, cli } = setup();
    vi.stubEnv("CREWCODER_TASKS_ENABLED", undefined);
    await run(controller, "/task off");
    expect(process.env.CREWCODER_TASKS_ENABLED).toBe("false");
    expect(cli.calls).toEqual([]);
    await run(controller, "/task");
    expect(controller.picker?.items.find((item) => item.current)?.id).toBe("/task off");
  });

  it("/memory shows the CLI text in an alert", async () => {
    const { controller, cli } = setup();
    cli.responses.set("memory list", { stdout: "1. use pnpm\n2. tests in vitest", stderr: "", exitCode: 0 });
    await run(controller, "/memory list");
    expect(controller.currentAlert).toMatchObject({ variant: "info", title: "Remembered facts", body: "1. use pnpm\n2. tests in vitest" });
  });
});

describe("/plugins", () => {
  it("needs the crewcode profile, then lists templates", async () => {
    const { controller, cli } = setup();
    await run(controller, "/plugins");
    expect(controller.currentAlert).toMatchObject({ variant: "warning", body: "Enable it with /profile crewcode." });
    expect(cli.calls).toEqual([]);
    controller.state.integrationProfile = "crewcode";
    cli.responses.set("plugin list-templates", { stdout: "static-panel\nframework-panel", stderr: "", exitCode: 0 });
    await run(controller, "/plugins");
    expect(controller.currentAlert).toMatchObject({ title: "CrewCode plugin templates", body: "static-panel\nframework-panel" });
  });
});

describe("text output commands", () => {
  it.each([
    ["/extensions", "extension list", "Extensions"],
    ["/teams", "crew team list", "Teams"]
  ])("%s shows the CLI output", async (command, args, title) => {
    const { controller, cli } = setup();
    cli.responses.set(args, { stdout: "one\ntwo", stderr: "", exitCode: 0 });
    await run(controller, command);
    expect(controller.currentAlert).toMatchObject({ title, body: "one\ntwo" });
  });

  it("shows CLI failures as error alerts", async () => {
    const { controller, cli } = setup();
    cli.fail("extension list", "boom");
    await run(controller, "/extensions");
    expect(controller.currentAlert).toMatchObject({ variant: "error", body: "boom" });
  });

  it("/team runs the team with the session's settings", async () => {
    const { controller, cli } = setup();
    cli.responses.set("crew team run review fix the bug --provider codex-cli --mode general --effort low --approval review --model gpt-6-luna", { stdout: "done", stderr: "", exitCode: 0 });
    await run(controller, "/team review fix the bug");
    expect(controller.currentAlert).toMatchObject({ title: "Team review", body: "done" });
    await run(controller, "/team");
    expect(controller.currentAlert).toMatchObject({ title: "Usage" });
  });

  it("/why is a one-shot call that never adds a turn", async () => {
    const { controller, cli, bridge } = setup();
    controller.state.sessionId = "s-1";
    cli.json("session why s-1 --json --provider codex-cli --model gpt-6-luna --effort low", {
      explained: true, explanation: "Ran the tests first.", source: "transcript", fallbackReason: "model timeout", decision: { toolCalls: [{ name: "bash" }], changedFiles: [] }
    });
    await run(controller, "/why");
    expect(controller.currentAlert).toMatchObject({ variant: "warning", title: "Why · transcript readout" });
    expect(controller.currentAlert?.body).toContain("Fallback: model timeout");
    expect(controller.state.blocks).toEqual([]);
    expect(bridge.runs).toHaveLength(0);
  });

  it("/review-summary formats branch, files, and issues", async () => {
    const { controller, cli } = setup();
    cli.json("git review-summary --json", { branch: "feat/x", clean: false, changedFiles: ["a.ts"], issueReferences: [{ id: "#12", source: "branch", text: "fix" }] });
    await run(controller, "/review-summary");
    expect(controller.currentAlert?.body).toBe("Branch: feat/x · 1 changed\n  a.ts\nIssues:\n  #12 (branch) fix");
  });
});

describe("session commands", () => {
  it("/branch switches to the branched session", async () => {
    const { controller, cli } = setup();
    controller.state.sessionId = "s-1";
    await run(controller, "/branch");
    expect(cli.branches).toEqual(["s-1"]);
    expect(controller.state.sessionId).toBe("branch-1");
  });

  it("/branch is refused while a run is active, and works once it ends", async () => {
    const { controller, cli, bridge } = setup();
    controller.state.sessionId = "s-1";
    controller.submit("keep going");
    await run(controller, "/branch");
    expect(cli.branches).toEqual([]);
    expect(controller.state.sessionId).toBe("s-1");
    expect(bridge.stops).toBe(0);
    expect(controller.currentAlert).toMatchObject({ variant: "warning", title: "Wait for the current run to finish before branching the session", body: "Use /stop to end it." });

    bridge.emit({ type: "agent_end" });
    await run(controller, "/branch");
    expect(cli.branches).toEqual(["s-1"]);
    expect(controller.state.sessionId).toBe("branch-1");
  });

  it("session commands need a saved session", async () => {
    const { controller, cli } = setup();
    for (const command of ["/branch", "/export", "/compact", "/why"]) {
      await run(controller, command);
      expect(controller.currentAlert).toMatchObject({ variant: "warning", title: expect.stringContaining("No saved session") });
    }
    expect(cli.calls).toEqual([]);
  });

  it("/export defaults to <session>.html", async () => {
    const { controller, cli } = setup();
    controller.state.sessionId = "s-1";
    cli.responses.set("session export s-1 --html --out s-1.html", { stdout: "Wrote s-1.html", stderr: "", exitCode: 0 });
    await run(controller, "/export");
    expect(controller.currentAlert).toMatchObject({ variant: "success", body: "Wrote s-1.html" });
  });

  it("/compact reports the message counts", async () => {
    const { controller, cli } = setup();
    controller.state.sessionId = "s-1";
    cli.json("session compact s-1 --provider codex-cli --model gpt-6-luna --effort low --json", { compacted: true, originalMessageCount: 40, retainedMessageCount: 6 });
    await run(controller, "/compact");
    expect(controller.currentAlert).toMatchObject({ variant: "success", body: "40 → 6 messages" });
  });

  it("/reload applies config defaults and the provider catalog", async () => {
    const { controller, cli } = setup();
    cli.json("config show", { defaultProvider: "opencode", defaultMode: "crewcoder", thinkingEnabled: false });
    cli.responses.set("profile show", { stdout: "standalone\n", stderr: "", exitCode: 0 });
    cli.providerList = [{ id: "opencode", title: "OpenCode", models: ["sonnet"], defaultModel: "sonnet" }];
    await run(controller, "/reload");
    expect(controller.state).toMatchObject({ provider: "opencode", model: "sonnet", mode: "crewcoder", thinkingEnabled: false });
    expect(controller.currentAlert).toMatchObject({ variant: "success", title: "Reloaded CrewCoder" });
  });

  it("/clear empties the conversation and returns to the welcome screen", async () => {
    const { controller } = setup();
    controller.state.blocks.push({ type: "system", text: "old" });
    await run(controller, "/clear");
    expect(controller.state.blocks).toEqual([]);
  });

  it("/clear refuses during a run", async () => {
    const { controller } = setup();
    controller.submit("work");
    await run(controller, "/clear");
    expect(controller.state.blocks).toEqual([{ type: "user", text: "work" }]);
  });

  describe("/diff", () => {
    it("opens Hunk on the files this session changed, relative to the workspace", async () => {
      const { controller } = setup();
      const runInTerminal = vi.fn(async () => ({ code: 0, stderr: "", missing: false }));
      controller.runInTerminal = runInTerminal;
      controller.state.cwd = "/repo";
      controller.state.changedFiles = ["/repo/src/a.ts", "src/b.ts", "/repo/src/a.ts"];
      await run(controller, "/diff");
      expect(runInTerminal).toHaveBeenCalledWith("hunk", ["diff", "--", "src/a.ts", "src/b.ts"], "/repo");
      expect(controller.currentAlert).toBeUndefined();
    });

    it("shows the whole working tree when the session changed nothing", async () => {
      const { controller } = setup();
      const runInTerminal = vi.fn(async () => ({ code: 0, stderr: "", missing: false }));
      controller.runInTerminal = runInTerminal;
      await run(controller, "/diff");
      expect(runInTerminal).toHaveBeenCalledWith("hunk", ["diff"], controller.state.cwd);
    });

    it("explains how to install Hunk when it is missing, and reports failures", async () => {
      const { controller } = setup();
      controller.runInTerminal = async () => ({ code: null, stderr: "", missing: true });
      await run(controller, "/diff");
      expect(controller.currentAlert).toMatchObject({ variant: "error", title: "Hunk is not installed" });
      expect(controller.currentAlert?.body).toContain("npm install -g hunkdiff");

      controller.runInTerminal = async () => ({ code: 1, stderr: "fatal: not a git repository\n", missing: false });
      await run(controller, "/diff");
      expect(controller.currentAlert).toMatchObject({ variant: "error", title: "hunk diff exited with 1", body: "fatal: not a git repository" });
    });

    it("needs an interactive terminal", async () => {
      const { controller } = setup();
      await run(controller, "/diff");
      expect(controller.currentAlert).toMatchObject({ variant: "warning", title: "/diff needs an interactive terminal" });
    });
  });

  describe("/quit", () => {
    it("exits through the same path as Ctrl+C", async () => {
      const { controller, bridge } = setup();
      const quit = vi.fn();
      controller.quit = quit;
      await run(controller, "/quit");
      expect(quit).toHaveBeenCalledTimes(1);
      expect(bridge.runs).toHaveLength(0);
    });

    it("explains Ctrl+C without an interactive terminal", async () => {
      const { controller } = setup();
      await run(controller, "/quit");
      expect(controller.currentAlert).toMatchObject({ variant: "warning", title: "/quit needs an interactive terminal" });
    });
  });

  describe("/ext.<name>", () => {
    it("runs the extension command through the CLI with its arguments after --, never as a prompt", async () => {
      const { controller, cli, bridge } = setup();
      cli.responses.set("command run ext.lint.fix -- src/a.ts --dry-run", { stdout: "Fixed 2 files\n", stderr: "", exitCode: 0 });
      await run(controller, "/ext.lint.fix src/a.ts   --dry-run");
      expect(cli.calls.at(-1)).toEqual(["command", "run", "ext.lint.fix", "--", "src/a.ts", "--dry-run"]);
      expect(controller.currentAlert?.variant).not.toBe("error");
      expect(JSON.stringify(controller.currentAlert)).toContain("Fixed 2 files");
      expect(bridge.runs).toHaveLength(0);
      expect(controller.state.blocks).toHaveLength(0);
    });

    it("reports a failing or untrusted extension command as an error alert", async () => {
      const { controller, cli } = setup();
      cli.fail("command run ext.lint.fix --", "Extension lint is not trusted.");
      await run(controller, "/ext.lint.fix");
      expect(controller.currentAlert?.variant).toBe("error");
      expect(JSON.stringify(controller.currentAlert)).toContain("Extension lint is not trusted.");
    });

    it("shows usage for a bare /ext.", async () => {
      const { controller, cli } = setup();
      await run(controller, "/ext.");
      expect(controller.currentAlert).toMatchObject({ variant: "warning", title: "Usage" });
      expect(cli.calls).toHaveLength(0);
    });
  });

  describe("/repaint", () => {
    it("redraws the screen silently, also as /redraw, without touching the transcript or the agent", async () => {
      const { controller, bridge } = setup();
      const repaint = vi.fn();
      controller.repaint = repaint;
      controller.state.blocks = [{ type: "user", text: "keep me" }];
      await run(controller, "/repaint");
      await run(controller, "/redraw");
      expect(repaint).toHaveBeenCalledTimes(2);
      expect(controller.currentAlert).toBeUndefined();
      expect(controller.state.blocks).toEqual([{ type: "user", text: "keep me" }]);
      expect(bridge.runs).toHaveLength(0);
    });

    it("needs an interactive terminal", async () => {
      const { controller } = setup();
      await run(controller, "/repaint");
      expect(controller.currentAlert).toMatchObject({ variant: "warning", title: "/repaint needs an interactive terminal" });
    });
  });

  it("/set-budget parses shorthand and applies to the next run", async () => {
    const { controller, bridge } = setup();
    await run(controller, "/set-budget 1.5m");
    expect(controller.currentAlert).toMatchObject({ title: "Token budget set to 1.5m tokens" });
    controller.submit("go");
    expect(bridge.runs[0]).toMatchObject({ budget: 1_500_000 });
  });

  it("/add-dir validates the path through the CLI before a session exists", async () => {
    const { controller, cli } = setup();
    cli.json("session validate-dir ../shared --json", { path: "/abs/shared" });
    await run(controller, "/add-dir ../shared");
    expect(controller.state.externalDirectories).toEqual(["/abs/shared"]);
  });
});

describe("goals", () => {
  it("starts a detached goal with inline flags and the session settings", async () => {
    const { controller, cli } = setup();
    const args = "goal start ship the release --provider codex-cli --model gpt-6-luna --mode general --effort low --approval review --json --max-turns 5";
    cli.json(args, { id: "g-1", objective: "ship the release", status: "running", provider: "codex-cli", model: "gpt-6-luna", cycle: 0, maxTurns: 5 });
    await run(controller, "/goal --max-turns 5 ship the release");
    expect(cli.ran(args)).toBe(true);
    expect(controller.currentAlert).toMatchObject({ title: "Goal" });
    expect(controller.currentAlert?.body).toContain("g-1 · running · turn 0/5");
  });

  it("reports flag errors instead of starting", async () => {
    const { controller, cli } = setup();
    await run(controller, "/goal --max-turns nope do it");
    expect(controller.currentAlert).toMatchObject({ variant: "error", body: expect.stringContaining("--max-turns") });
    expect(cli.calls).toEqual([]);
  });
});

describe("approvals and follow-ups", () => {
  it("/approve and /deny need a pending approval", async () => {
    const { controller, bridge } = setup();
    await run(controller, "/approve");
    expect(controller.currentAlert).toMatchObject({ title: "No pending approval to approve" });
    controller.submit("rm it");
    bridge.emit({ type: "approval_required", approvalId: "a-1", toolName: "bash" });
    await run(controller, "/deny");
    expect(bridge.approvals).toEqual([{ id: "a-1", approved: false }]);
  });

  it("/approve-plan is a prompt when idle and a follow-up during a run", async () => {
    const { controller, bridge } = setup();
    await run(controller, "/approve-plan");
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "/approve-plan" });
    await run(controller, "/approve-plan");
    expect(bridge.followUps).toEqual(["/approve-plan"]);
  });

  it("/follow-up queues into the active run and refuses when idle", async () => {
    const { controller, bridge } = setup();
    await run(controller, "/follow-up also lint");
    expect(controller.currentAlert).toMatchObject({ title: "No active run" });
    controller.submit("start");
    await run(controller, "/follow-up also lint");
    expect(bridge.followUps).toEqual(["also lint"]);
  });
});

describe("compaction preview", () => {
  it("idle: edits the summary and applies it from a temp file that is removed after", async () => {
    const { controller, cli } = setup();
    controller.state.sessionId = "s-1";
    cli.json("session compact s-1 --preview --provider codex-cli --model gpt-6-luna --effort low --json", { preview: true, summary: "old summary", originalMessageCount: 10, retainedMessageCount: 2 });
    let summaryFile = "";
    let written = "";
    const exec = cli.exec.bind(cli);
    cli.exec = async (args) => {
      const index = args.indexOf("--summary-file");
      if (index >= 0) {
        summaryFile = args[index + 1] ?? "";
        written = fs.readFileSync(summaryFile, "utf8");
        return { stdout: "{}", stderr: "", exitCode: 0 };
      }
      return exec(args);
    };
    await run(controller, "/compact preview");
    expect(controller.editor).toMatchObject({ summary: "old summary", context: { mode: "idle", sessionId: "s-1" } });

    controller.resolveSummary(true, "edited summary");
    // Real file I/O: wait for the result rather than a fixed number of ticks.
    await vi.waitFor(() => expect(controller.currentAlert).toMatchObject({ variant: "success" }));
    expect(written).toBe("edited summary");
    expect(fs.existsSync(summaryFile)).toBe(false);
    expect(controller.editor).toBeUndefined();
    expect(controller.currentAlert).toMatchObject({ variant: "success" });
  });

  it("live: a preview event opens the editor and the answer goes back over the bridge", async () => {
    const { controller, bridge } = setup();
    controller.submit("long task");
    await run(controller, "/compact preview");
    expect(bridge.previewRequests).toBe(1);
    bridge.emit({ type: "session_compaction_preview", previewId: "p-1", summary: "proposed" });
    expect(controller.editor?.context).toEqual({ mode: "live", previewId: "p-1" });
    controller.resolveSummary(false, "");
    expect(bridge.previewResolutions).toEqual([{ previewId: "p-1", approved: false, summary: undefined }]);
  });
});

describe("alerts", () => {
  it("clamps long output and sizes the footer for it", () => {
    const body = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const lines = alertLines({ variant: "info", title: "t", body });
    expect(lines).toHaveLength(MAX_ALERT_BODY_LINES);
    expect(lines.at(-1)).toBe(`… ${30 - (MAX_ALERT_BODY_LINES - 1)} more lines`);
    expect(alertRows({ variant: "info", title: "t", body })).toBe(3 + MAX_ALERT_BODY_LINES);
    expect(alertRows({ variant: "info", title: "t" })).toBe(3);
    expect(alertRows(undefined)).toBe(0);
  });

  it("strips terminal control sequences from CLI text", () => {
    expect(alertLines({ variant: "info", title: "t", body: "\u001b[31mred\u001b[0m" })).toEqual(["red"]);
  });

  it("is part of the footer height and goes away when dismissed", () => {
    const { controller } = setup();
    controller.alert({ variant: "info", title: "x", body: "a\nb" });
    expect(controller.footerExtras().alertRows).toBe(5);
    controller.dismissAlert();
    expect(controller.footerExtras().alertRows).toBe(0);
  });
});
