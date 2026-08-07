import { describe, expect, it, vi } from "vitest";
import {
  createLiveUiChildState,
  reduceLiveUiChild,
  type LiveUiComponent
} from "../bridge/live-ui-runtime.js";
import type { CrewCoderLiveUiHost, CrewCoderLiveUiProps, LiveUiFrame } from "../bridge/live-ui-protocol.js";

const props: CrewCoderLiveUiProps = {
  extensionId: "review-pack",
  contributionId: "review-panel",
  surface: "modal",
  slot: "extension-ui",
  event: { type: "extension_ui_request", uiKind: "component" }
};

const host: CrewCoderLiveUiHost = {
  protocolVersion: "0.1",
  transport: "worker-postmessage",
  permissions: { ui: ["render", "input"] },
  limits: { maxRenderLines: 2, maxLineLength: 4, maxPayloadBytes: 1000 }
};

function makeTestFrame(text: string): LiveUiFrame {
  return {
    width: 4,
    height: 2,
    lines: text.split("").map((ch) => [{ text: ch }])
  };
}

const component: LiveUiComponent = {
  render: (received) => makeTestFrame(`hi ${received.extensionId}`),
  onInput: (event) => event.name === "return"
};

describe("live UI child reducer", () => {
  it("replies ready on init with an instance derived from props and permissions", () => {
    const state = createLiveUiChildState("inst-1");
    const result = reduceLiveUiChild({ type: "init", props, host }, component, state);
    expect(result.replies).toEqual([
      {
        type: "ready",
        instance: {
          instanceId: "inst-1",
          extensionId: "review-pack",
          contributionId: "review-panel",
          surface: "modal",
          slot: "extension-ui",
          canReceiveInput: true,
          focusInfo: {
            instanceId: "inst-1",
            extensionId: "review-pack",
            contributionId: "review-panel",
            title: "review-pack/review-panel"
          }
        }
      }
    ]);
    expect(result.state.props).toEqual(props);
  });

  it("renders a bounded frame using negotiated limits on mount", () => {
    const initialised = reduceLiveUiChild({ type: "init", props, host }, component, createLiveUiChildState("i")).state;
    const result = reduceLiveUiChild({ type: "mount", width: 40, height: 10 }, component, initialised);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0].type).toBe("rendered");
    const frame = (result.replies[0] as { type: "rendered"; frame: LiveUiFrame }).frame;
    expect(frame.width).toBe(4);
    expect(frame.height).toBe(2);
    expect(frame.lines.length).toBeLessThanOrEqual(2);
    expect(result.state.mounted).toBe(true);
    expect(result.state.size).toEqual({ width: 40, height: 10 });
  });

  it("calls mount/resize hooks and re-renders on size change", () => {
    const onMount = vi.fn();
    const onResize = vi.fn();
    const lifecycleComponent: LiveUiComponent = { ...component, onMount, onResize };
    const mounted = reduceLiveUiChild(
      { type: "mount", width: 40, height: 10 },
      lifecycleComponent,
      reduceLiveUiChild({ type: "init", props, host }, lifecycleComponent, createLiveUiChildState("i")).state
    ).state;
    expect(onMount).toHaveBeenCalledWith(props, { width: 40, height: 10 });
    const resized = reduceLiveUiChild({ type: "resize", width: 20, height: 6 }, lifecycleComponent, mounted);
    expect(onResize).toHaveBeenCalledWith({ width: 20, height: 6 }, props);
    expect(resized.replies).toHaveLength(1);
    expect(resized.replies[0].type).toBe("rendered");
    expect(resized.state.size).toEqual({ width: 20, height: 6 });
  });

  it("swaps props and re-renders at the last known size on update", () => {
    const onUpdate = vi.fn();
    const updateComponent: LiveUiComponent = { ...component, onUpdate };
    const mountedState = reduceLiveUiChild(
      { type: "mount", width: 40, height: 10 },
      updateComponent,
      reduceLiveUiChild({ type: "init", props, host }, updateComponent, createLiveUiChildState("i")).state
    ).state;
    const nextProps: CrewCoderLiveUiProps = { ...props, extensionId: "review-pack-2" };
    const updated = reduceLiveUiChild({ type: "update", props: nextProps }, updateComponent, mountedState);
    expect(onUpdate).toHaveBeenCalledWith(nextProps, { width: 40, height: 10 });
    expect(updated.state.props).toEqual(nextProps);
    expect(updated.replies).toHaveLength(1);
    expect(updated.replies[0].type).toBe("rendered");
  });

  it("returns whether input was handled", () => {
    const initialised = reduceLiveUiChild({ type: "init", props, host }, component, createLiveUiChildState("i")).state;
    expect(reduceLiveUiChild({ type: "input", event: { name: "return" } }, component, initialised).replies).toEqual([
      { type: "handled_input", handled: true }
    ]);
    expect(reduceLiveUiChild({ type: "input", event: { name: "tab" } }, component, initialised).replies).toEqual([
      { type: "handled_input", handled: false }
    ]);
  });

  it("notifies components when focus changes", () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    const focusedComponent: LiveUiComponent = { ...component, onFocus, onBlur };
    const initialised = reduceLiveUiChild({ type: "init", props, host }, focusedComponent, createLiveUiChildState("i")).state;
    const focusInfo = { instanceId: "i", extensionId: "review-pack", contributionId: "review-panel", title: "review-pack/review-panel" };
    expect(reduceLiveUiChild({ type: "focus", focusInfo }, focusedComponent, initialised).replies).toEqual([]);
    expect(reduceLiveUiChild({ type: "blur", focusInfo }, focusedComponent, initialised).replies).toEqual([]);
    expect(onFocus).toHaveBeenCalledWith(props);
    expect(onBlur).toHaveBeenCalledWith(props);
  });

  it("marks state disposed, calls onDispose, and emits no replies on dispose", () => {
    const onDispose = vi.fn();
    const disposeComponent: LiveUiComponent = { ...component, onDispose };
    const initialised = reduceLiveUiChild({ type: "init", props, host }, disposeComponent, createLiveUiChildState("i")).state;
    const result = reduceLiveUiChild({ type: "dispose" }, disposeComponent, initialised);
    expect(result.replies).toEqual([]);
    expect(result.state.disposed).toBe(true);
    expect(onDispose).toHaveBeenCalledWith(props);
  });

  it("emits an error when asked to mount before init", () => {
    const result = reduceLiveUiChild({ type: "mount", width: 10, height: 10 }, component, createLiveUiChildState("i"));
    expect(result.replies).toEqual([{ type: "error", message: expect.stringContaining("init") }]);
  });

  it("includes action descriptors in the rendered frame when the component provides them", () => {
    const actionComponent: LiveUiComponent = {
      ...component,
      render: () => ({
        width: 4,
        height: 2,
        lines: [[{ text: "A" }]],
        actions: [{ id: "ok", label: "OK" }]
      })
    };
    const initialised = reduceLiveUiChild({ type: "init", props, host }, actionComponent, createLiveUiChildState("i")).state;
    const result = reduceLiveUiChild({ type: "mount", width: 40, height: 10 }, actionComponent, initialised);
    expect(result.replies).toHaveLength(1);
    const frame = (result.replies[0] as { type: "rendered"; frame: LiveUiFrame }).frame;
    expect(frame.actions).toBeDefined();
    expect(frame.actions![0]).toEqual({ id: "ok", label: "OK" });
  });
});
