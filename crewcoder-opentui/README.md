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
| Up/Down, Enter, Esc | Choose, answer, or cancel an extension question ([docs](docs/QUESTIONS.md)). |
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
- **Chat layout**: on terminals 70 columns and wider, the first submitted message starts at
  the top of the viewport, with later transcript blocks written below it in order. Narrower
  terminals keep recent messages near the composer. The window uses a minimal slate
  background (OSC 11, restored on exit).
  Approval cards include selectable Approve and Deny controls; the configured Ctrl+Y and
  Ctrl+N shortcuts remain available.
- **Native scrollback transcript** (OpenTUI `split-footer`): settled blocks are written to
  the terminal's own scrollback, in order and exactly once, and streaming replies commit
  each finished row as it arrives. Terminal scrolling, search, and copy work on it, and it
  stays visible after quitting. A footer below holds only what is still changing. See
  [`docs/SCROLLBACK.md`](docs/SCROLLBACK.md).
- Footer components from [termcn](https://www.termcn.dev): running tools (`ToolCall`), the
  pending approval card with risk level, arguments, and selectable decision controls
  (`ToolApproval`), and the working spinner (`Spinner`), themed in slate. Several upstream
  issues are fixed in our copies, including a global `y` key that approved tool calls while
  typing. See
  [`docs/TERMCN.md`](docs/TERMCN.md).
- **Extension questions**: `confirm`, `select`, `input`, and declarative `component`
  requests from trusted extensions open a focused card that replaces the footer. Long
  questions, option labels, and descriptions wrap. The answer goes back over the live
  `ui_response` channel, and Esc cancels the question without aborting the run. The
  question and its answer are committed to scrollback. Built on vendored termcn `select`
  and `confirm`, plus OpenTUI's native `<input>`. See [`docs/QUESTIONS.md`](docs/QUESTIONS.md).
- **Markdown replies**: assistant text renders through OpenTUI's native
  `MarkdownRenderable` in slate styles. That covers headings, bold/italic/strikethrough,
  inline code, links, ordered and unordered lists, quotes, tables sized to content, and
  fenced code behind a rail. Replies still stream into scrollback: a block is committed as
  soon as it is final, so a streamed reply ends up row-for-row identical to a one-shot
  render.
- **Turn sections**: a turn reads in event order as separate sections divided by a blank
  row. Reasoning comes first, then the agent's work, then the reply.
  - **Reasoning** is an amber bordered panel headed `💭 Reasoning`, with the reasoning as
    markdown, always expanded. It follows termcn's `thinking-block` design. While it
    streams, the footer tail continues the panel's border and the spinner reads `Thinking`.
  - **Agent work**: each tool call is one section row with an icon and a bold title, and
    consecutive calls stack without blank rows. Reads, searches, commands, and listings put
    their target on the next row (`📖 Read File` / `src/App.jsx`). Edits and writes keep it
    inline (`± Edit File: src/App.jsx`). Paths under the workspace are shown relative.
    Command and unknown-tool output follows, clamped to 8 lines; read/edit/search output is
    hidden, and a failure always shows its output. Running tools use the same
    icon and title in the footer. Names are mapped across CrewCoder, Claude Code, Codex, and
    MCP-prefixed tools (`src/tool-presentation.ts`).
- Transcript blocks for user (with muted `background` context), assistant, reasoning, tool,
  approval, extension question, compaction, image, error, and system. Text
  is normalized to `\n` and stripped of terminal control sequences.
- Other structured blocks (goals, crews, review summaries, live UI, ...) render as a
  labeled placeholder instead of being dropped.
- New runs, automatic resume of the current session, live follow-ups, approval
  decisions, and abort, all through the shared `crewcoder-tui-core` bridge.
- Multi-line composer: Enter sends, Shift+Enter or Ctrl+J adds a line; it grows to 8 lines.
- Slash command palette (`/`) with the legacy commands: every picker (`/sessions`,
  `/provider`, `/model`, `/effort`, `/modes`, `/prompts`, `/tool-mode`, `/profile`,
  `/rewind`, `/handoff`, ...), settings switches (`/thinking`, `/identity`, `/checkpoints`,
  `/full-access`, `/memory`, `/task`, `/compact auto`), session tools (`/branch`,
  `/compact`, `/compact preview` with a summary editor, `/export`, `/goal`, `/reload`,
  `/clear`), and review tools (`/why`, `/review-summary`, `/extensions`, `/teams`, `/team`).
  Results show in a status alert above the composer. See
  [`docs/COMMAND_PALETTE.md`](docs/COMMAND_PALETTE.md).
- Remote SSH mode, using the same bridge as the legacy UI.
- Minimal slate colors (`#101216` background, `#3b414b` border, `#a7adb7` primary) as
  termcn theme tokens in `src/theme.ts`.

## Not yet ported

Unported slash commands report that they are unavailable instead of being sent as prompts.
New components should come from [termcn](https://www.termcn.dev/docs/components/opentui)
when it has one (vendored per [`docs/TERMCN.md`](docs/TERMCN.md)).

**Deferred by owner decision:** `/crew`, `/sidebar`, `/file-changes`, and the right
sidebar (modified files, live crew agents, crew tasks, `<cwd>:<branch>` footer).

**Composer and status:**

- Status line under the composer: access mode (Review / Full Access), mode or worker,
  provider/model, effort, context usage (`◔ 12.4k/200k - 6%`), and session cost. Usage and
  cost are not shown anywhere yet (termcn `token-usage`).
- Prompt history: Up/Down recalls this session's sent messages.
- `@` path suggestions.
- Shortcuts: Ctrl+V image paste (and dropped image paths), Ctrl+X clear attachments,
  Ctrl+O expand tool output, Ctrl+P open the palette, Ctrl+I agents overlay.

**Transcript rendering:**

- Syntax highlighting in fenced code blocks (OpenTUI's tree-sitter highlights
  asynchronously; the scrollback writer must wait for it before committing a code block).
- Inline side-by-side diffs for `edit` / `write` tool calls (termcn `diff-view`).
- Assistant throughput metadata.
- Image attachments and terminal graphics, including tool-result images.
- Dedicated goal, crew roster, and review-summary views (these show as one-line
  placeholders while live and as labeled rows in scrollback).
- Live UI (sandboxed extension workers).

**Commands and terminal behavior:**

- `/repaint` (alias `/redraw`), `/quit`, and `/ext.<name>` direct extension commands.
- Branching from `/sessions`.
- Themes (`--theme`, `CREWCODER_THEME`, custom JSON themes).
- Terminal focus reporting (DECSET 1004), which keeps a key sent to one CrewCoder tab or
  pane from reaching another.
- Mouse reporting control (`CREWCODER_TUI_MOUSE`).
- The legacy logo color pulse.

## Architecture

```txt
src/cli.tsx                 argument parsing, split-footer renderer, React root
src/App.tsx                 welcome screen, slash palette, live blocks, approval card, spinner, composer, status
src/components/Home.tsx     the centered welcome screen
src/components/ui/command-palette.tsx  termcn command picker presentation
src/palette-model.ts        pure picker matching, grouped order, windowing, height
src/pickers.ts              palette catalog, picker kinds, item builders
src/picker-flows.ts         per-picker loading and selection (PickerHost)
src/crewcoder-cli.ts        injectable one-shot CrewCoder CLI client
src/commands.ts             palette catalog, menus, config-backed switches
src/command-runner.ts       every non-picker slash command (CommandHost)
src/command-format.ts       goal / why / review-summary / CLI output as alert text
src/alert-model.ts          footer alert type, clamping, and height
src/components/Composer.tsx multi-line composer (textarea)
src/components/SummaryEditor.tsx  /compact preview summary editor
src/components/ExtensionQuestion.tsx  extension question card (confirm / select / input / component)
src/question-model.ts       pure question layout: wrapping, option rows, windowing, height, answers
src/footer-sizer.ts         footer height and the welcome-screen transition, in step with commits
src/terminal-background.ts  OSC 11 / OSC 111 theme background
src/scrollback-writer.ts    commits settled blocks to native scrollback (OpenTUI surfaces)
src/scrollback-blocks.ts    per-block scrollback layout (reply, Reasoning panel, tool rows, rows) and stable rows
src/tool-presentation.ts    tool name -> icon, title, target, layout, and which output to show
src/markdown-body.ts        OpenTUI MarkdownRenderable in slate styles, with streaming stable-row math
src/footer-layout.ts        pure footer model and row count for renderer.footerHeight
src/session-controller.ts   owns TuiState + bridge; subscribe/getVersion for useSyncExternalStore
src/transcript.ts           pure block -> display row, and block lifecycle phase
src/keybindings.ts          DEFAULT_APP_KEYBINDINGS and chord matching
src/theme.ts                slate palette as termcn theme tokens
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
