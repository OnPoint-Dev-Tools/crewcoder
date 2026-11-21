import type { CrewTaskSnapshot } from "@onpoint-dev-tools/crewcoder-tui-core/state/crew-tasks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../session-controller.js";
import { TASK_POLL_MS, type TaskReader } from "../sidebar.js";
import { FakeBridge } from "./fake-bridge.js";
import { FakeCli, flush } from "./fake-cli.js";

const enabled = (subjects: string[]): CrewTaskSnapshot =>
  ({ enabled: true, tasks: subjects.map((subject, index) => ({ id: String(index + 1), subject, status: "pending", sessionId: "s1" })) });

const controllers: SessionController[] = [];

function setup(readTasks: TaskReader | null = vi.fn(async () => enabled([]))) {
  const bridge = new FakeBridge();
  const controller = new SessionController(bridge, undefined, new FakeCli(), undefined, null, undefined, readTasks);
  controllers.push(controller);
  const changes = vi.fn();
  controller.subscribe(changes);
  return { bridge, controller, changes };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe("sidebar controller", () => {
  it("starts closed; opening reads the task store, then polls it until closed", async () => {
    vi.useFakeTimers();
    const reader = vi.fn(async () => enabled(["a"]));
    const { controller } = setup(reader);
    expect(controller.sidebar.open).toBe(false);
    expect(controller.sidebar.columns(100)).toBe(0);
    expect(reader).not.toHaveBeenCalled();

    controller.sidebar.toggle();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.sidebar.columns(100)).toBe(26);
    expect(controller.sidebar.tasks?.tasks.map((item) => item.subject)).toEqual(["a"]);
    expect(reader).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TASK_POLL_MS * 2);
    expect(reader).toHaveBeenCalledTimes(3);

    controller.sidebar.toggle();
    await vi.advanceTimersByTimeAsync(TASK_POLL_MS * 3);
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it("renders only when the task store actually changed", async () => {
    let snapshot = enabled(["a"]);
    const { controller, changes } = setup(async () => snapshot);
    controller.sidebar.setOpen(true);
    await flush();
    const after = changes.mock.calls.length;
    await controller.sidebar.refreshTasks();
    expect(changes.mock.calls.length).toBe(after);
    snapshot = enabled(["a", "b"]);
    await controller.sidebar.refreshTasks();
    expect(changes.mock.calls.length).toBe(after + 1);
  });

  it("keeps the last snapshot when the store cannot be read", async () => {
    let fail = false;
    const { controller } = setup(async () => {
      if (fail) throw new Error("EACCES");
      return enabled(["kept"]);
    });
    await controller.sidebar.refreshTasks();
    fail = true;
    await controller.sidebar.refreshTasks();
    expect(controller.sidebar.tasks?.tasks[0]?.subject).toBe("kept");
  });

  it("has no task snapshot where tasks cannot be read (remote workspaces)", () => {
    const { controller } = setup(null);
    expect(controller.sidebar.tasks).toBeUndefined();
  });

  it("rereads tasks after task tools and runs, and the git label after each run", async () => {
    const reader = vi.fn(async () => enabled([]));
    const { controller, bridge } = setup(reader);
    const labels = vi.fn(async () => "feature*");
    controller.sidebar.gitLabelReader = labels;
    controller.state.gitLabel = "feature";
    controller.submit("go");
    bridge.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "TaskUpdate", result: { content: [] } });
    await flush();
    expect(reader).not.toHaveBeenCalled();

    controller.sidebar.setOpen(true);
    await flush();
    bridge.emit({ type: "tool_execution_end", toolCallId: "t2", toolName: "TaskUpdate", result: { content: [] } });
    bridge.emit({ type: "agent_end" });
    await flush();
    expect(reader).toHaveBeenCalledTimes(3);
    expect(labels).toHaveBeenCalledWith(controller.state.cwd);
    expect(controller.state.gitLabel).toBe("feature*");
  });

  it("clamps a dragged width and remembers it", () => {
    const { controller } = setup();
    controller.sidebar.setOpen(true);
    controller.sidebar.resize(40, 120);
    expect(controller.sidebar.columns(120)).toBe(40);
    controller.sidebar.resize(5, 120);
    expect(controller.sidebar.columns(120)).toBe(18);
    expect(controller.sidebar.columns(50)).toBe(0);
    expect(controller.sidebar.hiddenByWidth).toBe(true);
  });
});

describe("/sidebar and /file-changes", () => {
  async function run(controller: SessionController, command: string): Promise<void> {
    controller.submit(command);
    await flush();
  }

  it("/sidebar toggles bare, and on/off/status are explicit; nothing reaches the agent", async () => {
    const { controller, bridge } = setup();
    await run(controller, "/sidebar");
    expect(controller.sidebar.open).toBe(true);
    await run(controller, "/sidebar on");
    expect(controller.currentAlert?.title).toBe("Sidebar already open");
    await run(controller, "/sidebar status");
    expect(controller.currentAlert?.title).toBe("Sidebar is open");
    await run(controller, "/sidebar off");
    expect(controller.sidebar.open).toBe(false);
    await run(controller, "/sidebar maybe");
    expect(controller.currentAlert).toMatchObject({ title: "Usage", body: expect.stringContaining("/sidebar on|off|status") });
    expect(bridge.runs).toHaveLength(0);
    expect(controller.state.blocks).toEqual([]);
  });

  it("/sidebar warns when the terminal is too narrow to show it", async () => {
    const { controller } = setup();
    controller.sidebar.columns(50);
    await run(controller, "/sidebar on");
    expect(controller.sidebar.open).toBe(true);
    expect(controller.currentAlert).toMatchObject({ variant: "warning", body: expect.stringContaining("60 columns") });
  });

  it("/file-changes hides the list without dropping tracked files, and survives /new", async () => {
    const { controller } = setup();
    controller.state.changedFiles = ["a.ts", "b.ts"];
    await run(controller, "/file-changes off");
    expect(controller.state.showFileChanges).toBe(false);
    expect(controller.state.changedFiles).toEqual(["a.ts", "b.ts"]);
    expect(controller.currentAlert?.body).toContain("2 changed");
    expect(controller.currentAlert?.body).toContain("sidebar is closed");
    await run(controller, "/new");
    expect(controller.state.showFileChanges).toBe(false);
    await run(controller, "/file-changes");
    expect(controller.state.showFileChanges).toBe(true);
    await run(controller, "/file-changes status");
    expect(controller.currentAlert?.title).toBe("File changes display is on");
  });
});
