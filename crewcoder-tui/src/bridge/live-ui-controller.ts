/**
 * Live UI controller (SLICE 1 wiring orchestrator).
 *
 * Binds a sandboxed `LiveUiHost` (spawned through the trust gate) to the three
 * things the surrounding TUI needs but the bridge deliberately does not touch:
 *
 *   - a composited virtual frame (via `live-ui-frame.ts`) to blit into a surface,
 *   - a crash-fallback frame when the worker errors or exits,
 *   - lifecycle disposal through `LiveUiInstanceRegistry` on scroll/overlay/
 *     session/extension boundaries.
 *
 * It is decoupled from `App`: host commands surface through injected callbacks,
 * and repaint scheduling is delegated to a `LiveUiRepaintScheduler`, so the
 * controller is unit-testable with a fake trust gate.
 */

import type { LiveUiTrustGate } from "./live-ui-trust-gate.js";
import type { LiveUiInstanceRegistry, LiveUiDisposeReason } from "./live-ui-registry.js";
import type { LiveUiHostCallbacks } from "./live-ui-host.js";
import { compositeLiveUiFrame, compositeLiveUiLines, type LiveUiFrameTheme, type LiveUiRepaintScheduler } from "./live-ui-frame.js";
import type {
  CrewCoderLiveUiFocusInfo,
  CrewCoderLiveUiHost,
  CrewCoderLiveUiInputEvent,
  CrewCoderLiveUiJsonValue,
  CrewCoderLiveUiNotifyLevel,
  CrewCoderLiveUiPermissions,
  CrewCoderLiveUiProps,
  CrewCoderLiveUiSurface,
  LiveUiFrame
} from "./live-ui-protocol.js";

export type LiveUiMountRequest = {
  /** Registry key (typically a transcript block id or surface-scoped id). */
  key: string;
  entryPath: string;
  props: CrewCoderLiveUiProps;
  host: CrewCoderLiveUiHost;
  blockId?: string;
  /** Initial surface size; the first `mount` frame is produced at this size. */
  width: number;
  height: number;
  title?: string;
};

export type LiveUiInstanceStatus = "loading" | "ready" | "error" | "exited";

export type LiveUiFocus = {
  instanceId: string;
  key: string;
  extensionId: string;
  contributionId: string;
  surface: CrewCoderLiveUiSurface;
  title: string;
  permissions: CrewCoderLiveUiPermissions;
};

export type LiveUiControllerCallbacks = {
  onNotify?: (message: string, level: CrewCoderLiveUiNotifyLevel | undefined, extensionId: string) => void;
  onResolveUiRequest?: (requestId: string, value: string | boolean | null) => void;
  readSessionState?: (extensionId: string, key: string) => CrewCoderLiveUiJsonValue | undefined;
  writeSessionState?: (extensionId: string, key: string, value: CrewCoderLiveUiJsonValue) => void;
  readClipboard?: () => string | undefined;
  networkFetch?: (url: string, options: { method?: string; headers?: Record<string, string>; body?: string }, allowedHosts: string[]) => Promise<{ status?: number; body?: string; error?: string }>;
  onError?: (extensionId: string, contributionId: string, message: string) => void;
  /** Fired whenever a live UI instance gains or loses keyboard focus. */
  onFocusChange?: (focus: LiveUiFocus | undefined) => void;
  /** Fired when the focused child returns `handled: false` for an input event. */
  onUnhandledInput?: (event: CrewCoderLiveUiInputEvent) => void;
};

type LiveUiInstanceState = {
  key: string;
  extensionId: string;
  contributionId: string;
  surface: CrewCoderLiveUiSurface;
  title: string;
  status: LiveUiInstanceStatus;
  frame?: LiveUiFrame;
  scrollHeight?: number;
  scrollOffset: number;
  focusInfo?: CrewCoderLiveUiFocusInfo;
  message?: string;
  width: number;
  height: number;
};

export type LiveUiControllerDeps = {
  trustGate: LiveUiTrustGate;
  registry: LiveUiInstanceRegistry;
  scheduler: LiveUiRepaintScheduler;
  callbacks?: LiveUiControllerCallbacks;
};

export class LiveUiController {
  private readonly trustGate: LiveUiTrustGate;
  private readonly registry: LiveUiInstanceRegistry;
  private readonly scheduler: LiveUiRepaintScheduler;
  private readonly callbacks: LiveUiControllerCallbacks;
  private readonly states = new Map<string, LiveUiInstanceState>();

  constructor(deps: LiveUiControllerDeps) {
    this.trustGate = deps.trustGate;
    this.registry = deps.registry;
    this.scheduler = deps.scheduler;
    this.callbacks = deps.callbacks ?? {};
  }

  /**
   * Spawn a live component through the trust gate and start tracking it. Returns
   * `false` when the gate denies execution (config off / not allowed), in which
   * case nothing is spawned.
   */
  mount(request: LiveUiMountRequest): boolean {
    const state: LiveUiInstanceState = {
      key: request.key,
      extensionId: request.props.extensionId,
      contributionId: request.props.contributionId,
      surface: request.props.surface,
      title: request.title ?? `${request.props.extensionId}/${request.props.contributionId}`,
      status: "loading",
      scrollOffset: 0,
      width: request.width,
      height: request.height
    };
    this.states.set(request.key, state);

    const host = this.trustGate.spawnHost(
      { entryPath: request.entryPath, props: request.props, host: request.host },
      this.hostCallbacks(request.key)
    );
    if (!host) {
      this.states.delete(request.key);
      return false;
    }
    this.registry.register({ key: request.key, host, ...(request.blockId === undefined ? {} : { blockId: request.blockId }) });
    return true;
  }

  /** Update the surface size for a mounted instance and re-render at that size. */
  resize(key: string, width: number, height: number): void {
    const state = this.states.get(key);
    if (!state) return;
    state.width = width;
    state.height = height;
    this.trustGate.getHost(state.contributionId)?.sendResize(width, height);
  }

  /** Push a fresh immutable props snapshot to a mounted instance. */
  update(key: string, props: CrewCoderLiveUiProps): void {
    const state = this.states.get(key);
    if (!state) return;
    this.trustGate.getHost(state.contributionId)?.sendUpdate(props);
  }

  focus(key: string): boolean {
    const state = this.states.get(key);
    if (!state) return false;
    return this.trustGate.focusHost(state.contributionId);
  }

  blurFocused(): void {
    this.trustGate.blurFocusedHost();
  }

  sendInput(event: CrewCoderLiveUiInputEvent): boolean {
    return this.trustGate.sendInputToFocusedHost(event);
  }

  /**
   * Scroll the focused live UI instance by `delta` lines. Positive values scroll
   * down; negative values scroll up. The new offset is clamped to the child's
   * reported scroll height and the viewport reports its new visible range to the
   * child. Returns true when a focused instance exists.
   */
  scrollFocused(delta: number): boolean {
    const contributionId = this.trustGate.getFocusedHost()?.contributionId;
    if (!contributionId) return false;
    const state = [...this.states.values()].find((s) => s.contributionId === contributionId);
    if (!state) return false;
    const viewportHeight = state.height;
    const maxScroll = Math.max(0, (state.scrollHeight ?? viewportHeight) - viewportHeight);
    state.scrollOffset = Math.max(0, Math.min(maxScroll, state.scrollOffset + delta));
    this.trustGate.getHost(state.contributionId)?.sendViewport(state.scrollOffset, viewportHeight);
    this.scheduler.request();
    return true;
  }

  status(key: string): LiveUiInstanceStatus | undefined {
    return this.states.get(key)?.status;
  }

  /**
   * Composited frame for a mounted instance, or `undefined` if the key is
   * unknown. Error/exit states render a host-styled crash-fallback frame instead
   * of the child's last output.
   *
   * `options.boxed` defaults to true. Set it to false for surface: "status" to
   * receive sanitized content lines without the host box/title/borders.
   */
  frame(key: string, theme: LiveUiFrameTheme, size?: { width: number; height: number }, options?: { boxed?: boolean }): string[] | undefined {
    const state = this.states.get(key);
    if (!state) return undefined;
    const width = size?.width ?? state.width;
    const height = size?.height ?? state.height;
    const focused = Boolean(state.focusInfo);
    const boxed = options?.boxed !== false;
    const scrollOffset = state.scrollOffset;
    if (state.status === "error" || state.status === "exited") {
      const label = state.status === "error" ? "Live UI component crashed" : "Live UI component stopped";
      const detail = state.message ? [state.message] : [];
      return compositeLiveUiLines([label, ...detail, "This surface is inert; the worker was torn down."], {
        width,
        height,
        focused: false,
        title: state.title,
        theme,
        boxed,
        scrollOffset
      });
    }
    if (!state.frame) {
      return compositeLiveUiLines(["Loading…"], { width, height, focused, title: state.title, theme, boxed, scrollOffset });
    }
    if (!boxed) {
      return compositeLiveUiFrame(state.frame, { width, height, focused, title: state.title, theme, boxed: false, scrollOffset });
    }
    return compositeLiveUiFrame(state.frame, { width, height, focused, title: state.title, theme, scrollOffset });
  }

  disposeByBlock(blockId: string, reason?: LiveUiDisposeReason): Promise<number> {
    return this.registry.disposeByBlock(blockId, reason);
  }

  disposeBySurface(surface: CrewCoderLiveUiSurface, reason?: LiveUiDisposeReason): Promise<number> {
    return this.registry.disposeBySurface(surface, reason);
  }

  disposeByExtension(extensionId: string, reason?: LiveUiDisposeReason): Promise<number> {
    return this.registry.disposeByExtension(extensionId, reason);
  }

  disposeAll(reason?: LiveUiDisposeReason): Promise<number> {
    const keys = [...this.states.keys()];
    const result = this.registry.disposeAll(reason);
    for (const key of keys) this.states.delete(key);
    return result;
  }

  private focusFromState(state: LiveUiInstanceState, focusInfo: CrewCoderLiveUiFocusInfo): LiveUiFocus {
    return {
      instanceId: focusInfo.instanceId,
      key: state.key,
      extensionId: focusInfo.extensionId,
      contributionId: focusInfo.contributionId,
      surface: state.surface,
      title: focusInfo.title,
      permissions: this.trustGate.getHost(state.contributionId)?.permissions ?? { ui: [] }
    };
  }

  private hostCallbacks(key: string): LiveUiHostCallbacks {
    return {
      onReady: () => {
        const state = this.states.get(key);
        if (!state) return;
        state.status = "ready";
        this.trustGate.getHost(state.contributionId)?.sendMount(state.width, state.height);
      },
      onRendered: (frame, scrollHeight) => {
        const state = this.states.get(key);
        if (!state) return;
        state.frame = frame;
        if (scrollHeight !== undefined) state.scrollHeight = scrollHeight;
        this.scheduler.request();
      },
      onFocusChange: (focusInfo) => {
        const state = this.states.get(key);
        if (!state) return;
        state.focusInfo = focusInfo;
        this.callbacks.onFocusChange?.(focusInfo ? this.focusFromState(state, focusInfo) : undefined);
        this.scheduler.request();
      },
      onInputHandled: (_event, handled) => {
        if (!handled) {
          // The paired event was already shifted in LiveUiHost; expose the raw
          // input shape so the TUI can fall through to its normal handlers.
          this.callbacks.onUnhandledInput?.(_event);
        }
      },
      onHostCommand: (command) => this.handleHostCommand(key, command),
      onError: (message) => {
        const state = this.states.get(key);
        if (!state) return;
        state.status = "error";
        state.message = message;
        this.callbacks.onError?.(state.extensionId, state.contributionId, message);
        this.scheduler.request();
      },
      onExit: () => {
        const state = this.states.get(key);
        if (!state) return;
        // A clean disposal already removed the state; only surface unexpected exits.
        if (state.status !== "error") state.status = "exited";
        this.scheduler.request();
      }
    };
  }

  private handleHostCommand(key: string, command: Parameters<NonNullable<LiveUiHostCallbacks["onHostCommand"]>>[0]): void {
    const state = this.states.get(key);
    if (!state) return;
    switch (command.type) {
      case "notify":
        this.callbacks.onNotify?.(command.message, command.level, state.extensionId);
        return;
      case "request_repaint":
        this.scheduler.request();
        return;
      case "resolve_ui_request":
        this.callbacks.onResolveUiRequest?.(command.requestId, command.value);
        return;
      case "read_session_state": {
        const value = this.callbacks.readSessionState?.(state.extensionId, command.key);
        this.trustGate.getHost(state.contributionId)?.provideSessionState(command.requestId, value);
        return;
      }
      case "write_session_state":
        this.callbacks.writeSessionState?.(state.extensionId, command.key, command.value);
        return;
      case "read_clipboard": {
        const text = this.callbacks.readClipboard?.();
        this.trustGate.getHost(state.contributionId)?.provideClipboardText(command.requestId, text);
        return;
      }
      case "network_fetch": {
        const host = this.trustGate.getHost(state.contributionId);
        if (!host) return;
        const allowedHosts = host.permissions.network?.allowedHosts ?? [];
        const options = command.options ?? {};
        void this.callbacks.networkFetch?.(command.url, options, allowedHosts).then((result) => {
          host.provideNetworkResponse(command.requestId, result ?? { error: "network fetch returned no result" });
        }).catch((error) => {
          host.provideNetworkResponse(command.requestId, { error: error instanceof Error ? error.message : String(error) });
        });
        return;
      }
    }
  }
}
