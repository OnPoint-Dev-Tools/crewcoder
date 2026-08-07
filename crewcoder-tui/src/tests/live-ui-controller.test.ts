import { describe, expect, it, vi } from "vitest";
import { LiveUiController } from "../bridge/live-ui-controller.js";
import { LiveUiTrustGate } from "../bridge/live-ui-trust-gate.js";
import { LiveUiInstanceRegistry } from "../bridge/live-ui-registry.js";
import { LiveUiRepaintScheduler } from "../bridge/live-ui-frame.js";
import { LiveUiHost } from "../bridge/live-ui-host.js";
import { stripAnsi } from "../tui/ansi.js";
import type { LiveUiWorkerLike, LiveUiWorkerSpec } from "../bridge/live-ui-host.js";
import type { CrewCoderLiveUiHost, CrewCoderLiveUiInstance, CrewCoderLiveUiProps, LiveUiFrame } from "../bridge/live-ui-protocol.js";

const theme = { border: "#18372c", focusBorder: "#285a48", title: "#cccccc", text: "#ffffff" };

class FakeWorker implements LiveUiWorkerLike {
  posted: unknown[] = [];
  terminated = 0;
  private listeners = new Map<string, ((value: unknown) => void)[]>();
  postMessage(value: unknown): void { this.posted.push(value); }
  on(event: string, listener: (value: unknown) => void): this {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return this;
  }
  terminate(): Promise<number> { this.terminated += 1; return Promise.resolve(0); }
  emit(event: string, value?: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value); }
}

function props(): CrewCoderLiveUiProps {
  return { extensionId: "review-pack", contributionId: "review-panel", surface: "modal", event: { type: "extension_ui_request" } };
}

function grant(): CrewCoderLiveUiHost {
  return {
    protocolVersion: "0.1",
    transport: "worker-postmessage",
    permissions: { ui: ["render", "input", "focus"], commands: ["ui_response"], storage: "session" },
    limits: { maxRenderLines: 50, maxLineLength: 200, maxPayloadBytes: 8192 }
  };
}

function instance(): CrewCoderLiveUiInstance {
  return {
    instanceId: "i1",
    extensionId: "review-pack",
    contributionId: "review-panel",
    surface: "modal",
    canReceiveInput: true,
    focusInfo: { instanceId: "i1", extensionId: "review-pack", contributionId: "review-panel", title: "review-pack/review-panel" }
  };
}

function frameOf(text: string): LiveUiFrame {
  return { width: 10, height: 1, lines: [[{ text }]] };
}

function setup(allowed = true, callbacks = {}) {
  const trustGate = new LiveUiTrustGate();
  trustGate.allowed = allowed;
  const registry = new LiveUiInstanceRegistry();
  const scheduler = new LiveUiRepaintScheduler(() => {}, (cb) => cb());
  const controller = new LiveUiController({ trustGate, registry, scheduler, callbacks });
  const worker = new FakeWorker();
  const factory = (_spec: LiveUiWorkerSpec): LiveUiWorkerLike => worker;
  return { trustGate, registry, controller, worker, factory };
}

describe("LiveUiController", () => {
  it("does not spawn when the trust gate denies execution", () => {
    const { controller, worker } = setup(false);
    const mounted = controller.mount({ key: "b1", entryPath: "/x.js", props: props(), host: grant(), width: 30, height: 6 });
    expect(mounted).toBe(false);
    expect(worker.posted).toHaveLength(0);
    expect(controller.status("b1")).toBeUndefined();
  });

  it("mounts, sends the initial size on ready, and composites rendered frames", () => {
    const { trustGate, controller, worker } = setup();
    // Route the spawn through a fake worker so no real thread is created.
    trustGate.spawnHost = ((options, cbs) => {
      const host = new LiveUiHost(options, cbs, () => worker);
      (trustGate as unknown as { hosts: Map<string, unknown> }).hosts.set(options.props.contributionId, host);
      host.spawn();
      return host;
    }) as typeof trustGate.spawnHost;

    controller.mount({ key: "b1", entryPath: "/x.js", props: props(), host: grant(), width: 30, height: 6, title: "Review" });
    worker.emit("message", { type: "ready", instance: instance() });
    expect(worker.posted.some((m) => (m as { type?: string }).type === "mount")).toBe(true);

    worker.emit("message", { type: "rendered", frame: frameOf("hello world") });
    const frame = controller.frame("b1", theme);
    expect(frame).toBeDefined();
    expect(stripAnsi((frame ?? []).join("\n"))).toContain("hello world");
    expect(controller.status("b1")).toBe("ready");
  });

  it("renders a crash-fallback frame on worker error", () => {
    const { controller, worker } = setupWithRealHost();
    worker.emit("message", { type: "ready", instance: instance() });
    worker.emit("error", new Error("boom"));
    expect(controller.status("b1")).toBe("error");
    const frame = controller.frame("b1", theme);
    expect(stripAnsi((frame ?? []).join("\n"))).toContain("crashed");
  });

  it("routes notify host commands to the callback", () => {
    const onNotify = vi.fn();
    const { worker } = setupWithRealHost({ onNotify });
    worker.emit("message", { type: "ready", instance: instance() });
    worker.emit("message", { type: "host_command", command: { type: "notify", message: "hi", level: "info" } });
    expect(onNotify).toHaveBeenCalledWith("hi", "info", "review-pack");
  });

  it("disposes tracked instances and terminates the worker", async () => {
    const { controller, worker, registry } = setupWithRealHost();
    worker.emit("message", { type: "ready", instance: instance() });
    expect(registry.size).toBe(1);
    await controller.disposeAll();
    expect(worker.terminated).toBe(1);
    expect(registry.size).toBe(0);
  });

  it("notifies onFocusChange when the instance gains or loses focus", () => {
    const onFocusChange = vi.fn();
    const { controller, worker } = setupWithRealHost({ onFocusChange });
    worker.emit("message", { type: "ready", instance: instance() });
    controller.focus("b1");
    expect(onFocusChange).toHaveBeenCalled();
    const focusArg = onFocusChange.mock.calls[onFocusChange.mock.calls.length - 1]![0];
    expect(focusArg).toMatchObject({ extensionId: "review-pack", contributionId: "review-panel" });
    expect(focusArg.permissions.ui).toContain("render");
  });

  it("notifies onUnhandledInput when the child returns handled: false", () => {
    const onUnhandledInput = vi.fn();
    const { controller, worker } = setupWithRealHost({ onUnhandledInput });
    worker.emit("message", { type: "ready", instance: instance() });
    controller.focus("b1");
    controller.sendInput({ name: "down" });
    worker.emit("message", { type: "handled_input", handled: false });
    expect(onUnhandledInput).toHaveBeenCalledWith({ name: "down" });
  });

  it("returns false from scrollFocused when no live UI is focused", () => {
    const { controller } = setupWithRealHost();
    expect(controller.scrollFocused(3)).toBe(false);
  });

  it("scrolls the focused instance, clamps the offset, and sends a viewport message", () => {
    const { controller, worker } = setupWithRealHost();
    worker.emit("message", { type: "ready", instance: instance() });
    controller.focus("b1");
    worker.emit("message", {
      type: "rendered",
      frame: { width: 30, height: 6, lines: Array.from({ length: 6 }, (_, i) => [{ text: `line-${i}` }]) },
      scrollHeight: 20
    });

    expect(controller.scrollFocused(5)).toBe(true);
    expect(worker.posted).toContainEqual({ type: "viewport", scrollOffset: 5, viewportHeight: 6 });

    // Clamped to maxScroll = scrollHeight - viewportHeight = 14.
    expect(controller.scrollFocused(20)).toBe(true);
    expect(worker.posted).toContainEqual({ type: "viewport", scrollOffset: 14, viewportHeight: 6 });
  });

  it("composites frames with the tracked scrollOffset", () => {
    const { controller, worker } = setupWithRealHost();
    worker.emit("message", { type: "ready", instance: instance() });
    controller.focus("b1");
    worker.emit("message", {
      type: "rendered",
      frame: { width: 30, height: 6, lines: Array.from({ length: 10 }, (_, i) => [{ text: `row-${i}` }]) },
      scrollHeight: 10
    });
    controller.scrollFocused(3);
    const frame = controller.frame("b1", theme);
    const text = stripAnsi((frame ?? []).join("\n"));
    expect(text).toContain("row-3");
    expect(text).not.toContain("row-0");
  });
});

function setupWithRealHost(callbacks = {}) {
  const base = setup(true, callbacks);
  const { trustGate, worker, controller } = base;
  trustGate.spawnHost = ((options, cbs) => {
    const host = new LiveUiHost(options, cbs, () => worker);
    (trustGate as unknown as { hosts: Map<string, unknown> }).hosts.set(options.props.contributionId, host);
    host.spawn();
    return host;
  }) as typeof trustGate.spawnHost;
  controller.mount({ key: "b1", entryPath: "/x.js", props: props(), host: grant(), width: 30, height: 6, title: "Review" });
  return base;
}
