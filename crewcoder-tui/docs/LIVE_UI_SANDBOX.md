# Live UI Sandbox

The Live UI sandbox runs an extension's `contributes.liveUi[]` `entry` module in an
isolated `worker_threads` Worker, never in the main TUI process. The host exchanges
serializable JSON with the child and enforces a capability grant. This is the
runtime/sandbox boundary for experimental live custom UI components defined in
`crewcoder-agent/docs/LIVE_UI_COMPONENTS.md`.

This document describes the bridge layer shipped in `crewcoder-tui/src/bridge/`
(`live-ui-protocol.ts`, `live-ui-host.ts`, `live-ui-runtime.ts`). The _wiring_ that
mounts a live UI contribution from a manifest, gates it behind trust/config flags,
and composites rendered lines into the viewport is implemented in the companion
modules (`live-ui-gate.ts`, `live-ui-trust-gate.ts`, `live-ui-controller.ts`,
`live-ui-frame.ts`, `live-ui-registry.ts`) and consumed by `App.ts`,
`MainViewport.ts`, and `StatusBar.ts`; see
[Wiring and trust gate (Slice 1)](#wiring-and-trust-gate-slice-1).

## Architecture

```txt
TUI main process                         sandboxed child (worker_threads)
  ExtensionUiOverlay / MainViewport        extension entry module
        |            ^                            |          ^
        v            |                            v          |
  LiveUiHost (live-ui-host.ts)  --- init/mount/resize/update/focus/blur/input -->  runLiveUiComponent
        |            ^                                       (live-ui-runtime.ts)
        |            |  ready/rendered/handled_input/           |
        |            |  host_command/error                       |
        |            +-------------------------------------------+
        |                        structured-clone JSON only
  onReady/onRendered/onHandledInput/
  onHostCommand/onError/onExit
        |
  TUI surfaces (rendered lines, host_command dispatch)
```

Three modules for the sandbox boundary plus wiring modules for TUI integration:

| File | Role | Side |
| --- | --- | --- |
| `crewcoder-tui/src/bridge/live-ui-protocol.ts` | Wire-protocol types + pure validation/clamping helpers | shared (imported by both) |
| `crewcoder-tui/src/bridge/live-ui-host.ts` | `LiveUiHost` class that spawns and supervises the worker | host (main TUI process) |
| `crewcoder-tui/src/bridge/live-ui-runtime.ts` | `runLiveUiComponent` entry helper + pure `reduceLiveUiChild` reducer | child (worker thread) |
| `crewcoder-tui/src/bridge/live-ui-registry.ts` | `LiveUiInstanceRegistry` lifecycle tracker + dispose wiring hooks | host (main TUI process) |
| `crewcoder-tui/src/bridge/live-ui-gate.ts` | Policy evaluation + permission grant + spawn plan builder | host (main TUI process) |
| `crewcoder-tui/src/bridge/live-ui-trust-gate.ts` | Config gate + cross-component focus manager | host (main TUI process) |
| `crewcoder-tui/src/bridge/live-ui-controller.ts` | Wiring orchestrator: callbacks, frame compositing, lifecycle | host (main TUI process) |
| `crewcoder-tui/src/bridge/live-ui-frame.ts` | Virtual frame compositor + repaint scheduler | host (main TUI process) |
| `crewcoder-tui/src/components/App.ts` | Reads contributions, mounts live UI, dispatches input, drives dispose hooks | host (main TUI process) |
| `crewcoder-tui/src/components/MainViewport.ts` | Renders `live_ui` transcript blocks | host (main TUI process) |
| `crewcoder-tui/src/components/StatusBar.ts` | Shows focused live UI permissions chrome | host (main TUI process) |

The protocol is a decoupled TUI-side mirror of the agent contract in
`crewcoder-agent/src/extensions/types.ts:181-200`. It is duplicated on purpose: the
TUI runs the host in its own process and only structured-clone-safe JSON crosses the
worker boundary. No functions, class instances, `AbortSignal`, terminal handles, or
direct TUI objects may cross.

## Wire protocol

Protocol version is `"0.1"`. Two transports are declared in the type system
(`"stdio-jsonl" | "worker-postmessage"`); the shipped host uses
`"worker-postmessage"`. `"stdio-jsonl"` is reserved for a future child-process
sandbox and is not constructed anywhere yet.

### Host -> child

```ts
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
| { type: "dispose" }
```

`init` is posted automatically by `LiveUiHost.spawn()` along with the already-granted
`host.permissions` and `host.limits`. The child is expected to reply `ready` before
any lifecycle/`input` message is accepted.

Lifecycle is explicit. The old `render` message (which doubled as mount+resize) has
been split into separate `mount` and `resize` events, and `update` was added:

| Message | Meaning | Host method | Child reply |
| --- | --- | --- | --- |
| `mount` | first frame at the initial size | `sendMount(w, h)` | `rendered` |
| `resize` | surface size changed after mount | `sendResize(w, h)` | `rendered` |
| `update` | fresh immutable props snapshot; re-render at last known size | `sendUpdate(props)` | `rendered` |
| `focus` | instance took keyboard focus | `focus()` | — (lifecycle only) |
| `blur` | instance lost keyboard focus | `blur()` | — (lifecycle only) |
| `viewport` | visible scroll range changed | `sendViewport(offset, height)` | — (lifecycle only) |
| `dispose` | tear the instance down | `dispose()` | — (worker terminated) |

`mount`, `resize`, and `update` are **render-producing** (`isLiveUiRenderProducing`):
each expects exactly one `rendered` reply, which is what the host's timeout and
backpressure logic keys off of. `focus`/`blur` are lifecycle-only and produce no
frame. The child (`reduceLiveUiChild`) keeps the last size and re-renders on
`update`, and invokes the optional `onMount` / `onResize` / `onUpdate` / `onFocus` /
`onBlur` / `onDispose` component hooks.

### Child -> host

```ts
| { type: "ready"; instance: CrewCoderLiveUiInstance }
| { type: "rendered"; frame: LiveUiFrame; scrollHeight?: number }
| { type: "handled_input"; handled: boolean }
| { type: "host_command"; command: CrewCoderLiveUiHostCommand }
| { type: "error"; message: string }
```

Host commands the child may request:

```ts
| { type: "notify"; message: string; level?: "info" | "success" | "warning" | "error" }
| { type: "resolve_ui_request"; requestId: string; value: string | boolean | null }
| { type: "request_repaint" }
| { type: "read_session_state"; requestId: string; key: string }
| { type: "write_session_state"; key: string; value: CrewCoderLiveUiJsonValue }
| { type: "read_clipboard"; requestId: string }
| { type: "network_fetch"; requestId: string; url: string; options?: { method?: string; headers?: Record<string, string>; body?: string } }
```

`parseLiveUiHostMessage` / `parseLiveUiChildMessage` narrow untrusted
structured-clone values into these shapes; anything malformed is dropped silently
(returns `undefined`). Only `notify` and `request_repaint` are unconditionally
allowed; every other host command is gated by a capability check.

## Input isolation

Live UI input is focus-scoped. `LiveUiHost.sendInput` only forwards keyboard or
mouse events after that host has a ready instance, `focus()` has been called, the
instance reports `canReceiveInput`, and the `ui: ["input"]` grant is present.
`LiveUiTrustGate` owns cross-component focus and blurs the previous host before
focusing a new contribution, so only one live component receives input at a time.

Focus changes send `{ type: "focus", focusInfo }` and `{ type: "blur", focusInfo }`
to the child. `focusInfo` includes `instanceId`, `extensionId`, `contributionId`,
and a default title of `extensionId/contributionId`; the TUI render wiring should
use it to draw the active border/title.

The child must answer every forwarded input with `{ type: "handled_input" }`. The
host pairs that reply with the pending event and calls `onInputHandled`; when
`handled` is `false`, it also calls `onUnhandledInput` so the wiring layer can fall
through to normal TUI handlers.

Global TUI escape hatches are reserved and are never forwarded to children:
`Esc`, `Ctrl+C`, `Ctrl+P`, `Ctrl+I`/Tab, and `Ctrl+O`. This prevents a focused live
component from trapping command palette, abort/close, process interrupt, agent
picker, or viewport tool-output shortcuts.

## Capability grants

`host.permissions` is the **already-validated** manifest `permissions` object. The
bridge does not re-derive it from a raw request — the wiring layer (Slice 1) is
responsible for running the trust gate and handing the host a grant. Deny-by-default
is encoded by treating missing capabilities as falsy.

| Capability | Grants | Enforced by |
| --- | --- | --- |
| `ui: ["render"]` | receive render frames | implicit (render is always sent once ready) |
| `ui: ["input"]` | receive keyboard and mouse input while focused | `canSendLiveUiInput` -> `LiveUiHost.focus` / `LiveUiHost.sendInput` |
| `ui: ["focus"]` | declare focus intent on the instance | exposed through `focusInfo`; current host focus still requires `input` because focused input is the only interactive lifecycle in this slice |
| `commands: ["ui_response"]` | `resolve_ui_request` host command | `isLiveUiHostCommandAllowed` |
| `storage: "session"` | `read_session_state` / `write_session_state` host commands, plus `LiveUiHost.provideSessionState` | `isLiveUiHostCommandAllowed` + `provideSessionState` |
| `clipboard` | `read_clipboard` host command; answered by `LiveUiHost.provideClipboardText` | `isLiveUiHostCommandAllowed` |
| `network` | `network_fetch` host command; answered by `LiveUiHost.provideNetworkResponse` | `isLiveUiHostCommandAllowed` + allowed-hosts check |
| `events` | declared in the type; no host command exercises it yet | n/a |

Notes on divergence from the proposal in `LIVE_UI_COMPONENTS.md`:

- The proposal lists a `transport: "stdio-jsonl"` example; the shipped `CrewCoderLiveUiHost` carries `transport: "worker-postmessage"` in tests and the default factory. The type still allows either value.
- `ui:focus` is part of the manifest/permission shape and is surfaced as `focusInfo` for the rendering layer; the host still requires `ui:input` before forwarding interactive events.
- `clipboard` and `network` permission fields are enforced by `isLiveUiHostCommandAllowed` and answered through `LiveUiHost.provideClipboardText` / `provideNetworkResponse`. `events` is still declared but not consumed by any host command in this slice.

## Worker isolation

`LiveUiHost` never executes the `entry` module in the main TUI process. The default
factory (`defaultLiveUiWorkerFactory`) constructs a `node:worker_threads` `Worker`:

```ts
new Worker(entryPath, { workerData: { props, host }, env: {} });
```

Isolation properties:

- **Empty environment.** `buildLiveUiWorkerOptions` returns `env: {}`, so the child
  inherits none of `process.env`. Filesystem/process access is not implicitly granted
  through environment configuration. Verified by
  `crewcoder-tui/src/tests/live-ui-host.test.ts` ("starves the worker of the parent
  environment").
- **Serializable data only.** `buildLiveUiWorkerData` hands the worker exactly
  `{ props, host }`; the init test asserts the payload is `structuredClone`-safe.
- **No direct handles.** The `LiveUiWorkerLike` surface the host depends on is just
  `postMessage` / `on` / `terminate`; no terminal, stdin, or TUI objects are passed.
- **Injectable factory.** `LiveUiHost` accepts a `LiveUiWorkerFactory` so tests
  substitute a `FakeWorker` instead of spawning a real thread.

The child side (`live-ui-runtime.ts`) is written so its core logic is a pure
reducer (`reduceLiveUiChild`) that returns `{ state, replies }` without side effects.
`runLiveUiComponent` is the thin entry point that wires `parentPort` messages to the
reducer and posts replies back; it throws if called outside a worker.

## Crash containment

There is no separate "crash containment" file; containment is embedded across the
host and runtime. A misbehaving or crashing child must not bring down the TUI.

| Failure mode | Containment |
| --- | --- |
| Worker throws / crashes | `worker.on("error")` -> `onError(message)` callback; host stays alive |
| Worker exits | `worker.on("exit")` -> `instance` cleared, `onExit(code)` callback; `host.ready` becomes false |
| Child sends malformed message | `parseLiveUiChildMessage` returns `undefined`, host drops it |
| Child sends ungranted host command | `isLiveUiHostCommandAllowed` denies it; `onError` is called with a message naming the command type and extension id; command is not forwarded |
| Child floods rendered output | `clampLiveUiFrame` caps `maxRenderLines`, `maxLineLength`, and `maxPayloadBytes` (byte budget) — applied **both** in the host (`handleChildMessage` -> `onRendered`) and the child (`reduceLiveUiChild` render path), so a misbehaving child cannot flood the host even if it ignores its own limits |
| Mount/resize/update/focus/input arrives before `ready`/`init` | host refuses `sendMount`/`sendResize`/`sendUpdate`/`focus`/`sendInput` until `instance` is set; child reducer returns `{ type: "error", message: "...before init" }` |
| Slow/hung child (render-producing request) | each `mount`/`resize`/`update` arms a `renderTimeoutMs` timer; on expiry `onRenderTimeout(request)` fires and the in-flight slot is released (`disposeOnTimeout: true` hard-stops the worker). See [Render timeouts and backpressure](#render-timeouts-and-backpressure). |
| Child floods render-producing requests | only one render request is in flight at a time; the rest queue, consecutive resizes coalesce, and the queue is capped at `maxPendingRenders` (oldest dropped via `onBackpressureDrop`) |
| Host calls `dispose` twice | idempotent: `disposed` flag set, worker reference cleared, `terminate()` called once |

Teardown order on `dispose()`: post `{ type: "dispose" }` (best-effort, swallow
errors if the worker is already gone), then `worker.terminate()`. The child reducer
marks `state.disposed = true` on `dispose` and emits no replies; `runLiveUiComponent`
also calls `port.close?.()` after dispose.

## Lifecycle

The current protocol implements
`init / mount / resize / update / focus / blur / input / session_state / dispose`.
`mount` and `resize` are the split successors of the old `render` message. Instance
identity is a `randomUUID` generated in the child at `runLiveUiComponent` time
(overridable via `idFactory` for tests).

`LiveUiHost` tracks a coarse lifecycle phase
(`idle -> spawning -> ready -> mounted -> disposed`, or `exited` on worker exit),
exposed via `host.lifecyclePhase` and the `onLifecycle(phase, instance)` callback,
plus read-only `host.extensionId` / `host.contributionId` / `host.surface` identity.

### Instance tracking and dispose wiring

`LiveUiInstanceRegistry` (`live-ui-registry.ts`) is the wiring-layer hook that
guarantees `dispose()` fires on the boundaries a sandboxed worker must never
outlive. The wiring layer `register({ key, host, blockId })`s each mounted instance
and calls the matching hook when a boundary is crossed:

| Boundary | Hook | Default reason |
| --- | --- | --- |
| transcript block scrolls out of retention | `disposeByBlock(blockId)` | `scroll_away` |
| overlay/surface closes | `disposeBySurface(surface)` | `overlay_close` |
| session ends | `disposeAll()` | `session_end` |
| extension unloads | `disposeByExtension(extensionId)` | `extension_unload` |

`LiveUiHost` satisfies the registry's `LiveUiTrackable` interface, so the same host
that the trust gate spawns can be tracked directly. The registry deletes the entry
before awaiting `dispose()` and routes failures to `onError` so one wedged worker
cannot block teardown of the rest. Connecting these hooks to real TUI scroll/overlay/
session/extension events is Slice 1 wiring (see below).

Session state is opt-in via `storage: "session"`:

- Child requests `read_session_state` / `write_session_state` host commands (gated
  by the storage grant).
- Host answers reads with `LiveUiHost.provideSessionState(requestId, value?)`, which
  also requires `storage === "session"`.
- `session_state` host->child carries the value back by `requestId`.

## Render timeouts and backpressure

Render-producing requests (`mount`, `resize`, `update`) are supervised so a slow or
hung child cannot make the host wait indefinitely. Configuration is passed as the
optional 4th `LiveUiHost` constructor argument (`Partial<LiveUiHostConfig>`):

| Field | Default | Effect |
| --- | --- | --- |
| `renderTimeoutMs` | `2000` | deadline for the `rendered`/`error` reply to the in-flight request |
| `maxPendingRenders` | `8` | max render requests buffered behind the in-flight one |
| `disposeOnTimeout` | `false` | when `true`, a timeout hard-stops the worker via `dispose()` |
| `timers` | real `setTimeout`/`clearTimeout` | injectable clock so timeouts are unit-testable |

Mechanics:

- **Single in-flight request.** At most one render-producing message is on the wire.
  Others queue; `host.pendingRenderCount` reports queue depth plus the in-flight one.
- **Coalescing.** Consecutive `resize` requests collapse to the latest (a resize
  burst never floods the child). `update` and `mount` are preserved in order so prop
  changes are never lost.
- **Queue cap.** When the queue exceeds `maxPendingRenders`, the oldest queued
  request is dropped and reported via `onBackpressureDrop(request)`.
- **Timeout.** Each in-flight request arms a `renderTimeoutMs` timer. On expiry,
  `onRenderTimeout(request)` fires; the in-flight slot is released so the queue keeps
  draining, unless `disposeOnTimeout` is set, in which case the worker is torn down.
- **Reply/error settle.** A `rendered` reply (or a child `error` while a request is
  in flight) clears the timer and pumps the next queued request.

`dispose()` and worker `exit` both clear the timer, drain the queue, and drop the
in-flight request.

## Testing and operational notes

Regression tests (run from the monorepo root):

```bash
npm test -w @onpoint-dev-tools/crewcoder-tui
```

Relevant suites:

```txt
crewcoder-tui/src/tests/live-ui-protocol.test.ts  -> clamping, capability checks, message parsing, render-producing flag, viewport + scrollHeight parsing
crewcoder-tui/src/tests/live-ui-host.test.ts      -> lifecycle phases, outbound gating, capability enforcement, render timeout + backpressure, teardown, worker isolation helpers, viewport messages
crewcoder-tui/src/tests/live-ui-runtime.test.ts   -> pure child reducer (init/mount/resize/update/focus/blur/input/dispose/error-before-init)
crewcoder-tui/src/tests/live-ui-registry.test.ts  -> instance registry dispose hooks (scroll-away/overlay-close/session-end/extension-unload)
crewcoder-tui/src/tests/live-ui-gate.test.ts      -> trust evaluation, permission grants, match rules including toolNames/toolIds
crewcoder-tui/src/tests/live-ui-frame.test.ts     -> virtual frame compositing, scroll offset slicing, byte budget
crewcoder-tui/src/tests/live-ui-controller.test.ts -> spawn, focus, input, scroll offset, crash fallback
crewcoder-tui/src/tests/app-live-ui.test.ts       -> contribution loading, extension_ui_request mounting, tool_execution_end inline renderers, wheel scrolling
```

The host and runtime tests use a `FakeWorker` and the pure reducer respectively, so
they run without a real `worker_threads` thread. End-to-end tests that spawn a real
`Worker` against a fixture `entry` module are still pending.

Operational expectations once wiring exists:

- Rendered lines, focus metadata, and host commands arrive through `LiveUiHostCallbacks` (`onRendered`,
  `onFocusChange`, `onHostCommand`, ...). The wiring layer is responsible for compositing `onRendered`
  lines into the target surface, drawing a focused border/title from `focusInfo`
  (`extensionId/contributionId`), and routing `onHostCommand` (e.g. `resolve_ui_request`
  back to the bridge, `notify` to a status/log block, `request_repaint` to the
  scheduler). The host module deliberately does not touch the overlay/viewport or
  input paths.
- `onError` / `onExit` should render a fallback error block and tear down the host's
  UI presence; that fallback rendering is part of Slice 1, not this slice.
- `dispose()` must be called when the overlay closes, the block scrolls away, the
  session ends, or the extension unloads, to guarantee the worker is terminated.
  `LiveUiInstanceRegistry` provides the hooks for these boundaries; the wiring layer
  registers each mounted instance and invokes the matching `disposeBy*` call when the
  corresponding TUI event fires.

## Wiring and trust gate (Slice 1)

The TUI wiring layer lives in `crewcoder-tui/src/bridge/live-ui-gate.ts`,
`live-ui-trust-gate.ts`, `live-ui-controller.ts`, `live-ui-frame.ts`, and is
consumed by `crewcoder-tui/src/components/App.ts` and
`crewcoder-tui/src/components/StatusBar.ts`.

- **Trust gate.** `LiveUiTrustGate` enforces the `allowExtensionLiveUi` config flag
  and owns cross-component focus (`focusHost`, `blurCurrent`/`blurFocusedHost`,
  `getFocusedHost`, `sendInputToFocusedHost`, `isTrusted`). The stricter policy
  evaluation (extension enabled, trusted, `experimental: true`, supported surface,
  render permission, entry module present) is performed by `evaluateTuiLiveUiGate` in
  `live-ui-gate.ts` before a spawn plan is built. `grantLiveUiPermissions` intersects
  the requested manifest permissions with what the host actually supports, so the
  grant handed to the worker is always a subset of the request.
- **Manifest consumption.** `App.loadLiveUiContributions()` calls
  `listCrewCoderLiveUiContributions()` and stores the validated contribution list in
  `state.liveUiContributions`. `App.tryMountLiveUiFromExtensionEvent()` matches an
  incoming `extension_ui_request` against modal/status contributions and, if the gate
  passes, pushes a `live_ui` block and calls `LiveUiController.mount()`. Transcript
  contributions are intentionally excluded from generic requests; they mount only
  when anchored after a matching completed tool block.
- **Host instantiation.** `LiveUiController.mount()` spawns a `LiveUiHost` through
  `LiveUiTrustGate.spawnHost()`, registers it with `LiveUiInstanceRegistry`, and
  wires all host callbacks (`onReady`, `onRendered`, `onFocusChange`,
  `onInputHandled`, `onHostCommand`, `onError`, `onExit`).
- **Render/input composite.** `App.refreshLiveUiFrames()` composites each `live_ui`
  block through `LiveUiController.frame()` into `state.liveUiFrames`, which
  `MainViewport.renderLiveUi()` blits into the transcript. `surface: "modal"` renders
  as a focused transcript block; `surface: "transcript"` renders inline. Status
  surfaces are special-cased: `LiveUiController.frame(..., { boxed: false })` returns
  sanitized content lines without the host box, and `StatusBar.render()` paints those
  lines into the status bar chrome when `state.liveUiFocus.surface === "status"` and
  a frame exists, falling back to the LIVE-UI pill otherwise. `MainViewport` skips
  rendering `surface: "status"` blocks so they do not appear twice.
- **Input forwarding.** `App.handleInput()` routes keyboard and mouse events to the
  focused live UI host via `liveUiController.sendInput()`. Mouse coordinates are
  converted from terminal coordinates to frame-relative coordinates: status surfaces
  use the status bar origin; viewport-anchored surfaces use the viewport origin.
  Unhandled input (`handled: false`) falls back through
  `LiveUiControllerCallbacks.onUnhandledInput` -> `App.dispatchInputWithoutLiveUi()`.
  Surface resize is wired in `refreshLiveUiFrames()` via `liveUiController.resize()`.
- **Activation/match rules.** `App.tryMountLiveUiFromExtensionEvent()` evaluates each
  modal/status candidate contribution's `activation.events` and `match.eventTypes` /
  `match.extensionIds` / `match.uiKinds` / `match.componentKinds` against the incoming
  event payload before building a spawn plan. Modal/status contributions with no rules
  still match any `extension_ui_request` for backward compatibility. Transcript
  contributions use the separate completed-tool matching path described below.
- **Crash-fallback UI.** `LiveUiController.frame()` returns a host-styled fallback
  frame for `error`/`exited` states. `MainViewport.renderLiveUi()` also renders an
  error block when `block.status` is `error` or `exited`.
- **Lifecycle dispose wiring.** `LiveUiInstanceRegistry` hooks are driven from real
  TUI events:
  - `disposeAll("session_end")` on session resume (`App.resumeSelectedSession`) and
    new session (`App.startNewSession`).
  - `disposeByBlock(blockId, "overlay_close")` when an `extension_ui_request` is
    resolved/cancelled (`App.disposeLiveUiByRequestId`).
  - `disposeByBlock(blockId, "scroll_away")` via `App.pruneLiveUiBlocks()` whenever
    an event is applied and a tracked `live_ui` block is no longer in
    `state.blocks`.
  - `disposeByExtension(extensionId, "extension_unload")` via
    `App.unloadLiveUiExtension(extensionId)` for callers that detect extension
    unload (the TUI currently reloads contributions during `/reload`; a future
    extension unload event can call this method).
- **ExtensionUiOverlay integration.** Live UI `modal` surfaces are intentionally
  kept separate from `ExtensionUiOverlay`. `ExtensionUiOverlay` handles declarative
  `confirm`/`input`/`select`/`component` requests that resolve to a single value;
  live UI `modal` surfaces are sandboxed workers that render live frames and may
  receive ongoing input. A modal live UI block is pushed into the transcript when
  an `extension_ui_request` matches a contribution, and it is disposed when the
  request resolves. This avoids mixing the synchronous request/response model of
  `ExtensionUiOverlay` with the long-running worker model of live UI.

## Scrollable frames

Live UI surfaces can scroll when a child reports a virtual height larger than the
viewport it was assigned. Scrolling is cooperative: the child proposes a total
`scrollHeight`, the host owns the current `scrollOffset`, and only the visible slice
is composited into the terminal frame.

Protocol pieces:

- `rendered` may include `scrollHeight?: number`. This is the child's total content
  height in rows; it may be larger than `frame.height`.
- The host sends `{ type: "viewport", scrollOffset: number, viewportHeight: number }`
  whenever the visible range changes. The child can use this to render a windowed
  frame on the next `mount`/`resize`/`update`.

Host pieces:

- `LiveUiHost.sendViewport(offset, height)` posts the message to the worker.
- `LiveUiInstanceState` tracks `scrollOffset` and `scrollHeight` in
  `LiveUiController`.
- `LiveUiController.scrollFocused(delta)` clamps the new offset to
  `[0, scrollHeight - viewportHeight]` and sends a `viewport` message to the focused
  instance.
- `compositeLiveUiLines` slices the content lines by `scrollOffset` before padding
  and boxing, so the host chrome (border + title) stays fixed while the content
  scrolls.

Input wiring:

- `App.handleInput` intercepts `wheelup` / `wheeldown`. When a live UI instance has
  focus, `liveUiController.scrollFocused(-3)` / `scrollFocused(3)` is called and the
  event is consumed. When no live UI is focused, the wheel event falls through to
  the normal viewport/input path.

## Inline tool-block renderers

A live UI contribution with `target.surface: "transcript"` can render inline after a
tool block when it matches the tool that just finished. This is triggered by the
`tool_execution_end` event, not by an explicit extension request.

Matching rules:

- `match.toolNames?: string[]` matches the tool name from the event and tool block.
- `match.toolIds?: string[]` matches the `toolCallId` when one is present.
- The usual `activation.events` / `match.eventTypes` rules also apply, so a
  contribution can require `event.type === "tool_execution_end"`.

Only `surface: "transcript"` contributions are eligible for tool-block rendering;
`modal` and `status` contributions are ignored for this trigger.

Wiring in `App.ts`:

- `handleCrewCoderEvent` detects `tool_execution_end` and calls
  `tryMountLiveUiForToolBlock(event)`.
- The method scans backward for the finalized `tool` block (matching by
  `toolCallId` when available, otherwise by `toolName`).
- The tool block's `args`, result text, status, and metadata are folded into the
  immutable `props.event.metadata` so the child can render context-aware output.
- The matched contribution is inserted into `state.blocks` immediately after the
  tool block via `splice(toolIndex + 1, 0, live_ui_block)`, and
  `LiveUiController.mount()` starts the worker.
- `MainViewport.renderLiveUi` skips `surface: "status"` blocks and blits the
  composited frame for transcript blocks at full viewport width.

Remaining gaps:

- `events` permission field is declared in the type but exercised by no host command
  in this slice.
- `"stdio-jsonl"` transport is typed but never constructed; only the
  `worker-postmessage` path is implemented.

## Gaps

- The explicit lifecycle model (`mount`/`resize`/`update`/`focus`/`blur`/`dispose`),
  per-instance tracking, and render timeout/backpressure are implemented and driven
  by real TUI events (session/overlay/scroll boundaries, viewport resize, and
  keyboard focus). End-to-end tests that spawn a real `Worker` against a fixture
  `entry` module are still pending.
- `events` permission field is declared in the type but exercised by no host command
  in this slice.
- `"stdio-jsonl"` transport is typed but never constructed; only the
  `worker-postmessage` path is implemented.