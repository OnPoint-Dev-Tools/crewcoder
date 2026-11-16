/**
 * Live UI sandbox wire protocol (SLICE A).
 *
 * These types mirror the extension-facing contract sketched in
 * `crewcoder-agent/src/extensions/types.ts:181-200` and documented in
 * `crewcoder-agent/docs/LIVE_UI_COMPONENTS.md:143-221`.
 *
 * The agent package owns the canonical manifest/permission shape. The TUI keeps
 * a decoupled mirror here because it runs the live UI host in its own process
 * and only exchanges serializable JSON with the sandboxed child. Only plain,
 * structured-clone-safe values may cross this boundary: no functions, class
 * instances, AbortSignal, terminal handles, or direct TUI objects.
 */

export type CrewCoderLiveUiSurface = "modal" | "transcript" | "status";
export type CrewCoderLiveUiKind = "confirm" | "input" | "select" | "component";
export type CrewCoderLiveUiPermission = "render" | "input" | "focus";
export type CrewCoderLiveUiClipboardPermission = "none" | "write" | "read";
export type CrewCoderLiveUiStoragePermission = "none" | "session";
export type CrewCoderLiveUiTransport = "stdio-jsonl" | "worker-postmessage";

export type CrewCoderLiveUiJsonPrimitive = string | number | boolean | null;
export type CrewCoderLiveUiJsonValue =
  | CrewCoderLiveUiJsonPrimitive
  | CrewCoderLiveUiJsonValue[]
  | { [key: string]: CrewCoderLiveUiJsonValue };
export type CrewCoderLiveUiJsonObject = { [key: string]: CrewCoderLiveUiJsonValue };

/** Capability grant. This is the already-validated manifest `permissions` object. */
export type CrewCoderLiveUiPermissions = {
  ui?: CrewCoderLiveUiPermission[];
  events?: string[];
  commands?: string[];
  clipboard?: CrewCoderLiveUiClipboardPermission;
  network?: { allowedHosts: string[] };
  storage?: CrewCoderLiveUiStoragePermission;
};

export type CrewCoderLiveUiLimits = {
  maxRenderLines: number;
  maxLineLength: number;
  maxPayloadBytes: number;
};

export type LiveUiFrameCell = {
  text: string;
};

export type LiveUiActionDescriptor = {
  id: string;
  label: string;
};

/**
 * Virtual frame protocol for live UI render output.
 *
 * Instead of raw `string[]` lines, components produce a bounded frame of cells
 * and optional action descriptors. The host interprets and composites the frame
 * into the TUI surface; the sandboxed component never writes to the terminal
 * directly. Every field is structured-clone-safe.
 */
export type LiveUiFrame = {
  width: number;
  height: number;
  lines: LiveUiFrameCell[][];
  actions?: LiveUiActionDescriptor[];
  /** Total virtual height the child wants; may exceed the viewport height. */
  scrollHeight?: number;
};

export type CrewCoderLiveUiProps = {
  extensionId: string;
  contributionId: string;
  surface: CrewCoderLiveUiSurface;
  slot?: string;
  event: {
    type: string;
    requestId?: string;
    uiKind?: CrewCoderLiveUiKind;
    title?: string;
    message?: string;
    component?: CrewCoderLiveUiJsonValue;
    metadata?: CrewCoderLiveUiJsonObject;
  };
};

export type CrewCoderLiveUiHost = {
  protocolVersion: "0.1";
  transport: CrewCoderLiveUiTransport;
  /** Permissions granted after trust/config/policy checks, not raw requested permissions. */
  permissions: CrewCoderLiveUiPermissions;
  limits: CrewCoderLiveUiLimits;
};

export type CrewCoderLiveUiFocusInfo = {
  instanceId: string;
  extensionId: string;
  contributionId: string;
  title: string;
};

export type CrewCoderLiveUiInstance = {
  instanceId: string;
  extensionId: string;
  contributionId: string;
  surface: CrewCoderLiveUiSurface;
  slot?: string;
  canReceiveInput: boolean;
  focusInfo: CrewCoderLiveUiFocusInfo;
};

export type CrewCoderLiveUiInputEvent = {
  name: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  mouse?: {
    x: number;
    y: number;
    button: number;
    kind: "press" | "drag" | "release" | "wheel" | "hover";
  };
};

export type CrewCoderLiveUiNotifyLevel = "info" | "success" | "warning" | "error";

export type CrewCoderLiveUiHostCommand =
  | { type: "notify"; message: string; level?: CrewCoderLiveUiNotifyLevel }
  | { type: "resolve_ui_request"; requestId: string; value: string | boolean | null }
  | { type: "request_repaint" }
  | { type: "read_session_state"; requestId: string; key: string }
  | { type: "write_session_state"; key: string; value: CrewCoderLiveUiJsonValue }
  | { type: "read_clipboard"; requestId: string }
  | { type: "network_fetch"; requestId: string; url: string; options?: { method?: string; headers?: Record<string, string>; body?: string } };

export type CrewCoderLiveUiHostCommandType = CrewCoderLiveUiHostCommand["type"];

/**
 * Host -> child.
 *
 * Lifecycle is explicit. `mount` establishes the initial size and asks for the
 * first frame; `resize` reports a later size change; `update` swaps in a fresh
 * immutable props snapshot; `focus`/`blur` toggle keyboard ownership; `dispose`
 * tears the instance down. `mount`, `resize`, and `update` are "render-producing":
 * the child answers each with a single `rendered` reply, so the host can time out
 * and apply backpressure on a slow child. `render` no longer exists — it used to
 * double as mount+resize and has been split into the two explicit events.
 */
export type CrewCoderLiveUiHostMessage =
  | { type: "init"; props: CrewCoderLiveUiProps; host: CrewCoderLiveUiHost }
  | { type: "mount"; width: number; height: number }
  | { type: "resize"; width: number; height: number }
  | { type: "update"; props: CrewCoderLiveUiProps }
  | { type: "focus"; focusInfo: CrewCoderLiveUiFocusInfo }
  | { type: "blur"; focusInfo: CrewCoderLiveUiFocusInfo }
  | { type: "input"; event: CrewCoderLiveUiInputEvent }
  | { type: "session_state"; requestId: string; value?: CrewCoderLiveUiJsonValue }
  | { type: "viewport"; scrollOffset: number; viewportHeight: number }
  | { type: "clipboard_text"; requestId: string; text?: string }
  | { type: "network_response"; requestId: string; status?: number; body?: string; error?: string }
  | { type: "dispose" };

/** Host->child lifecycle messages that expect exactly one `rendered` reply. */
export type CrewCoderLiveUiRenderMessageType = "mount" | "resize" | "update";

/**
 * Whether a host->child message is expected to produce a `rendered` reply. Used
 * by the host to arm a response timeout and coalesce backpressure. `focus`/`blur`
 * are lifecycle-only and do not produce a frame, so they are excluded.
 */
export function isLiveUiRenderProducing(message: CrewCoderLiveUiHostMessage): boolean {
  return message.type === "mount" || message.type === "resize" || message.type === "update";
}

/** Child -> host. */
export type CrewCoderLiveUiChildMessage =
  | { type: "ready"; instance: CrewCoderLiveUiInstance }
  | { type: "rendered"; frame: LiveUiFrame; scrollHeight?: number }
  | { type: "handled_input"; handled: boolean }
  | { type: "host_command"; command: CrewCoderLiveUiHostCommand }
  | { type: "error"; message: string };

/** Serializable data handed to the worker at construction time. */
export type CrewCoderLiveUiWorkerData = {
  props: CrewCoderLiveUiProps;
  host: CrewCoderLiveUiHost;
};

/**
 * Decide whether a child-issued host command is covered by the granted
 * permissions. Missing capabilities are denied by default.
 */
export function isLiveUiHostCommandAllowed(
  command: CrewCoderLiveUiHostCommand,
  permissions: CrewCoderLiveUiPermissions
): boolean {
  switch (command.type) {
    case "notify":
    case "request_repaint":
      return true;
    case "resolve_ui_request":
      return (permissions.commands ?? []).includes("ui_response");
    case "read_session_state":
    case "write_session_state":
      return permissions.storage === "session";
    case "read_clipboard":
      return permissions.clipboard === "read" || permissions.clipboard === "write";
    case "network_fetch":
      return Array.isArray(permissions.network?.allowedHosts) && permissions.network!.allowedHosts.length > 0;
  }
}

/** Whether the host may forward keyboard input to the child. */
export function canSendLiveUiInput(permissions: CrewCoderLiveUiPermissions): boolean {
  return (permissions.ui ?? []).includes("input");
}

export const RESERVED_LIVE_UI_INPUT_KEYS: readonly CrewCoderLiveUiInputEvent[] = [
  { name: "escape" },
  { name: "c", ctrl: true },
  { name: "p", ctrl: true },
  { name: "i", ctrl: true },
  { name: "o", ctrl: true }
];

/**
 * Global TUI escape hatches are never forwarded to live UI children. This keeps
 * command palette, abort/close, process interrupt, agent picker, and viewport
 * tool-output shortcuts available even while a custom component owns focus.
 */
export function isReservedLiveUiInput(event: CrewCoderLiveUiInputEvent): boolean {
  return RESERVED_LIVE_UI_INPUT_KEYS.some((reserved) =>
    event.name === reserved.name &&
    Boolean(event.ctrl) === Boolean(reserved.ctrl) &&
    Boolean(event.meta) === Boolean(reserved.meta) &&
    Boolean(event.shift) === Boolean(reserved.shift)
  );
}

const MAX_CELL_TEXT_LENGTH = 200;
const MAX_ACTIONS = 20;
const MAX_ACTION_LABEL_LENGTH = 60;

/**
 * Bound a live UI frame to the negotiated limits. Caps the line count, cells
 * per line, per-cell text length, action count/label length, and total
 * serialized byte size so a misbehaving child cannot flood the host.
 *
 * Each cell's text is an independent bounded unit; the frame never carries raw
 * ANSI escape codes. The host interprets cell structure when compositing.
 */
export function clampLiveUiFrame(frame: LiveUiFrame, limits: CrewCoderLiveUiLimits): LiveUiFrame {
  const maxLines = Math.max(1, Math.floor(Math.min(limits.maxRenderLines, Math.max(1, frame.height))));
  const maxCells = Math.max(1, Math.floor(Math.min(limits.maxLineLength, Math.max(1, frame.width))));
  const maxPayloadBytes = Math.max(0, Math.floor(limits.maxPayloadBytes));

  const clampedLines: LiveUiFrameCell[][] = [];
  let usedBytes = 0;

  for (let i = 0; i < frame.lines.length && i < maxLines; i++) {
    const row = frame.lines[i];
    if (!Array.isArray(row)) break;
    const clampedRow: LiveUiFrameCell[] = [];
    for (let j = 0; j < row.length && j < maxCells; j++) {
      const cell = row[j];
      const text = typeof cell?.text === "string" ? cell.text.slice(0, MAX_CELL_TEXT_LENGTH) : "";
      const cellBytes = Buffer.byteLength(text, "utf8");
      if (usedBytes + cellBytes > maxPayloadBytes) break;
      usedBytes += cellBytes;
      clampedRow.push({ text });
    }
    if (clampedRow.length > 0 || clampedLines.length === 0) {
      clampedLines.push(clampedRow);
    }
  }

  let clampedActions: LiveUiActionDescriptor[] | undefined;
  if (frame.actions && Array.isArray(frame.actions)) {
    const actions: LiveUiActionDescriptor[] = [];
    for (const a of frame.actions.slice(0, MAX_ACTIONS)) {
      if (typeof a?.id !== "string" || typeof a?.label !== "string") continue;
      actions.push({ id: a.id, label: a.label.slice(0, MAX_ACTION_LABEL_LENGTH) });
    }
    if (actions.length > 0) clampedActions = actions;
  }

  const scrollHeight = frame.scrollHeight !== undefined ? Math.max(frame.scrollHeight, maxLines) : undefined;
  return {
    width: maxCells,
    height: maxLines,
    lines: clampedLines,
    ...(clampedActions ? { actions: clampedActions } : {}),
    ...(scrollHeight !== undefined ? { scrollHeight } : {})
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Narrow an untrusted structured-clone value into a known host message. */
export function parseLiveUiHostMessage(value: unknown): CrewCoderLiveUiHostMessage | undefined {
  if (!isJsonObject(value)) return undefined;
  switch (value.type) {
    case "init":
      if (isJsonObject(value.props) && isJsonObject(value.host)) {
        return { type: "init", props: value.props as CrewCoderLiveUiProps, host: value.host as CrewCoderLiveUiHost };
      }
      return undefined;
    case "mount":
      if (typeof value.width === "number" && typeof value.height === "number") {
        return { type: "mount", width: value.width, height: value.height };
      }
      return undefined;
    case "resize":
      if (typeof value.width === "number" && typeof value.height === "number") {
        return { type: "resize", width: value.width, height: value.height };
      }
      return undefined;
    case "update":
      if (isJsonObject(value.props)) {
        return { type: "update", props: value.props as CrewCoderLiveUiProps };
      }
      return undefined;
    case "focus":
      if (isJsonObject(value.focusInfo) && typeof value.focusInfo.instanceId === "string") {
        return { type: "focus", focusInfo: value.focusInfo as CrewCoderLiveUiFocusInfo };
      }
      return undefined;
    case "blur":
      if (isJsonObject(value.focusInfo) && typeof value.focusInfo.instanceId === "string") {
        return { type: "blur", focusInfo: value.focusInfo as CrewCoderLiveUiFocusInfo };
      }
      return undefined;
    case "input":
      if (isJsonObject(value.event) && typeof value.event.name === "string") {
        return { type: "input", event: value.event as CrewCoderLiveUiInputEvent };
      }
      return undefined;
    case "session_state":
      if (typeof value.requestId === "string") {
        return { type: "session_state", requestId: value.requestId, value: value.value as CrewCoderLiveUiJsonValue };
      }
      return undefined;
    case "viewport":
      if (typeof value.scrollOffset === "number" && typeof value.viewportHeight === "number") {
        return { type: "viewport", scrollOffset: value.scrollOffset, viewportHeight: value.viewportHeight };
      }
      return undefined;
    case "clipboard_text":
      if (typeof value.requestId === "string") {
        return { type: "clipboard_text", requestId: value.requestId, text: typeof value.text === "string" ? value.text : undefined };
      }
      return undefined;
    case "network_response":
      if (typeof value.requestId === "string") {
        return { type: "network_response", requestId: value.requestId, status: typeof value.status === "number" ? value.status : undefined, body: typeof value.body === "string" ? value.body : undefined, error: typeof value.error === "string" ? value.error : undefined };
      }
      return undefined;
    case "dispose":
      return { type: "dispose" };
    default:
      return undefined;
  }
}

/** Narrow an untrusted structured-clone value into a known child message. */
export function parseLiveUiChildMessage(value: unknown): CrewCoderLiveUiChildMessage | undefined {
  if (!isJsonObject(value)) return undefined;
  switch (value.type) {
    case "ready":
      if (isJsonObject(value.instance) && typeof value.instance.instanceId === "string") {
        return { type: "ready", instance: value.instance as CrewCoderLiveUiInstance };
      }
      return undefined;
    case "rendered": {
      const frame = validateLiveUiFrame(value.frame);
      return frame ? { type: "rendered", frame, scrollHeight: typeof value.scrollHeight === "number" ? value.scrollHeight : undefined } : undefined;
    }
    case "handled_input":
      if (typeof value.handled === "boolean") {
        return { type: "handled_input", handled: value.handled };
      }
      return undefined;
    case "host_command": {
      const command = parseLiveUiHostCommand(value.command);
      return command ? { type: "host_command", command } : undefined;
    }
    case "error":
      if (typeof value.message === "string") {
        return { type: "error", message: value.message };
      }
      return undefined;
    default:
      return undefined;
  }
}

function validateLiveUiFrame(value: unknown): LiveUiFrame | undefined {
  if (!isJsonObject(value)) return undefined;
  if (typeof value.width !== "number" || typeof value.height !== "number") return undefined;
  if (!Array.isArray(value.lines)) return undefined;

  const lines: LiveUiFrameCell[][] = [];
  for (const row of value.lines) {
    if (!Array.isArray(row)) return undefined;
    const cells: LiveUiFrameCell[] = [];
    for (const cell of row) {
      if (!isJsonObject(cell) || typeof cell.text !== "string") return undefined;
      cells.push({ text: cell.text });
    }
    lines.push(cells);
  }

  let actions: LiveUiActionDescriptor[] | undefined;
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions)) return undefined;
    actions = [];
    for (const a of value.actions) {
      if (!isJsonObject(a) || typeof a.id !== "string" || typeof a.label !== "string") return undefined;
      actions.push({ id: a.id, label: a.label });
    }
  }

  const scrollHeight = typeof value.scrollHeight === "number" ? value.scrollHeight : undefined;
  return { width: value.width, height: value.height, lines, ...(actions ? { actions } : {}), ...(scrollHeight !== undefined ? { scrollHeight } : {}) };
}

function parseNotifyLevel(value: unknown): CrewCoderLiveUiNotifyLevel | undefined {
  return value === "info" || value === "success" || value === "warning" || value === "error" ? value : undefined;
}

function parseLiveUiHostCommand(value: unknown): CrewCoderLiveUiHostCommand | undefined {
  if (!isJsonObject(value)) return undefined;
  switch (value.type) {
    case "notify":
      if (typeof value.message === "string") {
        const level = parseNotifyLevel(value.level);
        return level ? { type: "notify", message: value.message, level } : { type: "notify", message: value.message };
      }
      return undefined;
    case "resolve_ui_request":
      if (typeof value.requestId === "string" && (typeof value.value === "string" || typeof value.value === "boolean" || value.value === null)) {
        return { type: "resolve_ui_request", requestId: value.requestId, value: value.value };
      }
      return undefined;
    case "request_repaint":
      return { type: "request_repaint" };
    case "read_session_state":
      if (typeof value.requestId === "string" && typeof value.key === "string") {
        return { type: "read_session_state", requestId: value.requestId, key: value.key };
      }
      return undefined;
    case "write_session_state":
      if (typeof value.key === "string") {
        return { type: "write_session_state", key: value.key, value: value.value as CrewCoderLiveUiJsonValue };
      }
      return undefined;
    case "read_clipboard":
      if (typeof value.requestId === "string") {
        return { type: "read_clipboard", requestId: value.requestId };
      }
      return undefined;
    case "network_fetch":
      if (typeof value.requestId === "string" && typeof value.url === "string") {
        const options = value.options;
        if (options === undefined || options === null) {
          return { type: "network_fetch", requestId: value.requestId, url: value.url };
        }
        if (typeof options !== "object" || Array.isArray(options)) return undefined;
        const opts = options as Record<string, unknown>;
        return {
          type: "network_fetch",
          requestId: value.requestId,
          url: value.url,
          options: {
            ...(typeof opts.method === "string" ? { method: opts.method } : {}),
            ...(opts.headers && typeof opts.headers === "object" && !Array.isArray(opts.headers) ? { headers: opts.headers as Record<string, string> } : {}),
            ...(typeof opts.body === "string" ? { body: opts.body } : {})
          }
        };
      }
      return undefined;
    default:
      return undefined;
  }
}
