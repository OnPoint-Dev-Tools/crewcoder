# CrewCoder TUI

CrewCoder TUI is a custom terminal UI package for CrewCoder.

Custom TUI architecture:

- Component interface
- Component tree
- Differential-ish line rendering
- Overlay stack
- Keyboard/input dispatch
- TUI-owned theme
- Backend communication through CrewCoder JSON events

It does **not** use Ink, React, blessed, or curses.

## Themes

The TUI ships with built-in `dark` and `light` themes. Select one with:

```bash
crewcoder-tui --theme light
CREWCODER_THEME=dark crewcoder-tui
```

Custom JSON themes can be loaded by path or by name from `~/.crewcoder/themes/<name>.json`.
See [`docs/THEMES.md`](docs/THEMES.md) for the theme format and token list.

The TUI also sets the terminal background color while it is running so Ghostty/window padding matches the active theme, then resets it on exit.

Base CrewCoder identity colors remain:

```txt
background: #0c1014
border:     #195466
primary:    #33859e
```

## Current wiring

The composer now spawns:

```bash
crewcoder run --json-events --provider <provider> --mode <mode> --model <model> --approval review [--system-prompt <name>] "<prompt>"
```

The UI parses CrewCoder JSON events and renders:

```txt
- user prompts and attached background context
- borderless assistant messages and thinking streams, including output token throughput
- tool lifecycle/output, inline diffs, background jobs, and tool-result images
- live approvals and extension UI requests
- compaction, checkpoints, durable goals, crew-agent rosters, review summaries, and `/why`
- file changes, usage/context/cost state, errors, and session lifecycle
```

## Control an agent on another PC or VPS

Keep the TUI on your local PC while running CrewCoder and all tools against a remote workspace over SSH:

```sh
crewcoder-tui \
  --remote user@vps \
  --remote-cwd /srv/projects/my-project
```

The default remote executable is `~/crewcoder-runner/crewcoder`. Override it when needed:

```sh
crewcoder-tui \
  --remote crewcoder-vps \
  --remote-cwd /srv/projects/my-project \
  --remote-bin /opt/crewcoder/bin/crewcoder
```

Configure ports and identity files through `~/.ssh/config`, then use its host alias as `--remote`. Remote mode uses SSH directly and does not require a fleet bearer token or HTTP tunnel. Provider credentials and the project must exist on the remote machine.

See [`docs/REMOTE_AGENTS.md`](docs/REMOTE_AGENTS.md) for deployment, SSH setup, supported features, security guidance, and current local-file limitations.

## Commands

Typing `/` or pressing `Ctrl+P` opens a fuzzy-searchable command palette. On the first home screen it appears as a centered modal; once a conversation is open it appears inline below the composer like `@` path suggestions. Built-in slash commands are grouped by purpose, with provider/model/mode, reasoning effort and thinking, system prompt, access, budget, file-changes display, and directory controls in a dedicated **Settings** section instead of mixed with operational commands. The palette also searches installed workers, modes, and extensions; strongest matching groups appear first, and asynchronously loaded results appear without another keypress. Saved sessions are loaded only after selecting `/sessions` or `/resume`, keeping ordinary palette startup lightweight. Use Up/Down and Enter to open a result. See [`docs/SETTINGS.md`](docs/SETTINGS.md) for scope and persistence behavior.

Inside the TUI:

```txt
/help
/commands      # insert ~/.crewcoder/commands prompt content into the composer
/new
/reload        # reload ~/.crewcoder config, providers, sessions, and file metadata
/repaint       # force a full terminal repaint after resize artifacts (alias: /redraw)
/sidebar [on|off|status] # toggle the workspace, modified files, and crew tasks sidebar (shortcut: Ctrl+B)
/sessions
/resume        # alias of /sessions
/branch
/goal                      # edit objective, max turns, checker, and timeout
/goal <objective>          # fast start with inherited goal defaults
/goal status               # refresh its dedicated goal card
/goal pause|resume|clear
/goal approve|deny|logs
/prompts       # select ~/.crewcoder/system-prompts/<name>/SYSTEM-PROMPT.md
/clear
/stop
/follow-up <message>  # explicitly queue extra context into the running turn without aborting
/provider
/provider opencode
/provider claude
/provider codex
/modes                    # general, plugin, extension, or a saved worker
/workers                  # alias of /modes
/model
/model default
/effort
/thinking on|off|status   # persistently request/disable provider-supplied reasoning
/full-access on|off       # explicit approval bypass; allows dangerous commands while on
/checkpoints on|off|status # automatic pre-mutation snapshots; existing checkpoints are preserved
/file-changes on|off|status
/set-budget 200k|off|status
/add-dir <path>
/remove-dir [path]
/skills
/extensions
/plugins
/review-summary
/why
/handoff [worker:<name> [continuation prompt]]
/crew <worker1,worker2> <task>
/teams
/team <team-id> <task>
/rewind latest|<checkpoint-id>
/compact [preview|on|off|status]
/export [path]
/task status|on|off|list|add|done # on/off apply only to this TUI instance
/approve
/deny
/quit
```

File-changing `edit` and `write` tool calls render an inline side-by-side diff with line numbers and theme-aware added/removed backgrounds. Tool metadata containing a unified `diff` string is rendered the same way. Press `n` or `p` while the composer is empty to jump to the next or previous diff hunk.

Conversation view has no persistent header: the transcript uses the full surface above the composer. Safety policy and focused Live UI status appear at the top of the right sidebar, above modified files; workspace location and Git state remain in its anchored footer. When the transcript exceeds the viewport, a muted two-row pill at the right edge tracks the current scroll position. Tool-call labels, details, and plain output are muted while semantic syntax and status highlights remain visible. A blank row separates the transcript viewport from the composer so the newest block does not visually merge into the input. The centered fresh-home landing screen keeps its landing logo, and there is no persistent bottom runtime row.

Press `Ctrl+B` or run `/sidebar` to open and close the right sidebar. Drag its vertical divider left or right to resize it; the width is instance-local and bounded so the main conversation remains usable. The upper sections organize modified files, live crew workers (`AGENTS: builder`), and current-session crew tasks, wrapping long paths, worker labels, and task descriptions instead of truncating them. An anchored workspace footer combines the wrapped CWD and Git branch/dirty marker as `<cwd>:<branch>` above `CrewCoder` branding. `/file-changes off` hides paths without discarding them. Task data is reread from the project store as it changes. The `CREW TASKS` heading shows completed/total progress; `◉` marks active work, `○` marks queued work, `!` marks blocked work, and `✓` plus strikethrough marks completed work. Active tasks use their `activeForm` text, and older sessions' tasks stay out of the list. `/sidebar on|off|status` provides explicit control. The sidebar applies to both home and conversation views and does not render on terminals narrower than 60 columns.

When `/modes` or `/workers` selects a worker, future runs pass that worker to the backend for this session. The composer prompt shows the active context, such as `Scout >` for a worker or `General >` for a built-in mode. The Composer uses edge-aligned top and bottom borders so its `backgroundAlt` input fill meets the frame cleanly while preserving the two-column outer margin. Each input row starts with a `borderStrong` full-height rail and one column of spacing before the active mode or worker label. Its footer shows the session permission mode as `● Review` or `● Full Access`, with the indicator dot using the active theme's `glow` color. Context usage renders as `◔ 12.4k/200k - 6% | 12.4k tokens` when the model window is known, with a token-only fallback when it is unavailable. When the backend can price the active model, the composer also displays cumulative session spend; unpriced models remain unlabeled rather than appearing as free. Selecting a built-in mode clears the worker.

Mouse clicks select and activate rows throughout TUI overlays, including `/sessions`, the fuzzy command palette, mode/model/provider/worker/skill/prompt pickers, approval actions, and extension UI choices. The fuzzy command palette also highlights rows on mouse hover and scrolls its selection three rows per mouse-wheel step.

When resuming from `/sessions` (or its `/resume` alias), the TUI restores the saved session provider, model, and mode before launching the backend resume command.

The sidebar workspace footer renders `<cwd>:<branch>` with `*` for a dirty work tree, for example `~/projects/crewcoder:main*`. Outside a Git repository the final segment is `local`.

Mouse reporting is on by default for CrewCoder's mouse-drag copy behavior. If you want terminal right-click/context menus instead, start with `CREWCODER_TUI_MOUSE=0`.

Each TUI instance also enables terminal focus reporting and ignores keyboard input while its tab, pane, or window is unfocused. This keeps concurrent CrewCoder instances isolated even if a terminal emulator routes a key event to more than one surface.

`/task on` and `/task off` are instance-local TUI overrides. They control the sidebar crew-task section and task tools inherited by backend children launched from that TUI, including remote SSH runs, without rewriting the shared `~/.crewcoder/tasks/config.json`. Direct CLI use of `crewcoder task on|off` still manages the shared default.

While a CrewCoder provider run is active, submitting ordinary text in the composer automatically queues it as a follow-up over the backend stdin control channel. `/follow-up <message>` remains available as the explicit form. Follow-ups are applied at the next safe point and do not interrupt the current provider request; slash commands continue to run as commands.

Crew JSON-event streams render a live roster from `crew_start`, `crew_worker_start`, `crew_worker_end`, and `crew_end`. The transcript shows pending/running/completed/failed agents and their session ids or errors. Crew execution remains sequential today, but the event/state model permits multiple active agents.

To use one saved worker in the TUI, run `/modes` or `/workers` and select it. Create workers beforehand with `crewcoder workers create <name>`, then use `/reload`. Use `/handoff` to pass the active saved session to another worker, `/crew <worker1,worker2> <task>` to run named workers, `/teams` to list declared teams, and `/team <team-id> <task>` to run one. Native crew/team commands currently display their CLI output in the conversation viewport; lifecycle rosters apply when the TUI consumes a crew JSON-event stream. See [`docs/WORKER_CREWS.md`](docs/WORKER_CREWS.md) for syntax and common errors.

`/goal` is different from a normal attached run: bare `/goal` opens a per-goal preflight editor, then launches CrewCoder's detached goal supervisor, returns the composer to idle, and survives closing the TUI. Inline `--max-turns`, `--check-model`/`--no-check-model`, and `--timeout-minutes` overrides are also supported. Approval-required tools appear in durable goal status and can be resolved later with `/goal approve` or `/goal deny`. See [`docs/DURABLE_GOALS.md`](docs/DURABLE_GOALS.md).

## Run

For development:

```bash
npm install
npm run dev
```

For normal use, link both workspace packages once, then launch from any directory:

```bash
npm link -w @onpoint-dev-tools/crewcoder-agent
npm link -w @onpoint-dev-tools/crewcoder-tui
crewcoder
```

`crewcoder` with no arguments launches this TUI. Use `crewcoder run ...` and other argument-bearing commands for the agent CLI.

## Build

```bash
npm run typecheck
npm run build
```

## Fix spawn crewcoder EACCES

If the TUI shows:

```txt
process error: spawn crewcoder EACCES
```

then the backend binary exists but is not executable.

Fix the backend package:

```bash
cd crewcoder/crewcoder-agent
npm run build
chmod +x dist/cli.js
npm link
crewcoder doctor
```

Fish shell debug command:

```fish
env CREWCODER_DEBUG=1 CREWCODER_DEBUG_STDERR=1 CREWCODER_DEBUG_LEVEL=debug crewcoder run --provider opencode --mode general "say hello"
```

If needed, point the TUI directly at the binary:

```bash
CREWCODER_BIN=/absolute/path/to/crewcoder npm run dev
```

```fish
set CREWCODER_BIN /home/aura/my-cmd/CrewCoder-Mono/crewcoder/crewcoder-agent/dist/cli.js.
npm run dev -w @onpoint-dev-tools/crewcoder-tui --prefix /home/aura/my-cmd/CrewCoder-Mono/crewcoder
```

## Extension Live UI Components

Extensions can contribute sandboxed interactive UI through `contributes.liveUi[]` in `crewcoder.extension.json`. Every live UI component runs in an isolated `worker_threads` Worker with an empty environment and a structured-clone JSON wire protocol. The TUI composits child frames into the terminal surface; the child never touches the terminal directly.

### Manifest

Each entry declares `id`, `title`, `entry` (extension-relative JS path), `target.surface` (`modal` / `transcript` / `status`), `experimental: true`, `activation` rules (events, commands, modes, filePatterns), `match` rules (eventTypes, toolNames, extensionIds, toolIds, renderers, uiKinds, componentKinds), and `permissions`.

### CLI inspection

```sh
crewcoder extension live-ui [--json]
```

Lists every contribution across installed extensions with its gate status, blocked reasons, and granted permissions.

### Sandbox

- `worker_threads` Worker with `env: {}` — no inherited `process.env`, no filesystem or process globals
- Serialized JSON protocol only; functions, AbortSignal, terminal handles, and Node objects are excluded
- Timeout + backpressure on slow render replies; capped render queue
- Crash containment: error/exits render a fallback block; the host surface is never corrupted

### 7 Deny-by-Default Gates

A live component only loads when **all** gates pass:

1. Extension is enabled (not in `disabledExtensions`)
2. Extension is trusted (in `trustedExtensions`)
3. `allowExtensionLiveUi` config is `true`
4. Contribution has `experimental: true`
5. `target.surface` is supported by the host (`modal` / `transcript` / `status`)
6. `entry` module path is present and stays inside the extension directory
7. Permissions include `ui: ["render"]`

The TUI mirrors these gates through `LiveUiTrustGate` and `evaluateTuiLiveUiGate` before spawning a worker.

### Lifecycle

Explicit lifecycle messages: `mount` → `resize` → `update` → `focus` / `blur` → `dispose`. Per-instance tracking through `LiveUiInstanceRegistry`. Dispose triggers: scroll-away, overlay close, session end, or extension unload. Render timeout (default 2s) with configurable disposal on timeout.

### Input

Keyboard and mouse events are forwarded only to the focused live UI host. Global TUI shortcuts (`escape`, `ctrl+c`, `ctrl+p`, `ctrl+i`, `ctrl+o`) are reserved and never forwarded. The child returns `handled: true/false`; unhandled events fall through to normal TUI input dispatch.

### Rendering

The child produces bounded `LiveUiFrame` objects (lines of cells + optional action descriptors). The TUI composites them with borders, titles, focus chrome, and theme colors. The sidebar STATUS section lists the focused contribution and its granted permission badges.

### Capability Grants

Permissions declared in the manifest and approved by the trust gate:

| Permission | Values | Description |
|---|---|---|
| `ui` | `render`, `input`, `focus` | Rendering, keyboard input, focus management |
| `commands` | `ui_response`, `ext.*` | TUI-side command dispatch |
| `storage` | `session` | Per-session JSON state persistence |
| `clipboard` | `none`, `read`, `write` | System clipboard access |
| `network` | `{ allowedHosts: string[] }` | Hostname-allowlisted HTTP fetch |

All capabilities default to denied. Each host command (`read_clipboard`, `network_fetch`, `read_session_state`, `write_session_state`, `resolve_ui_request`) is permission-checked by `isLiveUiHostCommandAllowed`.

### Surface Modes

- **modal** — Focused overlay living in the viewport as a `live_ui` transcript block. Opened by `extension_ui_request` events matching a contribution.
- **transcript** — Inline tool-block renderer activated by `match.toolNames` / `match.toolIds`. Replaces `declarative_component` blocks when trusted live UI is available.
- **status** — Rendered in the sidebar STATUS section; compact text frames appear beneath the focused Live UI summary.

### Docs

- `crewcoder-agent/docs/LIVE_UI_COMPONENTS.md` — Manifest contract, permission model, and agent-side gate evaluation
- `crewcoder-tui/docs/LIVE_UI_SANDBOX.md` — Runtime sandbox, wire protocol, lifecycle, and host wiring
