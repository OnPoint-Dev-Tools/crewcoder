# AGENTS.md

## Project

This package is `@crewcode/crewcoder-tui`.

It is the custom terminal UI for CrewCoder.

DISCLAIMER:
crewcoder and crewcode are 2 different apps, CrewCoder harness has knowledge and plugin logic for crewcode, but everything else is for 'CrewCoder or crewcoder' dont get it confused, if you in doubt double check with me

Architecture:

```txt
Component interface
  -> component tree
  -> renderer
  -> overlay manager
  -> input router
  -> CrewCoder JSON event bridge
```

## Project structure

```txt
crewcoder-tui/
├── AGENTS.md
├── README.md
├── package.json
├── tsconfig.json
├── docs/
│   └── LIVE_UI_SANDBOX.md
├── src/
│   ├── cli.ts
│   ├── bridge/
│   │   ├── crewcoder-process.ts
│   │   ├── event-parser.ts
│   │   ├── live-ui-controller.ts
│   │   ├── live-ui-frame.ts
│   │   ├── live-ui-gate.ts
│   │   ├── live-ui-host.ts
│   │   ├── live-ui-protocol.ts
│   │   ├── live-ui-registry.ts
│   │   ├── live-ui-runtime.ts
│   │   └── live-ui-trust-gate.ts
│   ├── components/
│   │   ├── App.ts
│   │   ├── CommandPalette.ts
│   │   ├── Composer.ts
│   │   ├── EffortOverlay.ts
│   │   ├── ExtensionUiErrorBlock.ts
│   │   ├── ExtensionUiOverlay.ts
│   │   ├── Header.ts
│   │   ├── MainViewport.ts
│   │   ├── PickerOverlay.ts
│   │   ├── SessionsOverlay.ts
│   │   ├── Spinner.ts
│   │   ├── StatusBar.ts
│   │   ├── logo-banner.ts
│   │   ├── markdown-renderer.ts
│   │   ├── modal-view.ts
│   │   └── path-suggestions.ts
│   ├── state/
│   │   ├── effort-levels.ts
│   │   ├── event-reducer.ts
│   │   ├── tui-store.ts
│   │   └── usage.ts
│   ├── tests/
│   │   ├── app-home.test.ts
│   │   ├── app-input.test.ts
│   │   ├── app-live-ui.test.ts
│   │   ├── app-why.test.ts
│   │   ├── composer-history.test.ts
│   │   ├── composer.test.ts
│   │   ├── event-reducer.test.ts
│   │   ├── extension-ui-overlay.test.ts
│   │   ├── input.test.ts
│   │   ├── live-ui-controller.test.ts
│   │   ├── live-ui-frame.test.ts
│   │   ├── live-ui-gate.test.ts
│   │   ├── live-ui-host.test.ts
│   │   ├── live-ui-protocol.test.ts
│   │   ├── live-ui-registry.test.ts
│   │   ├── live-ui-runtime.test.ts
│   │   ├── live-ui-trust-gate.test.ts
│   │   ├── logo-banner.test.ts
│   │   ├── main-viewport.test.ts
│   │   ├── picker-overlay.test.ts
│   │   ├── provider-defaults.test.ts
│   │   ├── spinner.test.ts
│   │   ├── status-bar.test.ts
│   │   └── theme.test.ts
│   ├── theme/
│   │   ├── logo.ts
│   │   └── theme.ts
│   └── tui/
│       ├── ansi.ts
│       ├── clipboard.ts
│       ├── component.ts
│       ├── input.ts
│       ├── layout.ts
│       ├── overlay.ts
│       ├── renderer.ts
│       └── tui.ts
├── dist/              # Build output
└── node_modules/      # Dependencies
```

## Required colors and themes

The default `dark` theme (Gotham) must keep these exact base colors:

```txt
background: #0c1014
border:     #195466
primary:    #33859e
```

Additional derived colors are allowed, but the default base visual identity must stay dark charcoal/teal (Gotham).
For user-facing rendering, prefer `ctx.theme` tokens over hardcoded hex colors so custom themes work. Theme usage and JSON format are documented in `docs/THEMES.md`.

## CLI launch

When both workspace packages are installed, bare `crewcoder` launches the `crewcoder-tui` binary. Keep the TUI's backend invocations argument-bearing (`crewcoder run`, `crewcoder session ...`) so they continue to target the agent CLI instead of reopening the TUI.

## Remote SSH agents

`crewcoder-tui --remote <user@host> --remote-cwd <path>` keeps the TUI local while
running the backend CLI and workspace on an SSH host. `src/bridge/remote-connection.ts`
owns validation and POSIX shell quoting; `CrewCoderProcessBridge` must route both
streaming runs and every one-shot CLI helper through the same resolved invocation.
Never interpolate an unquoted remote path, binary, prompt, session id, or control
argument. Reject SSH targets that can be interpreted as options, and put ports,
identity files, proxies, and other connection settings in `~/.ssh/config`.

Remote mode uses SSH encryption/authentication directly and does not use fleet bearer
tokens. The sidebar CWD footer must identify `<target>:<remote cwd>`, and remote agent events
must retain the same rendering and live-control behavior as local subprocess events.
Do not silently run filesystem-dependent TUI features against the local machine:
clipboard images, `@` path suggestions, remote extension live-UI module loading, and
local temporary summary files stay explicitly unavailable until they have a designed
transfer/proxy contract. CLI-backed sessions, providers, workers, goals, extensions,
approvals, follow-ups, and ordinary compaction execute remotely. See
`docs/REMOTE_AGENTS.md`.

## TUI responsibilities

The TUI should:

```txt
- render session state
- render assistant messages
- render tool calls
- render approvals
- show provider/mode/model/session status
- support slash commands
- consume CrewCoder JSON events
```

The TUI must not duplicate the CrewCoder agent loop.

## Event rendering guardrails

The backend owns reasoning/provider logic. The TUI must faithfully render these JSON events:

```txt
thinking_delta      -> append/render a thinking block
assistant_delta     -> append/render assistant text
message_end user    -> render user text plus any message.background entries
session_compacted   -> render lifecycle/system notice (emitted on resume-start AND token-triggered auto-compaction)
```

`message_end` for an assistant message is a **fallback render for the replay/hydration path only**.
Any turn that already produced `assistant_delta` sets `state.streamedAssistantTurn`, and the reducer
skips the `message_end` push (then clears the flag for the next turn). Do not go back to matching the
final message text against recent blocks: providers that run their own internal loop — the Claude
Agent SDK — emit several text segments per CrewCoder turn, so the final message text is a
concatenation that matches no single streamed block and rendered the whole reply a second time.
`isDuplicateAssistantText` stays only as a secondary guard for replayed records. Assistant messages render directly on the transcript surface with no surrounding panel border or fill; preserve the `CREW CODER` label, markdown rendering, throughput metadata, and block spacing.

The `/repaint` command (alias `/redraw`) forces `Renderer.render(true)` through `App.repaint`; keep it available as a recovery path for terminal resize artifacts or broken line wrapping.

Conversation view has no persistent header; the transcript owns the full surface above the one-row composer gap. The centered fresh-home landing screen keeps its landing logo. Safety and focused Live UI status belong at the top of the right sidebar; modified files use the upper content area; workspace location and Git branch/dirty state belong in its anchored footer. The sidebar anchors a combined, wrapped `<cwd>:<git>` identity and CrewCoder brand footer to the bottom, below modified files, agents, and tasks. There is no persistent bottom runtime bar, and no task or file-change chrome belongs between the transcript and composer.

Selecting a worker from `/modes` sets `state.worker` for the session and the composer prompt must show that worker. Selecting a built-in mode (`general`, `plugin`, `extension`) clears `state.worker`.

Modes are explicit and there is no `auto` mode; `general` is the default. `plugin` is the CrewCode
app plugin architect, `extension` is the CrewCoder extension architect — different systems, do not
merge them in UI copy. `auto` still exists in persisted config/session records, so `normalizeTuiMode`
in `state/tui-store.ts` coerces it to `general` on read instead of dropping the value. See
`crewcoder-agent/docs/EXTENSION_MODE.md`.

When resuming from `/sessions` or its `/resume` alias, apply the selected session's saved provider/model/effort/mode before calling `CrewCoderProcessBridge.resume`. The saved effort is the one that session was last run with, not a TUI default; clamp it with `normalizeEffort`/`effortLevelsForModel` against the resumed provider/model and fall back to `DEFAULT_EFFORT` when it is unsupported, so a level like `xhigh` never rides onto a model that rejects it. Both commands must open the same sessions overlay. Historical `agent_end` hydration should show the conversation without re-rendering saved user-message `background` context, because that context can be very large repo/status metadata intended for provider input.

`Renderer.start()` sets the terminal background color with OSC 11 so terminal padding matches the active theme, and `Renderer.stop()` resets it with OSC 111. Mouse reporting is on by default for TUI selection/copy behavior; users can opt out with `CREWCODER_TUI_MOUSE=0` when they prefer terminal right-click/context menus.

The `/checkpoints on|off|status` command persists the backend `checkpointsEnabled` setting. Automatic checkpoints default on; turning them off affects future runs and never deletes existing rewind points. `checkpoint_created` events must still populate `state.checkpoints` for `/rewind`, but must not add checkpoint-save blocks to the main viewport.

The `/file-changes on|off|status` setting controls the file-changes section in the right sidebar. Hiding the display must not discard `file_changed` events or clear `state.changedFiles`; turning it back on restores the tracked list. The preference remains across `/new` because it is TUI display state, not session state. It is process-local and must never affect another TUI instance. See `docs/SETTINGS.md` for Settings command scope and persistence.

The right sidebar is the sole persistent UI for workspace CWD, Git state, tracked file changes, live crew workers, and crew tasks. Its upper sections order modified files, live workers, and tasks; its workspace footer stays anchored at the bottom. The task section must reread the project task store on render, filter to `state.sessionId`, show completed/total progress in the `CREW TASKS` heading, show `activeForm` for in-progress tasks when present, and prioritize recently updated tasks within each status so stale project/session history cannot hide current work. Task rows use semantic state markers (`◉` active, `○` queued, `!` blocked, `✓` completed); completed descriptions are struck through while their ids remain readable. The AGENTS section comes from `state.crewWorkers`, names currently running workers in its heading (for example `AGENTS: builder`), and shows pending/completed/failed lifecycle states while that crew is still active. Hide the section after no workers remain pending or running so completed crews do not become stale persistent chrome. Bound each list so every section remains readable. Long file paths, worker labels, and task text must wrap within their section rather than truncate. `Ctrl+B` and bare `/sidebar` toggle it; `/sidebar on|off|status` provides explicit control. Its vertical divider is mouse-draggable with bounded instance-local width. It reserves horizontal space across home and conversation views, uses theme backgrounds/borders, and is suppressed below 60 terminal columns so the main UI remains usable. Keep sidebar mouse and resize events from reaching the composer or viewport.

Every TUI enables terminal focus reporting (`DECSET 1004`). `InputRouter` tracks `CSI I`/`CSI O` and discards ordinary input while its terminal surface is unfocused, preventing duplicated terminal-emulator input from mutating another CrewCoder tab, pane, or window. Focus reports themselves must never reach App or the composer, and focus reporting must be disabled on renderer shutdown.

`/task on|off` is an instance-local TUI override, represented by `CREWCODER_TASKS_ENABLED` only in that TUI process and inherited by its local or remote backend children. It must not invoke `crewcoder task on|off` or rewrite the shared task config. Direct agent CLI `crewcoder task on|off` retains its shared-default contract.

Crew runs use explicit `crew_start` / `crew_worker_start` / `crew_worker_end` / `crew_end` events. Keep `state.crewWorkers` as the source for the transcript `crew` block roster; do not infer worker identity from nested `agent_start` events. The right sidebar AGENTS section and transcript roster both display crew progress; do not restore a bottom runtime bar. Nested `agent_end` temporarily marks the process idle, so every `crew_worker_start` must restore `state.running` until `crew_end` finalizes the crew. The TUI exposes `/handoff`, `/crew`, `/teams`, and `/team`; these one-shot CLI paths currently render command output rather than attaching the bridge to each child event stream. See `docs/WORKER_CREWS.md`.

The `/review-summary` command renders a dedicated `review_summary` block from `crewcoder git review-summary --json`; keep it as structured UI, not line-by-line CLI text logs. See `docs/REVIEW_WORKFLOW.md`.

The `/why` command renders a dedicated `why` block from `crewcoder session why <id> --json`: the model's plain-language explanation of its last decision, plus the tools it ran and files it touched. It is a one-shot backend call, NOT a prompt sent into the session — `/why` must never push a user or assistant turn. The `model explanation` / `transcript readout` badge distinguishes a real explanation from the deterministic fallback the backend returns when the model call fails; keep them visually distinct and keep `fallbackReason` visible. Guarded by `src/tests/app-why.test.ts`. See `crewcoder-agent/docs/WHY_COMMAND.md`.

The `/compact` command (in `components/App.ts`) manages context compaction:

```txt
/compact              -> compact the active session now (backend: crewcoder session compact <id>)
/compact preview|edit -> preview the proposed summary before compacting (backend: session compact <id> --preview --json)
/compact on|off       -> toggle autoCompact (backend: crewcoder config set autoCompact ...)
/compact status       -> show current config (backend: crewcoder config show)
/export [path]        -> export the session to self-contained HTML (backend: crewcoder session export <id> --html --out)
```

The `/goal` command manages provider-independent detached goals through `crewcoder goal ... --json`. The TUI must not host or duplicate the supervisor. Bare `/goal` opens a preflight editor whose max turns, checker model, and timeout apply only to the new goal; inline flags provide the same overrides. `/goal <objective>` launches with inherited defaults and returns to idle; `/goal status|list` renders dedicated `goal` blocks; `/goal approve|deny` resolves durable pending approvals. Closing the TUI must not terminate a goal. See `docs/DURABLE_GOALS.md` and `crewcoder-agent/docs/DURABLE_GOALS.md`.

The `/set-budget` command manages the opt-in per-session token budget:

```txt
/set-budget 200k|1.5m|250000  -> set the budget; applied to the next run as `--budget`
/set-budget off|none|0        -> clear it (session becomes unbounded)
/set-budget|status            -> report the current budget
```

Budgets are deliberately opt-in and never a default — see `crewcoder-agent/AGENTS.md`
"Iteration limits & stall detection". `state.tokenBudget` is session-scoped: `/new` clears it
(like `fullAccess`), but a budget-exhaustion handoff **carries it into the child**, because that
handoff only exists due to a budget the user explicitly set; silently unbounding the child would
remove the guardrail they asked for. `parseBudgetInput` in `components/App.ts` mirrors
`parseTokenBudget` in the agent package so both accept the same shorthand. Guarded by
`src/tests/set-budget.test.ts`.

External directory grants are session-scoped. `/add-dir <path>` validates through the local or
remote CrewCoder CLI; `/remove-dir` opens a picker and revokes the grant immediately for durable
sessions. Store canonical roots in `state.externalDirectories`, restore them from session records,
pass them as repeatable `--add-dir` arguments, and clear them on `/new`. Never treat local paths as
remote paths; SSH validation runs on the remote CrewCoder host. See `docs/EXTERNAL_DIRECTORIES.md`.

`/compact preview` (alias `/compact edit`) opens `CompactionPreviewOverlay`, a focused multi-line
editor pre-filled with the proposed summary (`^S` apply, `^R` reset, `esc` cancel). It is live
control-channel state, mirroring `ApprovalOverlay`/`ExtensionUiOverlay`:

- Live run: `bridge.requestCompactionPreview()` → backend `session_compaction_preview` event opens
  the overlay → `bridge.resolveCompactionPreview(previewId, approved, summary)` installs the edit.
- Idle: shells out to `session compact <id> --preview --json`, opens the overlay, and applies the
  edit via `session compact <id> --summary-file <tmp>`.

Do not collapse the preview overlay into a passive log — it gates a live compaction. See
`crewcoder-agent/docs/AUTO_COMPACTION.md` and `crewcoder-agent/docs/SESSION_EXPORT.md`.

Do not remove `thinking` blocks or collapse them into assistant text. Codex/OpenAI/OpenCode providers can surface reasoning summaries through `thinking_delta`, and the user expects those summaries to be visible when emitted.

User message `background` is intentional context from the coding-agent package. Render it as muted background under the user turn; do not pretend it was typed by the user, and do not drop it from state.

Approval cards are live control-channel state, not passive logs. The TUI should keep `approval_required` blocks pending until `approval_resolved`, open a focused approval popup for the active decision, and keep `/approve` / `/deny` writing approval control messages to the running CrewCoder child process as fallback controls.

While the backend bridge is running, ordinary non-command composer submissions must use the same `follow_up` control channel as `/follow-up <message>` instead of starting or resuming another process. Keep slash-prefixed commands explicit and preserve normal prompt submission while the bridge is idle.

Extension UI requests follow the same live control-channel pattern. `extension_ui_request` opens a focused popup (`ExtensionUiOverlay`) for `confirm`/`input`/`select`; the answer is written back over the `ui_response` control message via `CrewCoderProcessBridge.resolveUiRequest(requestId, value)`. The request renders as an `extension_ui` block that stays `pending` until `extension_ui_resolved`, then becomes `answered`/`cancelled`. `esc` cancels the request (sends `null`). `extension_ui_notify` renders inline (error/warning levels as error blocks, otherwise a system log). Do not collapse these into passive logs — they gate a live extension call.

`ExtensionUiOverlay` must wrap, not truncate. The question title, the message, option labels, and option descriptions all wrap to the modal width; a description renders indented beneath its label rather than trailing it on the same row. Agent-authored questions are usually a full sentence and their options carry the rationale needed to choose, so a single truncated row hid the deciding text. `desiredHeight(width)` is measured from the wrapped content (App passes the modal `contentWidth`), and the option list scroll-windows to keep the whole selected option visible when the terminal is too short. Every rendered row of an option maps back to that option in `selectableRows`, so a click on a wrapped description row still selects it. Guarded by `src/tests/extension-ui-overlay.test.ts`.

## Live UI sandbox wiring

Live UI (`contributes.liveUi[]`) runs in isolated `worker_threads` workers. The TUI-side wiring is implemented in `src/bridge/live-ui-*.ts` and consumed by `App.ts`, `MainViewport.ts`, and `StatusBar.ts`:

```txt
- Trust gate: LiveUiTrustGate + evaluateTuiLiveUiGate enforce allowExtensionLiveUi,
  experimental: true, supported surface, and approved permissions (deny-by-default).
- Host spawn: LiveUiController.mount() constructs LiveUiHost through the trust gate.
- Registry: LiveUiInstanceRegistry tracks instances; disposeByBlock/ disposeBySurface/
  disposeByExtension/ disposeAll are wired to scroll, overlay, extension unload, and
  session lifecycle events in App.ts.
- Rendering: MainViewport.renderLiveUi() blits composited frames from state.liveUiFrames.
- Input: App.handleInput() forwards keys to the focused live UI host; unhandled input
  (`handled: false`) falls through to normal TUI handlers via onUnhandledInput.
- Chrome: StatusBar shows the focused live UI contribution and its granted permission
  badges in a LIVE-UI pill when space allows.
- Crash fallback: LiveUiController.frame() and MainViewport.renderLiveUi() render an
  error block when a worker errors or exits unexpectedly.
```

Keep live UI wiring separate from `ExtensionUiOverlay`: the overlay handles declarative
request/response UI, while live UI modal surfaces are long-running sandboxed workers.
Generic `extension_ui_request` events must not mount `surface: "transcript"` contributions
at the transcript tail above the composer. Transcript live UI is reserved for renderers
inserted directly after a matching completed tool block.

## Input and popover behavior

- Keep slash/model popovers below the composer unless the user asks otherwise.
- Fuzzy palette categories must be ordered by match relevance rather than fixed category order, and asynchronous worker/extension refreshes must repaint without requiring another keypress. Do not preload saved sessions into the command palette; load them only after `/sessions` or `/resume` is selected.
- Keep picker scrolling tied to keyboard selection so long provider/model lists remain navigable.
- `state.viewportScroll` is an offset from the **bottom** of the rendered transcript, so a live run that keeps appending lines would drag scrolled-back content out from under the reader. `MainViewport.render` absorbs that growth into `viewportScroll` while the user is scrolled up (and only when width/height are unchanged, since a resize invalidates the line count). At `viewportScroll === 0` the transcript still follows the stream. When content is scrollable, a two-row muted `▐` pill at the right edge maps that bottom-relative offset to a top-to-bottom position; do not show it when all content fits. Scrolling must stay usable during an active run; do not reintroduce an unconditional snap-to-bottom on new events.
- The in-transcript working indicator is **one line** (`AGENT IS WORKING · Esc to abort`) and is the only live running indicator: the bottom `RuntimeBar` chrome was removed at the owner's request, so conversation view is transcript + a one-row visual gap + composer. Do not reintroduce a persistent bottom bar or place status content in that gap. Guarded by `src/tests/main-viewport.test.ts` and `src/tests/app-live-ui.test.ts`.
- Arrow-up/down in the composer resolve in this order: wrapped-line movement, then recall of this session's sent messages (each Up loads the next most recent user message; Down walks back and restores the draft), then the caller's fallback (viewport scroll). History is derived from `state.blocks` user entries, so it is session-scoped and covers resumed sessions. Guarded by `src/tests/composer-history.test.ts`.
- `Shift+Enter` should insert a newline in the composer. Some terminals send CSI forms such as `ESC [ 13~`, `ESC [ 13;2~`, or `ESC [ 13;2u`; keep these normalized in `src/tui/input.ts`.

## Image attachments

`Ctrl+V` pastes a clipboard image (screenshot) instead of text when one is present. See `docs/IMAGE_ATTACHMENTS.md`.

```txt
clipboard image -> readClipboardImage() (binary, MIME-typed; never utf8)
                -> sniffImage() header-only dimensions, no pixel decode
                -> persistImageBuffer() to ~/.crewcoder/cache/images
                -> state.attachments[] -> composer chip row (Ctrl+X clears)
submit          -> App.runPrompt pushes a user block + one `image` block per
                   attachment, appends a text path/dimension breadcrumb to the
                   provider prompt, then clears state.attachments
```

- Submit is allowed with an image and no text.
- The viewport `image` block renders real terminal pixels on Kitty/Ghostty/iTerm2 and a metadata chip everywhere else. Protocol detection + encoders live in `src/tui/image-protocol.ts` (`CREWCODER_TUI_IMAGE_PROTOCOL=kitty|iterm|none|auto`); `src/tui/renderer.ts` draws them in a post-frame graphics pass so the line-diff renderer stays text-first. Only fully visible blocks are drawn. A diff render must only erase and redraw graphics when the image signature changed or a repainted row overlaps the image rectangle; erasing on every frame made settled images flicker against the 90ms spinner / 120ms render tick. Guarded by `src/tests/renderer.test.ts`.
- With no persistent conversation header, `MainViewport` placement rows are already absolute terminal rows and `App.renderNormal` forwards them without an offset. Opaque modal compositing must remove any placement intersecting the modal rectangle because terminal graphics render above text and cannot be clipped; the placement returns after the modal closes. Guarded by `src/tests/image-wiring.test.ts`.
- Provider vision is shipped: `crewcoder-agent` carries `ImagePart`s and the bridge ships `--image <path>`, so vision-capable providers receive the actual bytes.

### Images in tool results

Tool results can carry images too. A tool declaring `ToolResult.details.images[]`
(`{ path, displayPath, mime, byteSize }`) has them merged into the
`tool_execution_end` event `metadata`; the reducer converts them with
`toolImageAttachments()` and pushes `image` blocks that reuse the same graphics layer.

- `attachmentFromToolImage` **re-sniffs mime and dimensions from disk** and ignores what the tool claimed; an unreadable/missing path is dropped and the tool output renders normally.
- Tool images are **referenced in place, never copied** into `~/.crewcoder/cache/images` — that cache exists for ephemeral clipboard data, not for every workspace file a tool touches.
- Failed tool calls render no image; blocks dedupe by attachment id; the block is labelled `TOOL IMAGE` so it is never mistaken for a user attachment.
- Producer side is `crewcoder-agent/src/core/tool-images.ts`. The `read` tool describes images instead of dumping binary as UTF-8. Guarded by `src/tests/tool-image-results.test.ts` and the agent's `src/tests/tool-images.test.ts`. See `docs/IMAGE_ATTACHMENTS.md`.

## Verification notes

Run from the monorepo root:

```bash
npm run typecheck -w @crewcode/crewcoder-tui
npm test -w @crewcode/crewcoder-tui
```

Regression tests that protect recent behavior:

```txt
src/tests/event-reducer.test.ts   -> thinking/background event state
src/tests/input.test.ts           -> Shift+Enter normalization
src/tests/picker-overlay.test.ts  -> long list keyboard scrolling
src/tests/composer.test.ts        -> wrapped multiline composer and cursor
src/tests/composer-history.test.ts -> arrow-up recall of session messages
src/tests/image-attachment.test.ts -> image header sniffing + persistence
src/tests/image-protocol.test.ts  -> graphics protocol detection + encoders
src/tests/image-wiring.test.ts    -> composer chip, submit gating, image block
src/tests/tool-image-results.test.ts -> tool-result images: disk re-sniff, dedupe, no-copy, TOOL IMAGE label
src/tests/renderer.test.ts        -> graphics erase/redraw policy on diff frames
src/tests/extension-ui-overlay.test.ts -> question/option wrapping, list windowing, wrapped-row clicks
```
