/**
 * Isolated live-UI host (SLICE A of the Live UI sandbox, Feature 2).
 *
 * The host runs an extension's live UI `entry` module in a dedicated
 * `worker_threads` Worker, never in the main TUI process. It speaks the
 * serializable JSON protocol defined in `live-ui-protocol.ts` and enforces the
 * capability grant carried on `host.permissions`. The worker is starved of the
 * parent environment (`env: {}`) and receives only structured-clone-safe data.
 *
 * This module intentionally does not touch the overlay/viewport render or input
 * paths; the surrounding TUI wires rendered lines and host commands to those
 * surfaces separately.
 */

import { Worker } from "node:worker_threads";
import {
  canSendLiveUiInput,
  clampLiveUiFrame,
  isLiveUiHostCommandAllowed,
  isReservedLiveUiInput,
  parseLiveUiChildMessage,
  type CrewCoderLiveUiFocusInfo,
  type CrewCoderLiveUiHost,
  type CrewCoderLiveUiHostCommand,
  type CrewCoderLiveUiInstance,
  type CrewCoderLiveUiJsonValue,
  type CrewCoderLiveUiInputEvent,
  type CrewCoderLiveUiPermissions,
  type CrewCoderLiveUiProps,
  type CrewCoderLiveUiSurface,
  type CrewCoderLiveUiWorkerData,
  type LiveUiFrame
} from "./live-ui-protocol.js";

export type LiveUiSpawnOptions = {
  /** Extension-relative-resolved absolute path to the built live UI entry module. */
  entryPath: string;
  props: CrewCoderLiveUiProps;
  host: CrewCoderLiveUiHost;
};

/**
 * Coarse lifecycle phase for a single host/instance. Exposed via
 * `LiveUiHost.lifecyclePhase` and `onLifecycle` so the wiring layer can track
 * instance lifecycles without reaching into worker internals.
 */
export type LiveUiLifecyclePhase = "idle" | "spawning" | "ready" | "mounted" | "disposed" | "exited";

/** A render-producing host->child message tracked by the backpressure queue. */
export type LiveUiRenderRequest =
  | { type: "mount"; width: number; height: number }
  | { type: "resize"; width: number; height: number }
  | { type: "update"; props: CrewCoderLiveUiProps };

export type LiveUiHostCallbacks = {
  onReady?: (instance: CrewCoderLiveUiInstance) => void;
  onRendered?: (frame: LiveUiFrame, scrollHeight?: number) => void;
  onFocusChange?: (focusInfo: CrewCoderLiveUiFocusInfo | undefined) => void;
  onHandledInput?: (handled: boolean) => void;
  onInputHandled?: (event: CrewCoderLiveUiInputEvent, handled: boolean) => void;
  onUnhandledInput?: (event: CrewCoderLiveUiInputEvent) => void;
  onHostCommand?: (command: CrewCoderLiveUiHostCommand) => void;
  onError?: (message: string) => void;
  onExit?: (code: number) => void;
  /** Fired on every lifecycle-phase transition. */
  onLifecycle?: (phase: LiveUiLifecyclePhase, instance: CrewCoderLiveUiInstance | undefined) => void;
  /** A render-producing request went unanswered within `renderTimeoutMs`. */
  onRenderTimeout?: (request: LiveUiRenderRequest) => void;
  /** A queued render request was dropped because the backpressure queue was full. */
  onBackpressureDrop?: (request: LiveUiRenderRequest) => void;
};

/** Injectable timer surface so timeout behavior is testable without real time. */
export type LiveUiTimers = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** Timeout/backpressure tuning for a host. All fields optional at the call site. */
export type LiveUiHostConfig = {
  /** Deadline (ms) for a `rendered`/`error` reply to a render-producing request. */
  renderTimeoutMs: number;
  /** Max render-producing requests buffered while one is in flight. */
  maxPendingRenders: number;
  /** Hard-stop the worker via `dispose()` when a render request times out. */
  disposeOnTimeout: boolean;
  timers: LiveUiTimers;
};

export const DEFAULT_LIVE_UI_RENDER_TIMEOUT_MS = 2000;
export const DEFAULT_LIVE_UI_MAX_PENDING_RENDERS = 8;

const defaultLiveUiTimers: LiveUiTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** Minimal surface the host needs; real `worker_threads.Worker` satisfies it. */
export type LiveUiWorkerLike = {
  postMessage(value: unknown): void;
  on(event: string, listener: (value: unknown) => void): unknown;
  terminate(): Promise<number> | number | void;
};

export type LiveUiWorkerSpec = {
  entryPath: string;
  workerData: CrewCoderLiveUiWorkerData;
};

export type LiveUiWorkerFactory = (spec: LiveUiWorkerSpec) => LiveUiWorkerLike;

export type LiveUiWorkerOptions = {
  workerData: CrewCoderLiveUiWorkerData;
  env: Record<string, string>;
};

export function buildLiveUiWorkerData(options: LiveUiSpawnOptions): CrewCoderLiveUiWorkerData {
  return { props: options.props, host: options.host };
}

/**
 * Worker options with a deliberately empty environment. The child gets no
 * inherited `process.env`, so filesystem/process access is not implicitly
 * granted through environment configuration.
 */
export function buildLiveUiWorkerOptions(workerData: CrewCoderLiveUiWorkerData): LiveUiWorkerOptions {
  return { workerData, env: {} };
}

export const defaultLiveUiWorkerFactory: LiveUiWorkerFactory = (spec) => {
  const options = buildLiveUiWorkerOptions(spec.workerData);
  return new Worker(spec.entryPath, { workerData: options.workerData, env: options.env });
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown live UI worker error";
}

export class LiveUiHost {
  private readonly options: LiveUiSpawnOptions;
  private readonly callbacks: LiveUiHostCallbacks;
  private readonly factory: LiveUiWorkerFactory;
  private readonly config: LiveUiHostConfig;
  private worker: LiveUiWorkerLike | undefined;
  private instance: CrewCoderLiveUiInstance | undefined;
  private focusedInstanceId: string | undefined;
  private readonly pendingInputEvents: CrewCoderLiveUiInputEvent[] = [];
  private phase: LiveUiLifecyclePhase = "idle";
  private readonly renderQueue: LiveUiRenderRequest[] = [];
  private inFlightRender: LiveUiRenderRequest | undefined;
  private renderTimer: unknown;
  private disposed = false;

  constructor(
    options: LiveUiSpawnOptions,
    callbacks: LiveUiHostCallbacks = {},
    factory: LiveUiWorkerFactory = defaultLiveUiWorkerFactory,
    config: Partial<LiveUiHostConfig> = {}
  ) {
    this.options = options;
    this.callbacks = callbacks;
    this.factory = factory;
    this.config = {
      renderTimeoutMs: config.renderTimeoutMs ?? DEFAULT_LIVE_UI_RENDER_TIMEOUT_MS,
      maxPendingRenders: config.maxPendingRenders ?? DEFAULT_LIVE_UI_MAX_PENDING_RENDERS,
      disposeOnTimeout: config.disposeOnTimeout ?? false,
      timers: config.timers ?? defaultLiveUiTimers
    };
  }

  get ready(): boolean {
    return Boolean(this.instance);
  }

  get activeInstance(): CrewCoderLiveUiInstance | undefined {
    return this.instance;
  }

  /** Current lifecycle phase; drives the wiring layer's instance tracking. */
  get lifecyclePhase(): LiveUiLifecyclePhase {
    return this.phase;
  }

  get extensionId(): string {
    return this.options.props.extensionId;
  }

  get contributionId(): string {
    return this.options.props.contributionId;
  }

  get surface(): CrewCoderLiveUiSurface {
    return this.options.props.surface;
  }

  /** Render-producing requests queued or in flight (backpressure depth). */
  get pendingRenderCount(): number {
    return this.renderQueue.length + (this.inFlightRender ? 1 : 0);
  }

  get focusInfo(): CrewCoderLiveUiFocusInfo | undefined {
    if (!this.instance || this.focusedInstanceId !== this.instance.instanceId) return undefined;
    return this.instance.focusInfo;
  }

  /** Granted permissions for this host. The wiring layer uses this for chrome. */
  get permissions(): CrewCoderLiveUiPermissions {
    return this.options.host.permissions;
  }

  spawn(): void {
    if (this.worker || this.disposed) return;
    this.setPhase("spawning");
    const worker = this.factory({ entryPath: this.options.entryPath, workerData: buildLiveUiWorkerData(this.options) });
    this.worker = worker;
    worker.on("message", (value) => this.handleChildMessage(value));
    worker.on("error", (value) => this.callbacks.onError?.(getErrorMessage(value)));
    worker.on("exit", (value) => {
      this.instance = undefined;
      this.focusedInstanceId = undefined;
      this.pendingInputEvents.length = 0;
      this.clearRenderPipeline();
      this.callbacks.onFocusChange?.(undefined);
      this.setPhase("exited");
      this.callbacks.onExit?.(typeof value === "number" ? value : 0);
    });
    this.post({ type: "init", props: this.options.props, host: this.options.host });
  }

  /** Mount the instance at its initial size. First render-producing request. */
  sendMount(width: number, height: number): boolean {
    if (!this.instance) return false;
    this.enqueueRender({ type: "mount", width, height });
    this.setPhase("mounted");
    return true;
  }

  /** Report a surface size change after mount. */
  sendResize(width: number, height: number): boolean {
    if (!this.instance) return false;
    this.enqueueRender({ type: "resize", width, height });
    return true;
  }

  /** Push a fresh immutable props snapshot; triggers a re-render at current size. */
  sendUpdate(props: CrewCoderLiveUiProps): boolean {
    if (!this.instance) return false;
    this.enqueueRender({ type: "update", props });
    return true;
  }

  focus(): boolean {
    if (!this.instance || !this.instance.canReceiveInput) return false;
    if (!canSendLiveUiInput(this.options.host.permissions)) return false;
    if (this.focusedInstanceId === this.instance.instanceId) return true;
    this.focusedInstanceId = this.instance.instanceId;
    this.post({ type: "focus", focusInfo: this.instance.focusInfo });
    this.callbacks.onFocusChange?.(this.instance.focusInfo);
    return true;
  }

  blur(): boolean {
    if (!this.instance || this.focusedInstanceId !== this.instance.instanceId) return false;
    const focusInfo = this.instance.focusInfo;
    this.focusedInstanceId = undefined;
    this.pendingInputEvents.length = 0;
    this.post({ type: "blur", focusInfo });
    this.callbacks.onFocusChange?.(undefined);
    return true;
  }

  sendInput(event: CrewCoderLiveUiInputEvent): boolean {
    if (!this.instance || this.focusedInstanceId !== this.instance.instanceId) return false;
    if (!this.instance.canReceiveInput) return false;
    if (!canSendLiveUiInput(this.options.host.permissions)) return false;
    if (isReservedLiveUiInput(event)) return false;
    this.pendingInputEvents.push(event);
    this.post({ type: "input", event });
    return true;
  }

  /** Report a change in the visible viewport (scroll offset and viewport height). */
  sendViewport(scrollOffset: number, viewportHeight: number): boolean {
    if (!this.instance) return false;
    this.post({ type: "viewport", scrollOffset, viewportHeight });
    return true;
  }

  /** Answer a child `read_session_state` request. Requires the storage grant. */
  provideSessionState(requestId: string, value?: CrewCoderLiveUiJsonValue): boolean {
    if (!this.instance || this.options.host.permissions.storage !== "session") return false;
    this.post({ type: "session_state", requestId, value });
    return true;
  }

  /** Answer a child `read_clipboard` request. */
  provideClipboardText(requestId: string, text?: string): boolean {
    if (!this.instance) return false;
    this.post({ type: "clipboard_text", requestId, text });
    return true;
  }

  /** Answer a child `network_fetch` request. */
  provideNetworkResponse(requestId: string, response: { status?: number; body?: string; error?: string }): boolean {
    if (!this.instance) return false;
    this.post({ type: "network_response", requestId, ...response });
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    this.worker = undefined;
    this.instance = undefined;
    this.focusedInstanceId = undefined;
    this.pendingInputEvents.length = 0;
    this.clearRenderPipeline();
    this.setPhase("disposed");
    this.callbacks.onFocusChange?.(undefined);
    if (!worker) return;
    try {
      worker.postMessage({ type: "dispose" });
    } catch {
      // Worker may already be gone; termination below is the hard guarantee.
    }
    await Promise.resolve(worker.terminate());
  }

  private post(message: unknown): void {
    if (!this.worker) return;
    this.worker.postMessage(message);
  }

  private setPhase(phase: LiveUiLifecyclePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.callbacks.onLifecycle?.(phase, this.instance);
  }

  /**
   * Backpressure: at most one render-producing request is in flight at a time.
   * Bursts queue up (consecutive resizes coalesce to the latest), and the queue
   * is capped at `maxPendingRenders` so a slow child cannot make the host buffer
   * unbounded work — the oldest queued request is dropped when the cap is hit.
   */
  private enqueueRender(request: LiveUiRenderRequest): void {
    const last = this.renderQueue[this.renderQueue.length - 1];
    if (last && last.type === "resize" && request.type === "resize") {
      this.renderQueue[this.renderQueue.length - 1] = request;
    } else {
      this.renderQueue.push(request);
    }
    while (this.renderQueue.length > this.config.maxPendingRenders) {
      const dropped = this.renderQueue.shift();
      if (dropped) this.callbacks.onBackpressureDrop?.(dropped);
    }
    this.pumpRender();
  }

  private pumpRender(): void {
    if (this.inFlightRender || !this.worker) return;
    const next = this.renderQueue.shift();
    if (!next) return;
    this.inFlightRender = next;
    this.post(next);
    this.startRenderTimer();
  }

  private startRenderTimer(): void {
    this.clearRenderTimer();
    this.renderTimer = this.config.timers.setTimeout(() => this.handleRenderTimeout(), this.config.renderTimeoutMs);
  }

  private clearRenderTimer(): void {
    if (this.renderTimer !== undefined) {
      this.config.timers.clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
  }

  private handleRenderTimeout(): void {
    const request = this.inFlightRender;
    this.inFlightRender = undefined;
    this.renderTimer = undefined;
    if (request) this.callbacks.onRenderTimeout?.(request);
    if (this.config.disposeOnTimeout) {
      void this.dispose();
      return;
    }
    this.pumpRender();
  }

  /** A render-producing request was answered (or failed); release the slot. */
  private settleRender(): void {
    this.clearRenderTimer();
    this.inFlightRender = undefined;
    this.pumpRender();
  }

  private clearRenderPipeline(): void {
    this.clearRenderTimer();
    this.renderQueue.length = 0;
    this.inFlightRender = undefined;
  }

  private withFocusInfo(instance: CrewCoderLiveUiInstance): CrewCoderLiveUiInstance {
    return {
      ...instance,
      focusInfo: instance.focusInfo ?? {
        instanceId: instance.instanceId,
        extensionId: instance.extensionId,
        contributionId: instance.contributionId,
        title: `${instance.extensionId}/${instance.contributionId}`
      }
    };
  }

  private handleChildMessage(value: unknown): void {
    const message = parseLiveUiChildMessage(value);
    if (!message) return;
    switch (message.type) {
      case "ready": {
        const instance = this.withFocusInfo(message.instance);
        this.instance = instance;
        this.setPhase("ready");
        this.callbacks.onReady?.(instance);
        return;
      }
      case "rendered": {
        this.settleRender();
        const frame = clampLiveUiFrame(message.frame, this.options.host.limits);
        this.callbacks.onRendered?.(frame, message.scrollHeight);
        return;
      }
      case "handled_input": {
        const event = this.pendingInputEvents.shift();
        this.callbacks.onHandledInput?.(message.handled);
        if (event) {
          this.callbacks.onInputHandled?.(event, message.handled);
          if (!message.handled) this.callbacks.onUnhandledInput?.(event);
        }
        return;
      }
      case "host_command":
        this.handleHostCommand(message.command);
        return;
      case "error":
        // A render-producing request may have failed; release the in-flight slot
        // so the queue keeps draining instead of stalling until the timeout.
        if (this.inFlightRender) this.settleRender();
        this.callbacks.onError?.(message.message);
        return;
    }
  }

  private handleHostCommand(command: CrewCoderLiveUiHostCommand): void {
    if (!isLiveUiHostCommandAllowed(command, this.options.host.permissions)) {
      this.callbacks.onError?.(
        `Live UI extension ${this.options.props.extensionId} requested "${command.type}" without a matching permission grant`
      );
      return;
    }
    this.callbacks.onHostCommand?.(command);
  }
}
