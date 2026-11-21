import fs from "node:fs";
import { DISABLED_TASKS } from "@onpoint-dev-tools/crewcoder-tui-core/state/crew-tasks";
import { afterEach, describe, expect, it } from "vitest";
import { SessionController } from "../session-controller.js";
import { readCrewHandoff } from "../tmux.js";
import { FakeBridge } from "./fake-bridge.js";
import { FakeCli } from "./fake-cli.js";

const controllers: SessionController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

function setup(): { bridge: FakeBridge; controller: SessionController } {
  const bridge = new FakeBridge();
  // Never the real task store or CLI: a crew opens the sidebar, which reads tasks.
  const controller = new SessionController(bridge, undefined, new FakeCli(), undefined, null, undefined, async () => DISABLED_TASKS);
  controllers.push(controller);
  return { bridge, controller };
}

describe("SessionController", () => {
  it("starts a new run in review approval mode and renders streamed events", () => {
    const { bridge, controller } = setup();
    let renders = 0;
    controller.subscribe(() => { renders += 1; });

    controller.submit("  fix the tests  ");
    bridge.emit({ type: "agent_start", sessionId: "s-1" });
    bridge.emit({ type: "thinking_delta", text: "Looking at failures" });
    bridge.emit({ type: "assistant_delta", text: "Done." });

    expect(bridge.runs).toHaveLength(1);
    expect(bridge.runs[0]).toMatchObject({ prompt: "fix the tests", approval: "review" });
    expect(controller.state.sessionId).toBe("s-1");
    expect(controller.state.blocks.map((block) => block.type)).toEqual(["user", "thinking", "assistant"]);
    expect(renders).toBeGreaterThanOrEqual(4);
  });

  it("resumes the saved session once the first run has ended", () => {
    const { bridge, controller } = setup();
    controller.submit("first");
    bridge.emit({ type: "agent_start", sessionId: "s-1" });
    bridge.emit({ type: "agent_end" });

    controller.submit("second");

    expect(bridge.runs).toHaveLength(1);
    expect(bridge.resumes).toEqual([expect.objectContaining({ sessionId: "s-1", prompt: "second" })]);
  });

  it("queues prompts typed during an active run as follow-ups", () => {
    const { bridge, controller } = setup();
    controller.submit("first");
    controller.submit("also check lint");

    expect(bridge.runs).toHaveLength(1);
    expect(bridge.followUps).toEqual(["also check lint"]);
    expect(controller.state.blocks.at(-1)).toMatchObject({ type: "user", text: "also check lint", background: ["Queued follow-up for the running turn."] });
  });

  it("resolves only the latest pending approval over the control channel", () => {
    const { bridge, controller } = setup();
    controller.submit("delete build");
    bridge.emit({ type: "approval_required", approvalId: "a-1", toolName: "bash", reason: "rm build" });

    expect(controller.pendingApproval()?.id).toBe("a-1");
    expect(controller.resolvePendingApproval(true)).toBe(true);
    bridge.emit({ type: "approval_resolved", approvalId: "a-1", approved: true });

    expect(bridge.approvals).toEqual([{ id: "a-1", approved: true }]);
    expect(controller.pendingApproval()).toBeUndefined();
    expect(controller.resolvePendingApproval(false)).toBe(false);
  });

  it("does not approve when no run is attached", () => {
    const { bridge, controller } = setup();
    controller.submit("x");
    bridge.emit({ type: "approval_required", approvalId: "a-1" });
    bridge.stop();

    expect(controller.resolvePendingApproval(true)).toBe(false);
    expect(bridge.approvals).toEqual([]);
  });

  it("aborts a running request and reports when nothing is running", () => {
    const { bridge, controller } = setup();
    expect(controller.abort()).toBe(false);

    controller.submit("long task");
    expect(controller.abort()).toBe(true);
    expect(bridge.running).toBe(false);
    expect(controller.state.running).toBe(false);

    controller.submit("/stop");
    expect(controller.currentAlert).toMatchObject({ variant: "info", title: "Nothing is running" });
  });

  it("/new clears session-scoped state and starts a fresh run next", () => {
    const { bridge, controller } = setup();
    controller.submit("first");
    bridge.emit({ type: "agent_start", sessionId: "s-1" });
    bridge.emit({ type: "agent_end" });
    controller.state.tokenBudget = 1000;
    controller.state.fullAccess = true;

    controller.submit("/new");
    controller.submit("again");

    expect(controller.state.sessionId).toBe("new");
    expect(controller.state.tokenBudget).toBeUndefined();
    expect(bridge.runs.at(-1)).toMatchObject({ prompt: "again", approval: "review" });
    expect(bridge.resumes).toHaveLength(0);
  });

  it("reports unported slash commands instead of sending them as prompts", () => {
    const { bridge, controller } = setup();

    controller.submit("/live-ui");

    expect(bridge.runs).toHaveLength(0);
    expect(controller.state.blocks).toEqual([]);
    expect(controller.currentAlert).toMatchObject({ variant: "warning", title: "/live-ui is not available in OpenTUI yet" });
  });

  it("streams a crew without moving this session or ending the run between workers", () => {
    const { bridge, controller } = setup();
    controller.state.sessionId = "s-user";
    controller.startCrew({ kind: "workers", workers: ["planner", "builder"] }, "ship it", "/crew planner,builder ship it");
    expect(controller.sidebar.open).toBe(true);

    bridge.emit({ type: "crew_start", workers: ["planner", "builder"] });
    bridge.emit({ type: "crew_worker_start", worker: "planner", index: 0, total: 2 });
    bridge.emit({ type: "agent_start", sessionId: "s-planner" });
    bridge.emit({ type: "assistant_delta", text: "planned" });
    bridge.emit({ type: "agent_end" });
    // Still one run: a follow-up goes to the crew, not a new process.
    expect(controller.bridgeRunning).toBe(true);
    expect(controller.state.running).toBe(true);
    controller.submit("also add tests");
    expect(bridge.followUps).toEqual(["also add tests"]);

    bridge.emit({ type: "crew_worker_end", worker: "planner", index: 0, total: 2, status: "completed", sessionId: "s-planner" });
    bridge.emit({ type: "crew_worker_start", worker: "builder", index: 1, total: 2 });
    bridge.emit({ type: "crew_worker_end", worker: "builder", index: 1, total: 2, status: "completed", sessionId: "s-builder" });
    bridge.emit({ type: "crew_end", total: 2, completed: 2, failed: 0 });

    expect(controller.state.running).toBe(false);
    expect(controller.state.sessionId).toBe("s-user");
    expect(controller.state.crewSessionIds).toEqual(["s-planner", "s-builder"]);
    // The next prompt continues the user's session, not the last worker's.
    controller.submit("next");
    expect(bridge.resumes.at(-1)).toMatchObject({ sessionId: "s-user", prompt: "next" });
  });

  describe("crews in tmux", () => {
    const tmuxSetup = (fail = false) => {
      const { bridge, controller } = setup();
      const launches: Array<{ command: readonly string[]; cwd: string; label: string }> = [];
      controller.crewTmux = {
        launcher: {
          async launch(command, cwd, label) {
            launches.push({ command, cwd, label });
            if (fail) throw new Error("no server running");
            return { kind: "session", name: "crew-planner-ab12" };
          }
        },
        command: (file) => ["node", "cli.js", "--crew-file", file]
      };
      return { bridge, controller, launches };
    };
    const pick = (controller: SessionController, id: string): void => {
      const index = controller.picker?.items.findIndex((item) => item.id === id) ?? -1;
      controller.movePickerCursor(index - controller.pickerCursor);
      controller.selectPickerItem();
    };

    it("asks where the crew runs; Run here streams it in this UI", () => {
      const { bridge, controller, launches } = tmuxSetup();
      controller.launchCrew({ kind: "workers", workers: ["planner"] }, "ship it", "/crew planner ship it");
      expect(controller.picker).toMatchObject({ kind: "crewLaunch", title: "Where should planner run?" });
      expect(controller.picker?.items.map((item) => item.id)).toEqual(["tmux", "here"]);
      expect(bridge.crews).toEqual([]);

      pick(controller, "here");
      expect(bridge.crews).toHaveLength(1);
      expect(launches).toEqual([]);
    });

    it("Run in tmux hands the crew to a second UI through a private file and records how to attach", async () => {
      const { bridge, controller, launches } = tmuxSetup();
      Object.assign(controller.state, { provider: "claude", model: "opus", effort: "high", fullAccess: true });
      controller.launchCrew({ kind: "team", team: "feature" }, "ship it", "/team feature ship it");
      pick(controller, "tmux");
      await new Promise((resolve) => setImmediate(resolve));

      expect(bridge.crews).toEqual([]);
      expect(launches).toHaveLength(1);
      expect(launches[0]?.label).toBe("team feature");
      const file = launches[0]?.command.at(-1) ?? "";
      // The task and settings travel in the file, never on the command line.
      expect(launches[0]?.command.join(" ")).not.toContain("ship it");
      const handoff = readCrewHandoff(file);
      expect(handoff).toMatchObject({ target: { kind: "team", team: "feature" }, task: "ship it", provider: "claude", model: "opus", effort: "high", fullAccess: true });
      expect(controller.state.blocks).toEqual([
        { type: "user", text: "/team feature ship it" },
        { type: "system", text: "Started tmux session crew-planner-ab12. Attach with: tmux attach -t crew-planner-ab12" }
      ]);
    });

    it("Esc cancels the crew; a failed launch reports the error and removes the file", async () => {
      const { bridge, controller } = tmuxSetup();
      controller.launchCrew({ kind: "workers", workers: ["planner"] }, "ship it", "/crew planner ship it");
      controller.closePicker();
      pick(controller, "here");
      expect(bridge.crews).toEqual([]);

      const failing = tmuxSetup(true);
      failing.controller.launchCrew({ kind: "workers", workers: ["planner"] }, "ship it", "/crew planner ship it");
      pick(failing.controller, "tmux");
      await new Promise((resolve) => setImmediate(resolve));
      expect(failing.controller.currentAlert).toMatchObject({ variant: "error", title: "Could not start the crew in tmux", body: "no server running" });
      expect(fs.existsSync(failing.launches[0]?.command.at(-1) ?? "")).toBe(false);
      expect(failing.controller.state.blocks).toEqual([]);
    });

    it("runs here without asking when tmux is not wired (not installed, or remote)", () => {
      const { bridge, controller } = setup();
      controller.launchCrew({ kind: "workers", workers: ["planner"] }, "ship it", "/crew planner ship it");
      expect(controller.picker).toBeUndefined();
      expect(bridge.crews).toHaveLength(1);
    });
  });

  it("finishes the roster when a crew is stopped, and forgets it on /new", () => {
    const { bridge, controller } = setup();
    controller.startCrew({ kind: "team", team: "feature" }, "ship it", "/team feature ship it");
    bridge.emit({ type: "crew_start", workers: ["planner", "builder"] });
    bridge.emit({ type: "crew_worker_start", worker: "planner", index: 0, total: 2 });

    expect(controller.abort()).toBe(true);
    expect(controller.state.crewWorkers.map((worker) => worker.status)).toEqual(["failed", "failed"]);
    expect(controller.state.blocks.find((block) => block.type === "crew")).toMatchObject({ completed: true });

    controller.submit("/new");
    expect(controller.state.crewWorkers).toEqual([]);
    expect(controller.state.crewSessionIds).toEqual([]);
  });

  it("ignores blank input", () => {
    const { bridge, controller } = setup();
    controller.submit("   ");
    expect(bridge.runs).toHaveLength(0);
    expect(controller.state.blocks).toEqual([]);
  });
});
