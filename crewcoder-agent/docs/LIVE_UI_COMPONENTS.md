# Live custom UI components

Live custom UI components are an **experimental** extension capability for UI that cannot be represented by the existing declarative component schemas. Declarative components remain the default and preferred path:

- `ctx.ui.component(...)` data-only components (`markdown`, `details`, `table`, `actionList`) are safe by default and execute no extension UI code.
- `contributes.ui[]` renderer templates are string-only and non-interactive.
- `contributes.liveUi[]` is opt-in and experimental. The agent validates/lists declarations, while `crewcoder-tui` loads approved entries in isolated `worker_threads` workers.

This document defines the extension-facing manifest and serializable API boundary. Runtime wiring, lifecycle, compositing, and tests are documented in `../../crewcoder-tui/docs/LIVE_UI_SANDBOX.md`.

## Manifest shape

```jsonc
{
  "contributes": {
    "liveUi": [
      {
        "id": "review-panel",
        "title": "Review Panel",
        "description": "Interactive review controls for review-summary events.",
        "experimental": true,
        "entry": "ui/review-panel.ts",
        "target": {
          "surface": "modal",
          "slot": "extension-ui"
        },
        "activation": {
          "events": ["extension_ui_request"],
          "modes": ["tui"],
          "commands": ["ext.review-pack.review"],
          "filePatterns": ["**/*.ts"]
        },
        "match": {
          "eventTypes": ["extension_ui_request"],
          "uiKinds": ["component"],
          "extensionIds": ["review-pack"],
          "componentKinds": ["table", "details"]
        },
        "permissions": {
          "ui": ["render", "input", "focus"],
          "events": ["read:extension_ui_request"],
          "commands": ["ui_response"],
          "clipboard": "none",
          "network": { "allowedHosts": [] },
          "storage": "none"
        }
      }
    ]
  }
}
```

### Fields

| Field | Required | Contract |
| --- | --- | --- |
| `id` | Yes | Stable contribution id, unique inside the extension. Use letters, numbers, dots, underscores, or dashes. |
| `title` | Yes | Human-readable label shown anywhere CrewCoder warns that experimental live UI is active. |
| `description` | No | User-facing explanation of what the component does. |
| `experimental` | Yes | Must be `true`. Hosts must reject or ignore live UI entries without this marker. |
| `entry` | Yes | Extension-relative TypeScript/JavaScript UI module path. Must stay inside the extension directory. This is separate from manifest `main`. |
| `target.surface` | Yes | Target UI surface: `modal`, `transcript`, or `status`. |
| `target.slot` | No | Surface-specific placement hint. Initial reserved slots: `extension-ui`, `tool-result`, `session-status`. Hosts may ignore unsupported slots. |
| `activation` | No | Coarse gate for when the live component is relevant. Mirrors extension activation concepts and never loads code by itself. |
| `match` | Yes | Fine-grained rule checked against the current UI/event payload before a host even considers loading the live entry. |
| `permissions` | Yes | Explicit capability request. Missing permissions mean deny-by-default. |

## Target surfaces

Live UI should map to existing TUI concepts instead of inventing hidden surfaces:

- `modal`: focused popover/overlay, matching the current `ExtensionUiOverlay` and approval overlay flow. Best for interactive prompts.
- `transcript`: a block inside the main viewport history. Best for tool results, extension UI request summaries, or durable read-only views.
- `status`: compact session/status area. Best for passive state only; no keyboard focus by default.

Declarative rendering should cover most `transcript` and `modal` use cases. Live UI is reserved for components needing local state, advanced keyboard handling, progressive rendering, or host-mediated actions that declarative schemas cannot express.

## Activation and match rules

`activation` is a cheap relevance filter:

```ts
type LiveUiActivation = {
  events?: string[];
  modes?: Array<"tui">;
  commands?: string[];
  filePatterns?: string[];
};
```

`match` is the UI/event-specific filter:

```ts
type LiveUiMatch = {
  eventTypes?: string[];
  toolNames?: string[];
  extensionIds?: string[];
  toolIds?: string[];
  renderers?: string[];
  uiKinds?: Array<"confirm" | "input" | "select" | "component">;
  componentKinds?: Array<"markdown" | "details" | "table" | "actionList">;
};
```

A host should only consider a live entry when both `activation` and `match` pass. Matching does not grant permission and does not require loading the `entry` file.

## Permission model

Live UI is denied unless all gates pass:

1. The extension is enabled.
2. The extension id is in `trustedExtensions`.
3. The explicit host setting `allowExtensionLiveUi=true` is enabled.
4. The contribution has `experimental: true`.
5. The target surface is supported by the host.
6. The requested permissions are supported and approved by policy.
7. The activation/match rules pass for the current payload.

Permission object:

```ts
type LiveUiPermissions = {
  ui?: Array<"render" | "input" | "focus">;
  events?: Array<`read:${string}`>;
  commands?: Array<"ui_response" | `ext.${string}`>;
  clipboard?: "none" | "write";
  network?: { allowedHosts: string[] };
  storage?: "none" | "session";
};
```

Rules:

- `ui:render` is required for every live component.
- `ui:input` is required before the component can receive keyboard input.
- `ui:focus` is required before the component can take modal focus.
- `commands: ["ui_response"]` is required before the component can resolve an `extension_ui_request`.
- Network is off by default and must be host allow-listed by hostname.
- Clipboard is off by default; supported grants are `none`, `read`, or `write`, and host commands remain permission-checked.
- Storage is off by default; `session` means bounded, extension-scoped session state only.
- No permission grants direct filesystem, process, shell, environment, or arbitrary Node API access.

## Extension-facing API boundary

Before loading `entry`, the host applies a narrow API boundary. These exported types are intentionally serializable and process-friendly: no callbacks, class instances, `AbortSignal`, terminal handles, or direct TUI objects cross the boundary. A child-process sandbox can implement the contract over stdio JSONL.

Proposed module/process contract:

```ts
export type CrewCoderLiveUiSurface = "modal" | "transcript" | "status";
export type CrewCoderLiveUiJsonPrimitive = string | number | boolean | null;
export type CrewCoderLiveUiJsonValue =
  | CrewCoderLiveUiJsonPrimitive
  | CrewCoderLiveUiJsonValue[]
  | { [key: string]: CrewCoderLiveUiJsonValue };

export type CrewCoderLiveUiProps = {
  extensionId: string;
  contributionId: string;
  surface: CrewCoderLiveUiSurface;
  slot?: string;
  event: {
    type: string;
    requestId?: string;
    uiKind?: "confirm" | "input" | "select" | "component";
    title?: string;
    message?: string;
    component?: CrewCoderLiveUiJsonValue;
    metadata?: { [key: string]: CrewCoderLiveUiJsonValue };
  };
};

export type CrewCoderLiveUiHost = {
  protocolVersion: "0.1";
  transport: "worker-postmessage" | "stdio-jsonl";
  permissions: LiveUiPermissions;
  limits: {
    maxRenderLines: number;
    maxLineLength: number;
    maxPayloadBytes: number;
  };
};

export type CrewCoderLiveUiFocusInfo = {
  instanceId: string;
  extensionId: string;
  contributionId: string;
  title: string; // default: `${extensionId}/${contributionId}`
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
```

Host-to-child messages are JSON objects such as:

```ts
| { type: "init"; props: CrewCoderLiveUiProps; host: CrewCoderLiveUiHost }
| { type: "mount"; width: number; height: number }
| { type: "resize"; width: number; height: number }
| { type: "update"; props: CrewCoderLiveUiProps }
| { type: "focus"; focusInfo: CrewCoderLiveUiFocusInfo }
| { type: "blur"; focusInfo: CrewCoderLiveUiFocusInfo }
| { type: "input"; event: { name: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; mouse?: { x: number; y: number; button: number; kind: "press" | "drag" | "release" | "wheel" } } }
| { type: "session_state"; requestId: string; value?: CrewCoderLiveUiJsonValue }
| { type: "dispose" }
```

Lifecycle is explicit. `mount` delivers the first frame at the initial size,
`resize` reports a later size change, and `update` swaps in a fresh immutable props
snapshot; these three are "render-producing" and each expects one `rendered` reply
(the earlier `render` message that doubled as mount+resize has been split). `focus`/
`blur` toggle keyboard ownership and produce no frame. The host owns lifecycle: it
supervises render-producing requests with a per-request timeout and single-in-flight
backpressure, and guarantees `dispose` when a block scrolls away, an overlay closes,
the session ends, or the extension unloads.

Child-to-host messages are JSON objects such as:

```ts
| { type: "ready"; instance: CrewCoderLiveUiInstance }
| { type: "rendered"; lines: string[] }
| { type: "handled_input"; handled: boolean }
| { type: "host_command"; command: { type: "notify"; message: string } }
| { type: "error"; message: string }
```

Boundary requirements:

- Props are immutable JSON snapshots. The live component cannot subscribe to raw agent internals.
- Host capabilities are represented as granted permissions and JSON host commands, never direct functions.
- Render output is bounded to the provided width/height and sanitized before compositing.
- Input events are routed only to the focused live component. The host must blur the previously focused component before focusing another contribution.
- The host sends `focus`/`blur` lifecycle messages and exposes `focusInfo` so the TUI can draw a focused border/title with the extension id and contribution id.
- The component must return `handled_input` for every forwarded input; `handled: false` allows the host wiring to fall through to normal TUI handlers.
- Global TUI escape hatches are reserved and must not be forwarded to live UI code, including `Esc`, abort/interrupt shortcuts, command palette shortcuts, and approval/navigation shortcuts.
- The component must support disposal through the message protocol; the host owns lifecycle and cancellation, including render timeouts and disposal on scroll-away/overlay-close/session-end/extension-unload.
- Live UI cannot import CrewCoder internals, mutate `TuiState`, or call bridge/process APIs directly.

## Runtime status

`contributes.liveUi[]` is implemented experimentally by `crewcoder-tui`. The shipped host uses isolated workers with `env: {}`, structured-clone-only messages, bounded frames, one render request in flight, timeout/backpressure handling, focus-scoped input, capability-checked host commands, and lifecycle disposal on overlay close, scroll-away, session end, and extension unload. Modal, transcript/tool, and status surfaces are wired. Entries remain inert unless every trust and permission gate passes.

Known limits: only `worker-postmessage` is constructed today; `stdio-jsonl` remains reserved, the declared `events` permission has no host command, and a real-worker fixture integration test is still pending. See the TUI sandbox guide for the authoritative implementation details.
