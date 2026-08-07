import { describe, expect, it, vi } from "vitest";
import {
  buildLiveUiWorkerData,
  buildLiveUiWorkerOptions,
  LiveUiHost,
  type LiveUiHostCallbacks,
  type LiveUiHostConfig,
  type LiveUiSpawnOptions,
  type LiveUiTimers,
  type LiveUiWorkerLike,
  type LiveUiWorkerSpec
} from "../bridge/live-ui-host.js";
import type { CrewCoderLiveUiHost, CrewCoderLiveUiInstance, CrewCoderLiveUiProps, LiveUiFrame } from "../bridge/live-ui-protocol.js";

class FakeWorker implements LiveUiWorkerLike {
  posted: unknown[] = [];
  terminated = 0;
  private listeners: Map<string, ((value: unknown) => void)[]> = new Map();

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  on(event: string, listener: (value: unknown) => void): this {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return this;
  }

  terminate(): Promise<number> {
    this.terminated += 1;
    return Promise.resolve(0);
  }

  emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function makeProps(): CrewCoderLiveUiProps {
  return {
    extensionId: "review-pack",
    contributionId: "review-panel",
    surface: "modal",
    slot: "extension-ui",
    event: { type: "extension_ui_request", uiKind: "component" }
  };
}

function makeHost(overrides: Partial<CrewCoderLiveUiHost> = {}): CrewCoderLiveUiHost {
  return {
    protocolVersion: "0.1",
    transport: "worker-postmessage",
    permissions: { ui: ["render", "input", "focus"], commands: ["ui_response"], storage: "session" },
    limits: { maxRenderLines: 3, maxLineLength: 5, maxPayloadBytes: 1000 },
    ...overrides
  };
}

function makeInstance(overrides: Partial<CrewCoderLiveUiInstance> = {}): CrewCoderLiveUiInstance {
  return {
    instanceId: "i",
    extensionId: "review-pack",
    contributionId: "review-panel",
    surface: "modal" as const,
    canReceiveInput: true,
    focusInfo: { instanceId: "i", extensionId: "review-pack", contributionId: "review-panel", title: "review-pack/review-panel" },
    ...overrides
  };
}

function makeFrame(overrides: Partial<LiveUiFrame> = {}): LiveUiFrame {
  return {
    width: 3,
    height: 2,
    lines: [[{ text: "abc" }], [{ text: "def" }]],
    ...overrides
  };
}

class FakeTimers implements LiveUiTimers {
  private handlers = new Map<number, () => void>();
  private nextId = 1;

  setTimeout(handler: () => void): unknown {
    const id = this.nextId++;
    this.handlers.set(id, handler);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.handlers.delete(handle as number);
  }

  get pending(): number {
    return this.handlers.size;
  }

  fireAll(): void {
    for (const [id, handler] of [...this.handlers]) {
      this.handlers.delete(id);
      handler();
    }
  }
}

function setup(
  options: Partial<LiveUiSpawnOptions> = {},
  callbacks: LiveUiHostCallbacks = {},
  config: Partial<LiveUiHostConfig> = {}
) {
  const worker = new FakeWorker();
  let spec: LiveUiWorkerSpec | undefined;
  const factory = (received: LiveUiWorkerSpec): LiveUiWorkerLike => {
    spec = received;
    return worker;
  };
  const spawnOptions: LiveUiSpawnOptions = {
    entryPath: "/ext/review-pack/ui/review-panel.js",
    props: makeProps(),
    host: makeHost(),
    ...options
  };
  const host = new LiveUiHost(spawnOptions, callbacks, factory, config);
  host.spawn();
  return { host, worker, getSpec: () => spec };
}

describe("LiveUiHost lifecycle", () => {
  it("posts a serializable init message on spawn", () => {
    const { worker } = setup();
    expect(worker.posted[0]).toEqual({ type: "init", props: makeProps(), host: makeHost() });
    // init payload must be structured-clone safe (no functions)
    expect(() => structuredClone(worker.posted[0])).not.toThrow();
  });

  it("does not spawn a second worker when already running", () => {
    const { host, getSpec } = setup();
    const first = getSpec();
    host.spawn();
    expect(getSpec()).toBe(first);
  });

  it("tracks the child instance once it reports ready", () => {
    const onReady = vi.fn();
    const { host, worker } = setup({}, { onReady });
    expect(host.ready).toBe(false);
    const instance = makeInstance({
      instanceId: "i1",
      focusInfo: { instanceId: "i1", extensionId: "review-pack", contributionId: "review-panel", title: "review-pack/review-panel" }
    });
    worker.emit("message", { type: "ready", instance });
    expect(host.ready).toBe(true);
    expect(host.activeInstance).toEqual(instance);
    expect(onReady).toHaveBeenCalledWith(instance);
  });

  it("clamps rendered frames to the negotiated limits", () => {
    const onRendered = vi.fn();
    const { worker } = setup({}, { onRendered });
    const frame = makeFrame({
      width: 10,
      height: 10,
      lines: [
        [{ text: "abcdefg" }], [{ text: "bbbbb" }],
        [{ text: "c" }], [{ text: "ddddd" }]
      ]
    });
    worker.emit("message", { type: "rendered", frame });
    expect(onRendered).toHaveBeenCalledTimes(1);
    const received = onRendered.mock.calls[0][0] as LiveUiFrame;
    expect(received.width).toBe(5);
    expect(received.height).toBe(3);
    expect(received.lines.length).toBe(3);
  });
});

describe("LiveUiHost outbound gating", () => {
  it("only mounts after the child is ready", () => {
    const { host, worker } = setup();
    expect(host.sendMount(80, 24)).toBe(false);
    worker.emit("message", { type: "ready", instance: makeInstance() });
    expect(host.sendMount(80, 24)).toBe(true);
    expect(worker.posted).toContainEqual({ type: "mount", width: 80, height: 24 });
  });

  it("refuses to forward input without the ui input grant", () => {
    const { host, worker } = setup({ host: makeHost({ permissions: { ui: ["render"] } }) });
    worker.emit("message", { type: "ready", instance: makeInstance({ canReceiveInput: false }) });
    host.focus();
    expect(host.sendInput({ name: "return" })).toBe(false);
    expect(worker.posted).not.toContainEqual(expect.objectContaining({ type: "input" }));
  });

  it("sends viewport messages without requiring focus", () => {
    const { host, worker } = setup();
    worker.emit("message", { type: "ready", instance: makeInstance() });
    expect(host.sendViewport(5, 10)).toBe(true);
    expect(worker.posted).toContainEqual({ type: "viewport", scrollOffset: 5, viewportHeight: 10 });
  });

  it("passes scrollHeight through to onRendered", () => {
    const onRendered = vi.fn();
    const { worker } = setup({}, { onRendered });
    worker.emit("message", { type: "ready", instance: makeInstance() });
    worker.emit("message", { type: "rendered", frame: makeFrame(), scrollHeight: 50 });
    expect(onRendered).toHaveBeenCalledWith(expect.anything(), 50);
  });

  it("only forwards input after the instance is focused", () => {
    const onFocusChange = vi.fn();
    const { host, worker } = setup({}, { onFocusChange });
    worker.emit("message", { type: "ready", instance: makeInstance() });
    expect(host.sendInput({ name: "return" })).toBe(false);
    expect(host.focus()).toBe(true);
    expect(host.focusInfo).toEqual(makeInstance().focusInfo);
    expect(onFocusChange).toHaveBeenCalledWith(makeInstance().focusInfo);
    expect(worker.posted).toContainEqual({ type: "focus", focusInfo: makeInstance().focusInfo });
    expect(host.sendInput({ name: "return" })).toBe(true);
    expect(worker.posted).toContainEqual({ type: "input", event: { name: "return" } });
  });

  it("does not forward reserved global shortcuts", () => {
    const { host, worker } = setup();
    worker.emit("message", { type: "ready", instance: makeInstance() });
    host.focus();
    expect(host.sendInput({ name: "escape" })).toBe(false);
    expect(worker.posted).not.toContainEqual({ type: "input", event: { name: "escape" } });
  });

  it("reports unhandled child input for TUI fallthrough", () => {
    const onInputHandled = vi.fn();
    const onUnhandledInput = vi.fn();
    const { host, worker } = setup({}, { onInputHandled, onUnhandledInput });
    worker.emit("message", { type: "ready", instance: makeInstance() });
    host.focus();
    host.sendInput({ name: "tab" });
    worker.emit("message", { type: "handled_input", handled: false });
    expect(onInputHandled).toHaveBeenCalledWith({ name: "tab" }, false);
    expect(onUnhandledInput).toHaveBeenCalledWith({ name: "tab" });
  });
});

describe("LiveUiHost capability enforcement", () => {
  it("forwards granted host commands", () => {
    const onHostCommand = vi.fn();
    const { worker } = setup({}, { onHostCommand });
    worker.emit("message", { type: "host_command", command: { type: "resolve_ui_request", requestId: "r", value: true } });
    expect(onHostCommand).toHaveBeenCalledWith({ type: "resolve_ui_request", requestId: "r", value: true });
  });

  it("drops ungranted host commands and reports an error", () => {
    const onHostCommand = vi.fn();
    const onError = vi.fn();
    const { worker } = setup({ host: makeHost({ permissions: { ui: ["render"] } }) }, { onHostCommand, onError });
    worker.emit("message", { type: "host_command", command: { type: "write_session_state", key: "k", value: 1 } });
    expect(onHostCommand).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("write_session_state"));
  });
});

describe("LiveUiHost lifecycle tracking", () => {
  it("advances the lifecycle phase and reports transitions", () => {
    const onLifecycle = vi.fn();
    const { host, worker } = setup({}, { onLifecycle });
    expect(host.lifecyclePhase).toBe("spawning");
    worker.emit("message", { type: "ready", instance: makeInstance() });
    expect(host.lifecyclePhase).toBe("ready");
    host.sendMount(80, 24);
    expect(host.lifecyclePhase).toBe("mounted");
    const phases = onLifecycle.mock.calls.map((call) => call[0]);
    expect(phases).toEqual(["spawning", "ready", "mounted"]);
  });

  it("exposes registry identity and marks disposed", async () => {
    const { host, worker } = setup();
    worker.emit("message", { type: "ready", instance: makeInstance() });
    expect(host.extensionId).toBe("review-pack");
    expect(host.contributionId).toBe("review-panel");
    expect(host.surface).toBe("modal");
    await host.dispose();
    expect(host.lifecyclePhase).toBe("disposed");
  });
});

describe("LiveUiHost render timeouts and backpressure", () => {
  it("fires onRenderTimeout when a render request goes unanswered", () => {
    const timers = new FakeTimers();
    const onRenderTimeout = vi.fn();
    const { host, worker } = setup({}, { onRenderTimeout }, { timers, renderTimeoutMs: 50 });
    worker.emit("message", { type: "ready", instance: makeInstance() });
    host.sendMount(80, 24);
    expect(timers.pending).toBe(1);
    timers.fireAll();
    expect(onRenderTimeout).toHaveBeenCalledWith({ type: "mount", width: 80, height: 24 });
  });

  it("hard-stops the worker on timeout when configured", () => {
    const timers = new FakeTimers();
    const { host, worker } = setup({}, {}, { timers, disposeOnTimeout: true });
    worker.emit("message", { type: "ready", instance: makeInstance() });
    host.sendMount(80, 24);
    timers.fireAll();
    expect(worker.terminated).toBe(1);
  });

  it("keeps only one render request in flight and drains on reply", () => {
    const timers = new FakeTimers();
    const { host, worker } = setup({}, {}, { timers });
    worker.emit("message", { type: "ready", instance: makeInstance() });
    host.sendMount(80, 24);
    host.sendResize(60, 20);
    host.sendUpdate(makeProps());
    // Only the mount is on the wire; resize+update are queued behind it.
    const renders = worker.posted.filter((m) => ["mount", "resize", "update"].includes((m as { type: string }).type));
    expect(renders).toEqual([{ type: "mount", width: 80, height: 24 }]);
    expect(host.pendingRenderCount).toBe(3);
    worker.emit("message", { type: "rendered", frame: makeFrame() });
    worker.emit("message", { type: "rendered", frame: makeFrame() });
    const renders2 = worker.posted.filter((m) => ["mount", "resize", "update"].includes((m as { type: string }).type));
    expect(renders2).toEqual([
      { type: "mount", width: 80, height: 24 },
      { type: "resize", width: 60, height: 20 },
      { type: "update", props: makeProps() }
    ]);
  });

  it("coalesces consecutive resize requests and caps the queue", () => {
    const timers = new FakeTimers();
    const onBackpressureDrop = vi.fn();
    const { host, worker } = setup({}, { onBackpressureDrop }, { timers, maxPendingRenders: 2 });
    worker.emit("message", { type: "ready", instance: makeInstance() });
    host.sendMount(80, 24); // goes in flight
    host.sendResize(10, 10);
    host.sendResize(20, 20); // coalesced with previous resize -> queue depth stays 1
    expect(host.pendingRenderCount).toBe(2);
    host.sendUpdate(makeProps()); // queue now [resize(20,20), update] == cap 2, no drop
    expect(onBackpressureDrop).not.toHaveBeenCalled();
    host.sendResize(30, 30); // over cap -> drop oldest queued (the coalesced resize)
    expect(onBackpressureDrop).toHaveBeenCalledWith({ type: "resize", width: 20, height: 20 });
  });
});

describe("LiveUiHost teardown", () => {
  it("sends dispose then terminates, and is idempotent", async () => {
    const { host, worker } = setup();
    await host.dispose();
    expect(worker.posted).toContainEqual({ type: "dispose" });
    expect(worker.terminated).toBe(1);
    await host.dispose();
    expect(worker.terminated).toBe(1);
  });
});

describe("live UI worker isolation helpers", () => {
  it("hands the worker only serializable props and host, no env", () => {
    const data = buildLiveUiWorkerData({ entryPath: "/x", props: makeProps(), host: makeHost() });
    expect(data).toEqual({ props: makeProps(), host: makeHost() });
    expect(Object.keys(data)).toEqual(["props", "host"]);
  });

  it("starves the worker of the parent environment", () => {
    const options = buildLiveUiWorkerOptions({ props: makeProps(), host: makeHost() });
    expect(options.env).toEqual({});
    expect(options.workerData).toEqual({ props: makeProps(), host: makeHost() });
  });
});
