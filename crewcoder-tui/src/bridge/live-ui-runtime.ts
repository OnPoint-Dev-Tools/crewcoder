/**
 * Child-side live UI runtime (SLICE A of the Live UI sandbox, Feature 2).
 *
 * This runs inside the sandboxed `worker_threads` Worker created by
 * `live-ui-host.ts`. An extension's live UI `entry` module imports
 * `runLiveUiComponent` and provides a component; the runtime wires the
 * serializable protocol to the host and enforces render bounds.
 *
 * The reducer (`reduceLiveUiChild`) is pure and side-effect free so the
 * protocol behaviour is unit-testable without spawning a real thread.
 */

import { randomUUID } from "node:crypto";
import { parentPort } from "node:worker_threads";
import {
  clampLiveUiFrame,
  parseLiveUiHostMessage,
  type CrewCoderLiveUiChildMessage,
  type CrewCoderLiveUiHost,
  type CrewCoderLiveUiHostMessage,
  type CrewCoderLiveUiInputEvent,
  type CrewCoderLiveUiInstance,
  type CrewCoderLiveUiProps,
  type LiveUiFrame
} from "./live-ui-protocol.js";

export type LiveUiComponentSize = {
  width: number;
  height: number;
};

export type LiveUiComponent = {
  render(props: CrewCoderLiveUiProps, size: LiveUiComponentSize): LiveUiFrame;
  onInput?(event: CrewCoderLiveUiInputEvent, props: CrewCoderLiveUiProps): boolean;
  /** Called once when the host mounts the instance with its initial size. */
  onMount?(props: CrewCoderLiveUiProps, size: LiveUiComponentSize): void;
  /** Called when the host pushes a fresh immutable props snapshot. */
  onUpdate?(props: CrewCoderLiveUiProps, size: LiveUiComponentSize): void;
  /** Called when the surface size changes after mount. */
  onResize?(size: LiveUiComponentSize, props: CrewCoderLiveUiProps): void;
  onFocus?(props: CrewCoderLiveUiProps): void;
  onBlur?(props: CrewCoderLiveUiProps): void;
  /** Called once as the instance is torn down. */
  onDispose?(props: CrewCoderLiveUiProps): void;
};

export type LiveUiChildState = {
  instanceId: string;
  props?: CrewCoderLiveUiProps;
  host?: CrewCoderLiveUiHost;
  /** Last size received via `mount`/`resize`; used to re-render on `update`. */
  size?: LiveUiComponentSize;
  mounted: boolean;
  disposed: boolean;
};

export type LiveUiChildReduction = {
  state: LiveUiChildState;
  replies: CrewCoderLiveUiChildMessage[];
};

export function createLiveUiChildState(instanceId: string): LiveUiChildState {
  return { instanceId, mounted: false, disposed: false };
}

function buildInstance(instanceId: string, props: CrewCoderLiveUiProps, host: CrewCoderLiveUiHost): CrewCoderLiveUiInstance {
  const canReceiveInput = (host.permissions.ui ?? []).includes("input");
  return {
    instanceId,
    extensionId: props.extensionId,
    contributionId: props.contributionId,
    surface: props.surface,
    ...(props.slot === undefined ? {} : { slot: props.slot }),
    canReceiveInput,
    focusInfo: {
      instanceId,
      extensionId: props.extensionId,
      contributionId: props.contributionId,
      title: `${props.extensionId}/${props.contributionId}`
    }
  };
}

export function reduceLiveUiChild(
  message: CrewCoderLiveUiHostMessage,
  component: LiveUiComponent,
  state: LiveUiChildState
): LiveUiChildReduction {
  switch (message.type) {
    case "init": {
      const nextState: LiveUiChildState = { ...state, props: message.props, host: message.host };
      return { state: nextState, replies: [{ type: "ready", instance: buildInstance(state.instanceId, message.props, message.host) }] };
    }
    case "mount": {
      if (!state.props || !state.host) {
        return { state, replies: [{ type: "error", message: "Received mount before init" }] };
      }
      const size = { width: message.width, height: message.height };
      component.onMount?.(state.props, size);
      const frame = component.render(state.props, size);
      const clampedMount = clampLiveUiFrame(frame, state.host.limits);
      return { state: { ...state, size, mounted: true }, replies: [{ type: "rendered", frame: clampedMount, scrollHeight: frame.scrollHeight }] };
    }
    case "resize": {
      if (!state.props || !state.host) {
        return { state, replies: [{ type: "error", message: "Received resize before init" }] };
      }
      const size = { width: message.width, height: message.height };
      component.onResize?.(size, state.props);
      const frame = component.render(state.props, size);
      const clampedResize = clampLiveUiFrame(frame, state.host.limits);
      return { state: { ...state, size }, replies: [{ type: "rendered", frame: clampedResize, scrollHeight: frame.scrollHeight }] };
    }
    case "update": {
      if (!state.props || !state.host) {
        return { state, replies: [{ type: "error", message: "Received update before init" }] };
      }
      const size = state.size ?? { width: 0, height: 0 };
      component.onUpdate?.(message.props, size);
      const frame = component.render(message.props, size);
      const clampedUpdate = clampLiveUiFrame(frame, state.host.limits);
      return { state: { ...state, props: message.props }, replies: [{ type: "rendered", frame: clampedUpdate, scrollHeight: frame.scrollHeight }] };
    }
    case "focus": {
      if (!state.props) {
        return { state, replies: [{ type: "error", message: "Received focus before init" }] };
      }
      component.onFocus?.(state.props);
      return { state, replies: [] };
    }
    case "blur": {
      if (!state.props) {
        return { state, replies: [{ type: "error", message: "Received blur before init" }] };
      }
      component.onBlur?.(state.props);
      return { state, replies: [] };
    }
    case "input": {
      if (!state.props) {
        return { state, replies: [{ type: "error", message: "Received input before init" }] };
      }
      const handled = component.onInput ? component.onInput(message.event, state.props) : false;
      return { state, replies: [{ type: "handled_input", handled }] };
    }
    case "session_state":
      return { state, replies: [] };
    case "viewport":
      // The host reports the visible viewport range on scroll. The component may
      // use this to render a windowed frame on the next render-producing event.
      return { state, replies: [] };
    case "dispose":
      if (state.props) component.onDispose?.(state.props);
      return { state: { ...state, disposed: true }, replies: [] };
    default:
      return { state, replies: [] };
  }
}

/** Minimal message-port surface the runtime needs from `parentPort`. */
export type LiveUiChildPort = {
  on(event: "message", listener: (value: unknown) => void): unknown;
  postMessage(value: unknown): void;
  close?(): void;
};

/**
 * Entry helper for extension live UI modules. Wires the host protocol to a
 * component and returns after registration; the worker stays alive on the
 * message loop until disposed.
 */
export function runLiveUiComponent(
  component: LiveUiComponent,
  port: LiveUiChildPort | null = parentPort,
  idFactory: () => string = randomUUID
): void {
  if (!port) throw new Error("runLiveUiComponent must be called inside a worker_threads Worker");
  let state = createLiveUiChildState(idFactory());
  port.on("message", (value) => {
    const message = parseLiveUiHostMessage(value);
    if (!message) return;
    const result = reduceLiveUiChild(message, component, state);
    state = result.state;
    for (const reply of result.replies) port.postMessage(reply);
    if (message.type === "dispose") port.close?.();
  });
}
