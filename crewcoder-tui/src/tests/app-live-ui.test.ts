import { describe, expect, it } from "vitest";
import { App } from "../components/App.js";
import { createInitialState } from "../state/tui-store.js";
import { LiveUiHost, type LiveUiHostCallbacks, type LiveUiSpawnOptions, type LiveUiWorkerLike } from "../bridge/live-ui-host.js";
import { crewCoderTheme } from "../theme/theme.js";
import { stripAnsi } from "../tui/ansi.js";
import type { SessionRecord } from "../bridge/crewcoder-process.js";
import type { CrewCoderLiveUiHost, LiveUiFrame } from "../bridge/live-ui-protocol.js";

function host(): CrewCoderLiveUiHost {
  return {
    protocolVersion: "0.1",
    transport: "worker-postmessage",
    permissions: { ui: ["render", "input"] },
    limits: { maxRenderLines: 50, maxLineLength: 200, maxPayloadBytes: 64 * 1024 }
  };
}

describe("App live UI integration", () => {
  it("initialises the live UI controller, trust gate, registry, and scheduler", () => {
    const state = createInitialState();
    const app = new App(state);
    expect(app.liveUiController).toBeDefined();
    expect(app["liveUiTrustGate"]).toBeDefined();
    expect(app["liveUiRegistry"]).toBeDefined();
    expect(app["liveUiScheduler"]).toBeDefined();
  });

  it("sets allowExtensionLiveUi on state and trust gate when config is loaded", () => {
    const state = createInitialState();
    expect(state.allowExtensionLiveUi).toBe(false);
    const app = new App(state);
    expect(app["liveUiTrustGate"].allowed).toBe(false);
    app["applyReloadedConfig"]({ allowExtensionLiveUi: true });
    expect(state.allowExtensionLiveUi).toBe(true);
    expect(app["liveUiTrustGate"].allowed).toBe(true);
  });

  it("renders live_ui block frames from state.liveUiFrames in the viewport", () => {
    const state = createInitialState();
    state.blocks.push({ type: "user", text: "test" }); // force conversation view
    state.blocks.push({
      type: "live_ui",
      key: "test-key",
      extensionId: "test-ext",
      contributionId: "test-panel",
      surface: "transcript",
      status: "ready",
      title: "Test Panel"
    });
    state.liveUiFrames = new Map();
    state.liveUiFrames.set("test-key", ["frame line one", "frame line two"]);
    const app = new App(state);
    const ctx = { size: { width: 80, height: 24 }, theme: crewCoderTheme, imagePlacements: [] };
    const rendered = app.render(ctx);
    const text = stripAnsi(rendered.join("\n"));
    expect(text).toContain("frame line one");
    expect(text).toContain("frame line two");
  });

  it("renders crash-fallback for error/exited live_ui blocks", () => {
    const state = createInitialState();
    state.blocks.push({ type: "user", text: "test" }); // force conversation view
    state.blocks.push({
      type: "live_ui",
      key: "err-key",
      extensionId: "test-ext",
      contributionId: "broken",
      surface: "modal",
      status: "error",
      title: "Broken Panel"
    });
    state.liveUiFrames = new Map();
    const app = new App(state);
    const ctx = { size: { width: 80, height: 24 }, theme: crewCoderTheme, imagePlacements: [] };
    const rendered = app.render(ctx);
    const text = stripAnsi(rendered.join("\n"));
    expect(text).toContain("crashed");
    expect(text).toContain("test-ext");
  });

  it("shows loading placeholder when live_ui has no rendered frame", () => {
    const state = createInitialState();
    state.blocks.push({ type: "user", text: "test" }); // force conversation view
    state.blocks.push({
      type: "live_ui",
      key: "loading-key",
      extensionId: "test-ext",
      contributionId: "loading",
      surface: "transcript",
      status: "loading",
      title: "Loading Panel"
    });
    const app = new App(state);
    const ctx = { size: { width: 80, height: 24 }, theme: crewCoderTheme, imagePlacements: [] };
    const rendered = app.render(ctx);
    const text = stripAnsi(rendered.join("\n"));
    expect(text).toContain("Live UI loading");
    expect(text).toContain("test-ext/loading");
  });

  it("routes keyboard input through the live UI controller", () => {
    const state = createInitialState();
    const app = new App(state);
    const worker = createFakeWorker();
    setupMockSpawn(app, worker);
    const mountResult = app.liveUiController.mount({
      key: "inp-test",
      entryPath: "/x.js",
      props: { extensionId: "test-ext", contributionId: "inp-panel", surface: "modal", event: { type: "x" } },
      host: host(),
      width: 40,
      height: 8
    });
    expect(mountResult).toBe(true);
    worker.emit("message", {
      type: "ready",
      instance: { instanceId: "i1", extensionId: "test-ext", contributionId: "inp-panel", surface: "modal", canReceiveInput: true, focusInfo: { instanceId: "i1", extensionId: "test-ext", contributionId: "inp-panel", title: "test-ext/inp-panel" } }
    });
    app.liveUiController.focus("inp-test");
    const handled = app.handleInput({ name: "return", sequence: "\r", ctrl: false, meta: false, shift: false });
    expect(handled).toBe(true);
    const posted = worker.posted as Array<{ type?: string; event?: { name: string } }>;
    expect(posted.some((m) => m.type === "input" && m.event?.name === "return")).toBe(true);
  });

  it("disposes all live UI components when resuming a session", () => {
    const state = createInitialState();
    state.sessionId = "s1";
    const app = new App(state);
    const worker = createFakeWorker();
    setupMockSpawn(app, worker);
    const mountResult = app.liveUiController.mount({
      key: "dispose-test",
      entryPath: "/x.js",
      props: { extensionId: "test-ext", contributionId: "dispose-panel", surface: "transcript", event: { type: "x" } },
      host: host(),
      width: 30,
      height: 6
    });
    expect(mountResult).toBe(true);
    worker.emit("message", {
      type: "ready",
      instance: { instanceId: "i2", extensionId: "test-ext", contributionId: "dispose-panel", surface: "transcript", canReceiveInput: false, focusInfo: { instanceId: "i2", extensionId: "test-ext", contributionId: "dispose-panel", title: "test-ext/dispose-panel" } }
    });
    expect(app["liveUiRegistry"].size).toBe(1);
    const session: SessionRecord = { id: "s2", startedAt: new Date().toISOString(), cwd: "/x", requestedMode: "auto", resolvedMode: "auto", prompt: "hi" };
    app["resumeSelectedSession"](session);
    expect(app["liveUiRegistry"].size).toBe(0);
    expect(worker.terminated).toBe(1);
  });

  it("loads live UI contributions and stores them in state", async () => {
    const state = createInitialState();
    // Simulate a contributions list that would come from crewcoder extension live-ui --json
    state.liveUiContributions = [{
      extensionId: "review-pack",
      id: "review-panel",
      title: "Review Panel",
      surface: "modal",
      slot: "extension-ui",
      entry: "/ext/review-pack/ui/review-panel.js",
      experimental: true,
      permissions: { ui: ["render", "input", "focus"] },
      allowed: true,
      blockedReasons: [],
      enabled: true,
      trusted: true
    }];
    const app = new App(state);
    expect(state.liveUiContributions).toBeDefined();
    expect(state.liveUiContributions!.length).toBe(1);
    expect(state.liveUiContributions![0].allowed).toBe(true);
  });

  it("mounts a live UI component when an extension_ui_request matches a contribution", () => {
    const state = createInitialState();
    state.allowExtensionLiveUi = true;
    state.liveUiContributions = [{
      extensionId: "review-pack",
      id: "review-panel",
      title: "Review Panel",
      surface: "modal",
      slot: "extension-ui",
      entry: "/ext/review-pack/ui/review-panel.js",
      experimental: true,
      permissions: { ui: ["render", "input", "focus"] },
      allowed: true,
      blockedReasons: [],
      enabled: true,
      trusted: true
    }];
    state.blocks.push({ type: "user", text: "test" });
    const app = new App(state);
    app["liveUiTrustGate"].allowed = true;
    const worker = createFakeWorker();
    setupMockSpawn(app, worker);
    // Simulate extension_ui_request event
    app["handleCrewCoderEvent"]({
      type: "extension_ui_request",
      requestId: "req-1",
      extensionId: "review-pack",
      uiKind: "component",
      title: "Review changes"
    });
    // Should have created a live_ui block
    const liveBlock = state.blocks.find((b) => b.type === "live_ui");
    expect(liveBlock).toBeDefined();
    expect(liveBlock!.type === "live_ui" ? liveBlock!.extensionId : "").toBe("review-pack");
    // Ready the worker - mount is automatically posted by onReady callback
    worker.emit("message", {
      type: "ready",
      instance: { instanceId: "i1", extensionId: "review-pack", contributionId: "review-panel", surface: "modal", canReceiveInput: true, focusInfo: { instanceId: "i1", extensionId: "review-pack", contributionId: "review-panel", title: "review-pack/review-panel" } }
    });
    // Worker responds to mount with a rendered frame (needs enough rows for compositing: borders + title + content)
    worker.emit("message", {
      type: "rendered",
      frame: { width: 40, height: 4, lines: [[{ text: "REVIEW FRAME LINE 1" }], [{ text: "REVIEW FRAME LINE 2" }], [{ text: "" }], [{ text: "" }]] }
    });
    // Render populates state.liveUiFrames from controller.frame()
    const ctx = { size: { width: 80, height: 24 }, theme: crewCoderTheme, imagePlacements: [] };
    app.render(ctx);
    const frame = state.liveUiFrames?.get("liveui:req-1");
    expect(frame).toBeDefined();
    expect(frame!.join("")).toContain("REVIEW FRAME LINE 1");
  });

  it("keeps transcript contributions tool-anchored instead of mounting them for generic extension requests", () => {
    const state = createInitialState();
    state.allowExtensionLiveUi = true;
    state.liveUiContributions = [{
      extensionId: "review-pack",
      id: "inline-review",
      title: "Inline Review",
      surface: "transcript",
      entry: "/ext/review-pack/ui/inline-review.js",
      experimental: true,
      permissions: { ui: ["render"] },
      allowed: true,
      blockedReasons: [],
      enabled: true,
      trusted: true
    }];
    state.blocks.push({ type: "user", text: "test" });
    const app = new App(state);
    app["liveUiTrustGate"].allowed = true;
    const worker = createFakeWorker();
    setupMockSpawn(app, worker);

    app["handleCrewCoderEvent"]({
      type: "extension_ui_request",
      requestId: "generic-transcript",
      extensionId: "review-pack",
      uiKind: "component",
      title: "Review changes"
    });

    expect(state.blocks.some((block) => block.type === "extension_ui")).toBe(true);
    expect(state.blocks.some((block) => block.type === "live_ui")).toBe(false);
    expect(app["liveUiRegistry"].size).toBe(0);
    expect(app["activePopover"]?.kind).toBe("extension_ui");
  });

  it("does not mount when no matching contribution exists", () => {
    const state = createInitialState();
    state.liveUiContributions = [];
    state.blocks.push({ type: "user", text: "test" });
    const app = new App(state);
    const liveCountBefore = state.blocks.filter((b) => b.type === "live_ui").length;
    app["handleCrewCoderEvent"]({
      type: "extension_ui_request",
      requestId: "req-2",
      extensionId: "unknown-ext",
      uiKind: "component",
      title: "Nothing"
    });
    expect(state.blocks.filter((b) => b.type === "live_ui").length).toBe(liveCountBefore);
  });

  it("disposes the live UI block on extension_ui_resolved", () => {
    const state = createInitialState();
    state.allowExtensionLiveUi = true;
    state.liveUiContributions = [{
      extensionId: "review-pack",
      id: "review-panel",
      title: "Review Panel",
      surface: "modal",
      slot: "extension-ui",
      entry: "/ext/review-pack/ui/review-panel.js",
      experimental: true,
      permissions: { ui: ["render"] },
      allowed: true,
      blockedReasons: [],
      enabled: true,
      trusted: true
    }];
    state.blocks.push({ type: "user", text: "test" });
    const app = new App(state);
    app["liveUiTrustGate"].allowed = true;
    const worker = createFakeWorker();
    setupMockSpawn(app, worker);
    // Mount via event
    app["handleCrewCoderEvent"]({
      type: "extension_ui_request",
      requestId: "req-dispose",
      extensionId: "review-pack",
      uiKind: "component",
      title: "Disposables"
    });
    expect(state.blocks.some((b) => b.type === "live_ui")).toBe(true);
    expect(app["liveUiRegistry"].size).toBe(1);
    // Resolve the request
    app["handleCrewCoderEvent"]({
      type: "extension_ui_resolved",
      requestId: "req-dispose",
      cancelled: false
    });
    expect(state.blocks.some((b) => b.type === "live_ui" && (b as { key: string }).key === "liveui:req-dispose")).toBe(false);
    expect(app["liveUiRegistry"].size).toBe(0);
  });

  it("updates state.liveUiFocus when a live UI instance gains focus", () => {
    const state = createInitialState();
    state.allowExtensionLiveUi = true;
    state.liveUiContributions = [{
      extensionId: "review-pack",
      id: "review-panel",
      title: "Review Panel",
      surface: "modal",
      entry: "/ext/review-pack/ui/review-panel.js",
      experimental: true,
      permissions: { ui: ["render", "input", "focus"] },
      allowed: true,
      blockedReasons: [],
      enabled: true,
      trusted: true
    }];
    state.blocks.push({ type: "user", text: "test" });
    const app = new App(state);
    app["liveUiTrustGate"].allowed = true;
    const worker = createFakeWorker();
    setupMockSpawn(app, worker);

    app["handleCrewCoderEvent"]({
      type: "extension_ui_request",
      requestId: "focus-req",
      extensionId: "review-pack",
      uiKind: "component",
      title: "Focus Test"
    });
    worker.emit("message", {
      type: "ready",
      instance: { instanceId: "fi", extensionId: "review-pack", contributionId: "review-panel", surface: "modal", canReceiveInput: true, focusInfo: { instanceId: "fi", extensionId: "review-pack", contributionId: "review-panel", title: "review-pack/review-panel" } }
    });
    app.liveUiController.focus("liveui:focus-req");
    expect(state.liveUiFocus).toBeDefined();
    expect(state.liveUiFocus!.extensionId).toBe("review-pack");
    expect(state.liveUiFocus!.permissions.ui).toContain("input");
  });

  it("forwards mouse events to the focused live UI host with frame-relative coordinates", () => {
    const state = createInitialState();
    state.allowExtensionLiveUi = true;
    state.liveUiContributions = [{
      extensionId: "review-pack",
      id: "review-panel",
      title: "Review Panel",
      surface: "modal",
      entry: "/ext/review-pack/ui/review-panel.js",
      experimental: true,
      permissions: { ui: ["render", "input"] },
      allowed: true,
      blockedReasons: [],
      enabled: true,
      trusted: true
    }];
    state.blocks.push({ type: "user", text: "test" });
    const app = new App(state);
    app["liveUiTrustGate"].allowed = true;
    const worker = createFakeWorker();
    setupMockSpawn(app, worker);

    app["handleCrewCoderEvent"]({
      type: "extension_ui_request",
      requestId: "mouse-req",
      extensionId: "review-pack",
      uiKind: "component",
      title: "Mouse Test"
    });
    worker.emit("message", {
      type: "ready",
      instance: { instanceId: "mi", extensionId: "review-pack", contributionId: "review-panel", surface: "modal", canReceiveInput: true, focusInfo: { instanceId: "mi", extensionId: "review-pack", contributionId: "review-panel", title: "review-pack/review-panel" } }
    });
    app.liveUiController.focus("liveui:mouse-req");

    app.handleInput({ name: "mouse", sequence: "", ctrl: false, meta: false, shift: false, mouse: { x: 5, y: 3, button: 0, kind: "press" } });

    const posted = worker.posted as Array<{ type?: string; event?: { mouse?: { x: number; y: number } } }>;
    const inputMessages = posted.filter((m) => m.type === "input");
    expect(inputMessages.length).toBeGreaterThan(0);
    const lastInput = inputMessages[inputMessages.length - 1];
    expect(lastInput?.event?.mouse?.x).toBe(4);
    expect(lastInput?.event?.mouse?.y).toBe(2);
  });

  it("end-to-end: contribution, mount, render, input, and dispose via events", () => {
    const state = createInitialState();
    state.allowExtensionLiveUi = true;
    state.liveUiContributions = [{
      extensionId: "review-pack",
      id: "review-panel",
      title: "Review Panel",
      surface: "modal",
      entry: "/ext/review-pack/ui/review-panel.js",
      experimental: true,
      permissions: { ui: ["render", "input"] },
      allowed: true,
      blockedReasons: [],
      enabled: true,
      trusted: true
    }];
    state.blocks.push({ type: "user", text: "test" });
    const app = new App(state);
    app["liveUiTrustGate"].allowed = true;
    const worker = createFakeWorker();
    setupMockSpawn(app, worker);

    // 1. extension_ui_request triggers mount
    app["handleCrewCoderEvent"]({
      type: "extension_ui_request",
      requestId: "e2e-req",
      extensionId: "review-pack",
      uiKind: "component",
      title: "End-to-End"
    });
    const liveBlock = state.blocks.find((b) => b.type === "live_ui");
    expect(liveBlock).toBeDefined();

    // 2. Worker sends ready, then rendered frame (needs enough rows for compositing: borders + title + content)
    worker.emit("message", {
      type: "ready",
      instance: { instanceId: "e2e-i", extensionId: "review-pack", contributionId: "review-panel", surface: "modal", canReceiveInput: true, focusInfo: { instanceId: "e2e-i", extensionId: "review-pack", contributionId: "review-panel", title: "review-pack/review-panel" } }
    });
    worker.emit("message", { type: "rendered", frame: { width: 20, height: 3, lines: [[{ text: "E2E OUTPUT" }], [{ text: "more content" }], [{ text: "footer" }]] } });

    // 3. Render the App - refreshLiveUiFrames populates state.liveUiFrames from controller.frame()
    const ctx = { size: { width: 80, height: 24 }, theme: crewCoderTheme, imagePlacements: [] };
    app.render(ctx);
    const frame = state.liveUiFrames?.get("liveui:e2e-req");
    expect(frame).toBeDefined();
    expect(frame!.join("")).toContain("E2E OUTPUT");

    // 4. Focus and send input
    app.liveUiController.focus("liveui:e2e-req");
    const handled = app.handleInput({ name: "return", sequence: "\r", ctrl: false, meta: false, shift: false });
    expect(handled).toBe(true);
    const posted = worker.posted as Array<{ type?: string; event?: { name: string } }>;
    expect(posted.some((m) => m.type === "input")).toBe(true);

    // 5. extension_ui_resolved triggers dispose
    app["handleCrewCoderEvent"]({ type: "extension_ui_resolved", requestId: "e2e-req", cancelled: false });
    expect(state.blocks.some((b) => b.type === "live_ui" && (b as { key: string }).key === "liveui:e2e-req")).toBe(false);
  });

  it("keeps a blank row between the transcript viewport and composer", () => {
    const state = createInitialState();
    state.blocks.push({ type: "system", text: "Ready" });
    const app = new App(state);

    const rendered = app.render({ size: { width: 80, height: 24 }, theme: crewCoderTheme, imagePlacements: [] });
    const composerTop = app["composerTop"];

    expect(stripAnsi(rendered[composerTop - 2] ?? "").trim()).toBe("");
    expect(stripAnsi(rendered[composerTop - 1] ?? "")).toContain("▔");
  });

  it("mounts a transcript live UI block after a matching tool_execution_end", async () => {
    const state = createInitialState();
    state.allowExtensionLiveUi = true;
    state.liveUiContributions = [{
      extensionId: "render-pack",
      id: "bash-viewer",
      title: "Bash Viewer",
      surface: "transcript",
      entry: "/ext/render-pack/ui/bash-viewer.js",
      experimental: true,
      permissions: { ui: ["render"] },
      match: { toolNames: ["bash"] },
      allowed: true,
      blockedReasons: [],
      enabled: true,
      trusted: true
    }];
    state.blocks.push({ type: "user", text: "run ls" });
    state.blocks.push({ type: "tool", id: "tc-1", name: "bash", status: "done", args: { command: "ls" }, text: "file.txt" });

    const app = new App(state);
    app["liveUiTrustGate"].allowed = true;
    const worker = createFakeWorker();
    setupMockSpawn(app, worker);

    await app["tryMountLiveUiForToolBlock"]({
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "tc-1",
      isError: false
    });

    const toolIndex = state.blocks.findIndex((b) => b.type === "tool");
    const liveIndex = state.blocks.findIndex((b) => b.type === "live_ui");
    expect(liveIndex).toBe(toolIndex + 1);
    const liveBlock = state.blocks[liveIndex];
    expect(liveBlock?.type === "live_ui" && liveBlock.surface === "transcript").toBe(true);

    worker.emit("message", {
      type: "ready",
      instance: { instanceId: "tc1-i", extensionId: "render-pack", contributionId: "bash-viewer", surface: "transcript", canReceiveInput: false, focusInfo: { instanceId: "tc1-i", extensionId: "render-pack", contributionId: "bash-viewer", title: "render-pack/bash-viewer" } }
    });
    worker.emit("message", { type: "rendered", frame: { width: 80, height: 4, lines: [[{ text: "BASH OUTPUT" }], [{ text: "file.txt" }], [{ text: "" }], [{ text: "" }]] } });

    const ctx = { size: { width: 80, height: 24 }, theme: crewCoderTheme, imagePlacements: [] };
    app.render(ctx);
    const frame = state.liveUiFrames?.get("liveui:tool:tc-1");
    expect(frame).toBeDefined();
    expect(frame!.join("")).toContain("BASH OUTPUT");
  });

  it("does not mount a tool-block renderer when the surface is not transcript", async () => {
    const state = createInitialState();
    state.allowExtensionLiveUi = true;
    state.liveUiContributions = [{
      extensionId: "render-pack",
      id: "bash-modal",
      title: "Bash Modal",
      surface: "modal",
      entry: "/ext/render-pack/ui/bash-modal.js",
      experimental: true,
      permissions: { ui: ["render"] },
      match: { toolNames: ["bash"] },
      allowed: true,
      blockedReasons: [],
      enabled: true,
      trusted: true
    }];
    state.blocks.push({ type: "tool", id: "tc-2", name: "bash", status: "done", text: "" });

    const app = new App(state);
    app["liveUiTrustGate"].allowed = true;
    const worker = createFakeWorker();
    setupMockSpawn(app, worker);

    await app["tryMountLiveUiForToolBlock"]({ type: "tool_execution_end", toolName: "bash", toolCallId: "tc-2", isError: false });
    expect(state.blocks.some((b) => b.type === "live_ui")).toBe(false);
  });

  it("scrolls the focused live UI with wheelup/wheeldown", () => {
    const state = createInitialState();
    state.allowExtensionLiveUi = true;
    state.liveUiContributions = [{
      extensionId: "review-pack",
      id: "review-panel",
      title: "Review Panel",
      surface: "modal",
      entry: "/ext/review-pack/ui/review-panel.js",
      experimental: true,
      permissions: { ui: ["render", "input"] },
      allowed: true,
      blockedReasons: [],
      enabled: true,
      trusted: true
    }];
    state.blocks.push({ type: "user", text: "test" });
    const app = new App(state);
    app["liveUiTrustGate"].allowed = true;
    const worker = createFakeWorker();
    setupMockSpawn(app, worker);

    app["handleCrewCoderEvent"]({
      type: "extension_ui_request",
      requestId: "scroll-req",
      extensionId: "review-pack",
      uiKind: "component",
      title: "Scroll Test"
    });
    worker.emit("message", {
      type: "ready",
      instance: { instanceId: "scroll-i", extensionId: "review-pack", contributionId: "review-panel", surface: "modal", canReceiveInput: true, focusInfo: { instanceId: "scroll-i", extensionId: "review-pack", contributionId: "review-panel", title: "review-pack/review-panel" } }
    });
    worker.emit("message", {
      type: "rendered",
      frame: { width: 40, height: 6, lines: Array.from({ length: 6 }, (_, i) => [{ text: `line-${i}` }]) },
      scrollHeight: 20
    });
    app.liveUiController.focus("liveui:scroll-req");

    const handled = app.handleInput({ name: "wheeldown", sequence: "", ctrl: false, meta: false, shift: false });
    expect(handled).toBe(true);
    // Modal surface size is derived from the screen dimensions, so the viewport height comes from the controller state.
    expect(worker.posted).toContainEqual({ type: "viewport", scrollOffset: 3, viewportHeight: 13 });

    app.handleInput({ name: "wheelup", sequence: "", ctrl: false, meta: false, shift: false });
    expect(worker.posted).toContainEqual({ type: "viewport", scrollOffset: 0, viewportHeight: 13 });
  });
});

function createFakeWorker(): LiveUiWorkerLike & { posted: unknown[]; terminated: number; emit(event: string, value?: unknown): void } {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  return {
    posted: [],
    terminated: 0,
    postMessage(value: unknown): void { (this as unknown as { posted: unknown[] }).posted?.push(value); },
    on(event: string, listener: (value: unknown) => void): unknown {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return this;
    },
    terminate(): Promise<number> { (this as unknown as { terminated: number }).terminated += 1; return Promise.resolve(0); },
    emit(event: string, value?: unknown): void {
      for (const listener of listeners.get(event) ?? []) listener(value);
    }
  };
}

function setupMockSpawn(app: App, worker: LiveUiWorkerLike & { emit(event: string, value?: unknown): void }): void {
  const trustGate = app["liveUiTrustGate"] as unknown as {
    allowed: boolean;
    spawnHost: (options: LiveUiSpawnOptions, cbs?: LiveUiHostCallbacks) => unknown;
    hosts: Map<string, unknown>;
  };
  trustGate.spawnHost = ((options: LiveUiSpawnOptions, cbs?: LiveUiHostCallbacks) => {
    const host = new LiveUiHost(options, cbs, () => worker);
    trustGate.hosts.set(options.props.contributionId, host);
    host.spawn();
    return host;
  }) as typeof trustGate.spawnHost;
}
