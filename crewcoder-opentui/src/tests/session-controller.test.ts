import { describe, expect, it } from "vitest";
import { SessionController } from "../session-controller.js";
import { FakeBridge } from "./fake-bridge.js";

function setup(): { bridge: FakeBridge; controller: SessionController } {
  const bridge = new FakeBridge();
  return { bridge, controller: new SessionController(bridge) };
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
    expect(controller.state.blocks.at(-1)).toMatchObject({ type: "system", text: "Nothing is running." });
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
    controller.submit("/goal ship it");

    expect(bridge.runs).toHaveLength(0);
    expect(controller.state.blocks).toEqual([
      { type: "error", text: expect.stringContaining("/goal is not available in the OpenTUI preview") }
    ]);
  });

  it("ignores blank input", () => {
    const { bridge, controller } = setup();
    controller.submit("   ");
    expect(bridge.runs).toHaveLength(0);
    expect(controller.state.blocks).toEqual([]);
  });
});
