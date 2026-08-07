/**
 * Extension UI bridge.
 *
 * Turns an extension's `ctx.ui.*` calls into live, host-driven interactions:
 *
 *   - `notify(message, level)`  -> fire-and-forget `extension_ui_notify` event
 *   - `confirm/input/select/component` -> `extension_ui_request` event, then await a
 *                                         matching `ui_response` control message
 *
 * The request/response handshake mirrors the tool-approval channel: the backend
 * emits a request carrying a unique `requestId`, the host (TUI / JSON-events
 * driver) prompts the user and writes a control message back, and the bridge
 * resolves the pending promise. When no interactive host is attached
 * (`hasUI === false`) every call falls back to a safe, non-blocking default so
 * print-mode runs never hang.
 */
import type { AgentEventSink } from "./events.js";
import type { CrewCoderExtUI, CrewCoderExtUiAction, CrewCoderExtUiComponent } from "../extensions/api.js";

export type ExtensionUiResponseValue = string | boolean | null;

export type ExtensionUiBridge = {
  /** UI implementation scoped to a single extension id. */
  uiFor(extensionId: string): CrewCoderExtUI;
  /**
   * Resolve a pending request from a host control message. Returns true when a
   * matching pending request existed (and was resolved), false otherwise.
   */
  resolveResponse(requestId: string, value: ExtensionUiResponseValue): boolean;
  /** True while one or more requests are awaiting a host response. */
  hasPending(): boolean;
  /** Reject all pending requests with their safe default (used on teardown). */
  cancelAll(): void;
};

type PendingRequest = {
  resolve: (value: ExtensionUiResponseValue) => void;
};

type RequestPayload = {
  uiKind: "confirm" | "input" | "select" | "component";
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  component?: CrewCoderExtUiComponent;
  actions?: CrewCoderExtUiAction[];
};

const MAX_COMPONENT_TEXT = 8_000;
const MAX_COMPONENT_ITEMS = 50;
const MAX_COMPONENT_COLUMNS = 8;
const MAX_COMPONENT_ROWS = 100;
const MAX_COMPONENT_LABEL = 120;
const MAX_COMPONENT_VALUE = 1_000;
const MAX_COMPONENT_ACTIONS = 20;

function fallbackUi(): CrewCoderExtUI {
  return {
    notify() {},
    async confirm() {
      return false;
    },
    async input(_title, options) {
      return options?.defaultValue;
    },
    async select<T extends string>(
      _title: string,
      options: T[] | Array<{ label: string; value: T; description?: string }>
    ): Promise<T | undefined> {
      const first = options[0] as T | { value: T } | undefined;
      return typeof first === "string" ? first : first?.value;
    },
    async component(_title, _component, options) {
      return options?.actions?.[0]?.id;
    }
  };
}

function normalizeChoices<T extends string>(
  options: T[] | Array<{ label: string; value: T; description?: string }>
): Array<{ label: string; value: string; description?: string }> {
  return options.map((option) =>
    typeof option === "string"
      ? { label: option, value: option }
      : { label: option.label, value: option.value, description: option.description }
  );
}

function defaultComponentActions(component: CrewCoderExtUiComponent): CrewCoderExtUiAction[] {
  if (component.kind === "actionList") return sanitizeActions(component.actions);
  return [{ id: "close", label: "Close" }];
}

function sanitizeComponent(component: CrewCoderExtUiComponent): CrewCoderExtUiComponent {
  if (component.kind === "markdown") return { kind: "markdown", text: truncateText(component.text, MAX_COMPONENT_TEXT) };
  if (component.kind === "details") {
    return {
      kind: "details",
      items: component.items.slice(0, MAX_COMPONENT_ITEMS).map((item) => ({
        label: truncateText(item.label, MAX_COMPONENT_LABEL),
        value: truncateText(item.value, MAX_COMPONENT_VALUE)
      }))
    };
  }
  if (component.kind === "table") {
    const columns = component.columns.slice(0, MAX_COMPONENT_COLUMNS).map((column) => ({
      key: truncateText(column.key, MAX_COMPONENT_LABEL),
      label: truncateText(column.label, MAX_COMPONENT_LABEL)
    }));
    const columnKeys = new Set(columns.map((column) => column.key));
    return {
      kind: "table",
      columns,
      rows: component.rows.slice(0, MAX_COMPONENT_ROWS).map((row) => sanitizeRow(row, columnKeys))
    };
  }
  return { kind: "actionList", actions: sanitizeActions(component.actions) };
}

function sanitizeActions(actions: CrewCoderExtUiAction[]): CrewCoderExtUiAction[] {
  return actions.slice(0, MAX_COMPONENT_ACTIONS).flatMap((action) => {
    const id = truncateText(action.id, MAX_COMPONENT_LABEL).trim();
    if (!id) return [];
    return [{
      id,
      label: truncateText(action.label || id, MAX_COMPONENT_LABEL),
      description: action.description === undefined ? undefined : truncateText(action.description, MAX_COMPONENT_VALUE)
    }];
  });
}

function sanitizeRow(row: Record<string, string | number | boolean | null | undefined>, columnKeys: Set<string>): Record<string, string | number | boolean | null | undefined> {
  const result: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!columnKeys.has(key)) continue;
    result[key] = typeof value === "string" ? truncateText(value, MAX_COMPONENT_VALUE) : value;
  }
  return result;
}

function truncateText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function createExtensionUiBridge(options: { emit?: AgentEventSink; hasUI: boolean; signal?: AbortSignal }): ExtensionUiBridge {
  const { emit, hasUI, signal } = options;
  const pending = new Map<string, PendingRequest>();
  let counter = 0;

  const nextRequestId = (): string => `extui_${Date.now().toString(36)}_${(++counter).toString(36)}`;

  const request = (extensionId: string, payload: RequestPayload): Promise<ExtensionUiResponseValue> => {
    const requestId = nextRequestId();
    return new Promise<ExtensionUiResponseValue>((resolve) => {
      pending.set(requestId, { resolve });
      const onAbort = (): void => {
        if (pending.delete(requestId)) {
          void emit?.({ type: "extension_ui_resolved", requestId, cancelled: true });
          resolve(null);
        }
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      void emit?.({ type: "extension_ui_request", requestId, extensionId, ...payload });
    });
  };

  function uiFor(extensionId: string): CrewCoderExtUI {
    if (!hasUI || !emit) return fallbackUi();
    return {
      notify(message, level = "info") {
        void emit({ type: "extension_ui_notify", extensionId, message, level });
      },
      async confirm(title, message) {
        const value = await request(extensionId, { uiKind: "confirm", title, message });
        return value === true || value === "true";
      },
      async input(title, opts) {
        const value = await request(extensionId, {
          uiKind: "input",
          title,
          placeholder: opts?.placeholder,
          defaultValue: opts?.defaultValue
        });
        if (value === null || value === false) return undefined;
        return typeof value === "string" ? value : opts?.defaultValue;
      },
      async select<T extends string>(
        title: string,
        choices: T[] | Array<{ label: string; value: T; description?: string }>
      ): Promise<T | undefined> {
        const normalized = normalizeChoices(choices);
        const value = await request(extensionId, { uiKind: "select", title, options: normalized });
        if (typeof value !== "string") return undefined;
        return normalized.some((option) => option.value === value) ? (value as T) : undefined;
      },
      async component(title, component, opts) {
        const sanitizedComponent = sanitizeComponent(component);
        const actions = sanitizeActions(opts?.actions ?? defaultComponentActions(sanitizedComponent));
        const value = await request(extensionId, { uiKind: "component", title, message: opts?.message, component: sanitizedComponent, actions });
        if (typeof value !== "string") return undefined;
        return actions.some((action) => action.id === value) ? value : undefined;
      }
    };
  }

  function resolveResponse(requestId: string, value: ExtensionUiResponseValue): boolean {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    void emit?.({ type: "extension_ui_resolved", requestId, cancelled: false });
    entry.resolve(value);
    return true;
  }

  function hasPending(): boolean {
    return pending.size > 0;
  }

  function cancelAll(): void {
    for (const [requestId, entry] of pending) {
      void emit?.({ type: "extension_ui_resolved", requestId, cancelled: true });
      entry.resolve(null);
    }
    pending.clear();
  }

  return { uiFor, resolveResponse, hasPending, cancelAll };
}
