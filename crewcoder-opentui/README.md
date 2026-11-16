# CrewCoder OpenTUI

`@onpoint-dev-tools/crewcoder-opentui` is CrewCoder's terminal UI built on
[OpenTUI](https://github.com/anomalyco/opentui) with React. Bare `crewcoder` from the
`crewcoder` umbrella package opens it.

> **Preview.** This UI is not at feature parity with the legacy
> [`crewcoder-tui`](../crewcoder-tui/README.md) yet. Prefer the legacy UI if you rely on
> the commands listed under [Not yet ported](#not-yet-ported).

## Requirements

- **Node.js 26.4 or newer.** OpenTUI loads its native renderer through Node's FFI, which
  is not available in older releases. Node marks FFI as experimental; the umbrella
  launcher hides that runtime warning, but running `crewcoder-opentui` directly prints it.
- A platform with an OpenTUI native build: Linux x64/arm64 (glibc and musl), macOS
  x64/arm64, Windows x64/arm64.
- An interactive terminal.

The umbrella lists this package as an **optional** dependency, so `npm i -g crewcoder` still
succeeds on Node 22, on other platforms, and in headless sandboxes or VPS images. There,
bare `crewcoder` prints guidance instead of starting, and agent commands
(`crewcoder run ...`) work normally.

## Usage

```bash
crewcoder                         # via the umbrella package
crewcoder-opentui                 # this package directly
crewcoder-opentui --remote me@vps --remote-cwd /workspace [--remote-bin <path>]
```

| Key | Action |
|---|---|
| Enter | Send the prompt. While a run is active it is queued as a follow-up to that run. |
| Escape | Abort the active run. |
| Ctrl+Y / Ctrl+N | Approve / deny the pending tool approval. |
| Ctrl+C | Quit. |

Keys come from `DEFAULT_APP_KEYBINDINGS` in `src/keybindings.ts`; there is no user
override file yet.

Implemented now:

- **Welcome screen**: a fresh or `/new` session opens on the big CrewCoder wordmark
  centered in the terminal with the composer beneath it, like the legacy landing page.
  Windows too small for the wordmark (under 70 columns, or too short) show only the
  composer. The logo text is shared with the legacy UI through
  `@onpoint-dev-tools/crewcoder-tui-core/theme/logo` and drawn with OpenTUI renderables in
  static bold primary (the legacy color pulse is not ported).
- **Chat layout**: after the first message the composer is pinned to the bottom of the
  terminal with the transcript growing upward above it, and the whole window, scrollback
  included, uses the Gotham background (OSC 11, restored on exit). Idle, the row above the
  composer shows the key hints.
- **Native scrollback transcript** (OpenTUI `split-footer`): settled blocks are written to
  the terminal's own scrollback, in order and exactly once, and streaming replies commit
  each finished row as it arrives. Terminal scrolling, search, and copy work on it, and it
  stays visible after quitting. A footer below holds only what is still changing. See
  [`docs/SCROLLBACK.md`](docs/SCROLLBACK.md).
- Footer components from [termcn](https://www.termcn.dev): running tools (`ToolCall`), the
  pending approval card with risk level and arguments (`ToolApproval`), and the working
  spinner (`Spinner`), themed in Gotham. Several upstream issues are fixed in our copies,
  including a global `y` key that approved tool calls while typing. See
  [`docs/TERMCN.md`](docs/TERMCN.md).
- Transcript blocks for user (with muted `background` context), assistant, thinking, tool,
  approval, compaction, image, error, and system. Tool output is clamped to 12 lines. Text
  is normalized to `\n` and stripped of terminal control sequences.
- Other structured blocks (goals, crews, review summaries, live UI, ...) render as a
  labeled placeholder instead of being dropped.
- New runs, automatic resume of the current session, live follow-ups, approval
  decisions, and abort, all through the shared `crewcoder-tui-core` bridge.
- `/new` and `/stop`.
- Remote SSH mode, using the same bridge as the legacy UI.
- Gotham colors (`#0c1014` background, `#195466` border, `#33859e` primary) as termcn
  theme tokens in `src/theme.ts`.

## Not yet ported

Every other slash command (they report that they are unavailable instead of being sent
as prompts), the command palette, provider/model/effort/mode pickers, `/sessions`
resume, themes, the right sidebar, markdown and syntax highlighting in the transcript,
image attachments and terminal graphics, extension UI questions, compaction preview,
Live UI, assistant throughput metadata, and the crew/goal views (these show as one-line
placeholders while live and as labeled rows in scrollback).

## Architecture

```txt
src/cli.tsx                 argument parsing, split-footer renderer, React root
src/App.tsx                 the footer: welcome screen, or live blocks, approval card, spinner, composer, status
src/components/Home.tsx     the centered welcome screen
src/footer-sizer.ts         footer height and the welcome-screen transition, in step with commits
src/terminal-background.ts  OSC 11 / OSC 111 theme background
src/scrollback-writer.ts    commits settled blocks to native scrollback (OpenTUI surfaces)
src/footer-layout.ts        pure footer model and row count for renderer.footerHeight
src/session-controller.ts   owns TuiState + bridge; subscribe/getVersion for useSyncExternalStore
src/transcript.ts           pure block -> display row, and block lifecycle phase
src/keybindings.ts          DEFAULT_APP_KEYBINDINGS and chord matching
src/theme.ts                Gotham as termcn theme tokens
src/components/ui/, src/hooks/, src/providers/, src/lib/   vendored termcn (see docs/TERMCN.md)
@onpoint-dev-tools/crewcoder-tui-core   bridge, event parser, reducer, state (shared with legacy)
```

## Development

```bash
mise exec node@26 -- npm run typecheck -w @onpoint-dev-tools/crewcoder-opentui
mise exec node@26 -- npm test -w @onpoint-dev-tools/crewcoder-opentui
mise exec node@26 -- npm run build -w @onpoint-dev-tools/crewcoder-opentui
```

Tests use OpenTUI's headless test renderer (`@opentui/react/test-utils`) and fail fast
with an explicit message on Node.js older than 26.4.
