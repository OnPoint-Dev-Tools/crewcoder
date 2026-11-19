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
- **Full-screen transcript** (OpenTUI alternate screen, mouse on): the UI draws the whole
  conversation in a scrollbox that follows new output and stays put once you scroll up.
  PgUp/PgDn and the mouse wheel scroll it, Ctrl+Home/Ctrl+End jump to either end, and a
  mouse selection is copied over OSC 52. Blocks update in place, so running tools show
  live and tool output expands and collapses. See [`docs/TRANSCRIPT.md`](docs/TRANSCRIPT.md).
- **Footer**: only the working spinner, alerts (errors and command results), the pending
  approval card (selectable Approve/Deny; Ctrl+Y and Ctrl+N also work), the composer, and
  the status line. Agent output never goes to the footer.
- **Status line** under the composer: access (`Review`, or `Full Access` in the warning
  color), mode or worker, `provider/model (effort)`, and the session as `<repo> · <first
  prompt>` on the left (the repo is the main repository for worktrees; omitted outside git
  and in remote mode); context usage and session cost pinned right
  (`◔ 12.4k/200k - 6% | 15k tokens | $0.03`), live from `usage_update`. Usage appears after
  the first report; on narrow terminals the session name shortens first and access always
  stays (`src/status-line.ts`).
- Footer components from [termcn](https://www.termcn.dev): the pending approval card with
  risk level, arguments, and selectable decision controls (`ToolApproval`), and the working
  spinner (`Spinner`), themed in slate. Several upstream
  issues are fixed in our copies, including a global `y` key that approved tool calls while
  typing. See
  [`docs/TERMCN.md`](docs/TERMCN.md).
- **Extension questions**: `confirm`, `select`, `input`, and declarative `component`
  requests from trusted extensions open a focused card that replaces the footer. Long
  questions, option labels, and descriptions wrap. The answer goes back over the live
  `ui_response` channel, and Esc cancels the question without aborting the run. The
  question and its answer stay in the transcript. Built on vendored termcn `select`
  and `confirm`, plus OpenTUI's native `<input>`. See [`docs/QUESTIONS.md`](docs/QUESTIONS.md).
- **Markdown replies**: assistant text renders through OpenTUI's native
  `MarkdownRenderable` in slate styles. That covers headings, bold/italic/strikethrough,
  inline code, links, ordered and unordered lists, quotes, tables sized to content, and
  fenced code behind a rail. Replies stream in place as text arrives.
- **Images and composer shortcuts**: Ctrl+V attaches a clipboard image (else pastes
  clipboard text), image paths typed or dropped into the prompt attach on send, Ctrl+X
  clears them, Ctrl+P toggles the palette, Tab/Ctrl+I opens the modes picker. Images reach
  the agent as `--image`. See [`docs/ATTACHMENTS.md`](docs/ATTACHMENTS.md).
- **`@` path suggestions**: `@` at the start of a word lists workspace files and folders
  under the composer (Up/Down, Enter or Tab to pick, Esc to close). Not in remote mode.
  See [`docs/MENTIONS.md`](docs/MENTIONS.md).
- **Syntax highlighting** (Tree-sitter) for fenced code, inline diffs, and `read` output.
  JS/TS/TSX, Markdown, and Zig come with OpenTUI; Python, Bash, JSON, Rust, Go, YAML, CSS,
  and HTML grammars are bundled in `grammars/` (local files, no runtime downloads). Other
  languages render as plain text. See [`docs/SYNTAX.md`](docs/SYNTAX.md).
- **Turn sections**: a turn reads in event order as separate sections divided by a blank
  row. Reasoning comes first, then the agent's work, then the reply.
  - **Reasoning** is an amber bordered panel headed `💭 Reasoning`, with the reasoning as
    markdown, always expanded. It follows termcn's `thinking-block` design. While it
    streams, the spinner reads `Thinking`.
  - **Agent work**: consecutive tool calls and approvals sit in one dashed box titled
    `Agent work`. Each tool shows a spinner while running (with its output streaming in),
    then `✓` or `✗`, and a highlighted title chip (`📖 Read File`). Reads, searches,
    commands, and listings put their target on the next row; edits and writes keep it
    inline. Paths under the workspace are shown relative. Every tool's output is shown,
    including file contents from reads; output over 12 lines collapses with a clickable
    `▸ Show N more lines` toggle, and Ctrl+O expands or collapses all of them. Names are
    mapped across CrewCoder, Claude Code, Codex, and MCP-prefixed tools
    (`src/tool-presentation.ts`).
  - **Inline diffs**: every edit and write shows its file diff in place, with real line
    numbers and green/red rows (OpenTUI's native `<diff>`), for CrewCoder, Claude, and
    Codex edits alike. Click a `▾ Diff` header to hide that diff, or press Ctrl+T to hide
    or show all of them.
- **`/diff`**: opens [Hunk](https://www.hunk.dev) on the files this session changed
  (`hunk diff -- <files>`), handing it the terminal until you quit it. Hunk is installed
  separately (`npm install -g hunkdiff`). See [`docs/DIFF.md`](docs/DIFF.md).
- Transcript blocks for user (with muted `background` context), assistant, reasoning, tool,
  approval, extension question, compaction, image, error, and system. Text
  is normalized to `\n` and stripped of terminal control sequences.
- Other structured blocks (goals, crews, review summaries, live UI, ...) render as a
  labeled placeholder instead of being dropped.
- New runs, automatic resume of the current session, live follow-ups, approval
  decisions, and abort, all through the shared `crewcoder-tui-core` bridge.
- `/repaint` (alias `/redraw`): redraws every cell when something else wrote to the
  terminal behind the UI (a stray process, a system message, a glitch after `/diff`).
  Silent on success; the transcript and session are untouched.
- `/quit`: exits like Ctrl+C.
- `/ext.<extension-id>.<command-id> [args]`: runs an extension's executable command
  through `crewcoder command run` (the agent enforces the extension's trust); its output
  shows in an alert and nothing is sent to the agent.
- **Focus gate:** while the terminal tab, pane, or window is unfocused, keys and pastes
  are ignored (Ctrl+C included), so input a terminal duplicates to several panes cannot
  reach a second CrewCoder. OpenTUI enables focus reporting (DECSET 1004) itself.
  Terminals without focus reporting never report a blur, so input keeps working there.
- **`CREWCODER_TUI_MOUSE=0`** leaves the mouse to the terminal: native selection, but no
  click toggles, no copy-on-select, and wheel scrolling is up to the terminal (some send
  Up/Down in the alternate screen, which then moves through prompt history; PgUp/PgDn
  always scroll the transcript).
- Multi-line composer: Enter sends, Shift+Enter or Ctrl+J adds a line; it grows to 8 lines.
- Prompt history: Up/Down move between the composer's lines, and on the first/last line
  recall this session's sent messages (newest first). Down past the newest restores the
  unsent draft; editing a recalled message starts over from the newest
  (`src/prompt-history.ts`).
- Slash command palette (`/`) with the legacy commands: every picker (`/sessions`,
  `/provider`, `/model`, `/effort`, `/modes`, `/prompts`, `/tool-mode`, `/profile`,
  `/rewind`, `/handoff`, ...), settings switches (`/thinking`, `/identity`, `/checkpoints`,
  `/full-access`, `/memory`, `/task`, `/compact auto`), session tools (`/branch`,
  `/compact`, `/compact preview` with a summary editor, `/export`, `/goal`, `/reload`,
  `/clear`), and review tools (`/diff`, `/why`, `/review-summary`, `/extensions`, `/teams`,
  `/team`).
  Results show in a status alert above the composer. See
  [`docs/COMMAND_PALETTE.md`](docs/COMMAND_PALETTE.md).
- Remote SSH mode, using the same bridge as the legacy UI.
- Minimal slate colors (`#101216` background, `#3b414b` border, `#a7adb7` primary) as
  termcn theme tokens in `src/theme.ts`.

## Not yet ported

Unported slash commands report that they are unavailable instead of being sent as prompts.
New components should come from [termcn](https://www.termcn.dev/docs/components/opentui)
when it has one (vendored per [`docs/TERMCN.md`](docs/TERMCN.md)).

**Deferred by owner decision:** `/crew`.

**Next:** the right sidebar (modified files, live crew agents, crew tasks,
`<cwd>:<branch>` footer) with `/sidebar`, `/file-changes`, and Ctrl+B.

**Composer and status:**

- Ctrl+B sidebar toggle (with the right sidebar).

**Transcript rendering:**

- Search inside the transcript (terminal search cannot see the alternate screen).
- Assistant throughput metadata.
- Image attachments and terminal graphics, including tool-result images.
- Dedicated goal, crew roster, and review-summary views (these show as one-line
  labeled rows).
- Live UI (sandboxed extension workers).

**Commands and terminal behavior:**

- Branching from `/sessions`.
- Themes (`--theme`, `CREWCODER_THEME`, custom JSON themes).
- The legacy logo color pulse.

## Architecture

```txt
src/cli.tsx                 argument parsing, alternate-screen renderer, copy-on-select, /diff terminal hand-off, React root
src/App.tsx                 welcome screen, transcript + footer layout, overlays, keys
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
src/components/MentionList.tsx  @ path suggestions under the composer
src/mentions.ts             @ list state and request ordering (SessionController.mentions)
src/attachments.ts          clipboard images, image paths in prompts (injectable ClipboardSource)
src/components/AttachmentRow.tsx  pending images above the composer
src/path-suggestions.ts     @ token parsing, replacement, windowing, workspace walker
src/text-offset.ts          textarea cursor (display cells) <-> JS string index
src/components/SummaryEditor.tsx  /compact preview summary editor
src/components/ExtensionQuestion.tsx  extension question card (confirm / select / input / component)
src/question-model.ts       pure question layout: wrapping, option rows, windowing, height, answers
src/components/Transcript.tsx  scrollbox transcript: reply, Reasoning panel, Agent work box, tool entries, rows
src/tool-presentation.ts    tool name -> icon, title, target, layout; output clamping and diff line tones
src/status-line.ts          status line under the composer: access, mode, model, session, context usage and cost
src/glyphs.ts               emoji vs single-cell icon set from the terminal capability probe (CREWCODER_TUI_ICONS)
src/hooks/use-glyph-set.ts  follows the renderer's capabilities event and resolves the icon set
src/tool-diff.ts            per-file unified diffs from edit/write tool arguments, all providers
src/diff-anchors.ts         reads an edited file once to give snippet diffs real line numbers
src/markdown-style.ts       slate markdown + code scope styles, SyntaxStyle hooks, fenced-code rail
src/syntax/grammars.ts      bundled Tree-sitter grammars: pinned list, hashes, registration
src/syntax/filetype.ts      path -> highlighted filetype; line-numbered read output stays plain
grammars/                   bundled grammar .wasm + highlights.scm + LICENSE (scripts/update-grammars.mjs)
src/hunk.ts                 /diff: hunk arguments and running a program on the real terminal
src/footer-layout.ts        composer sizing, welcome-screen layout, path shortening
src/session-controller.ts   owns TuiState + bridge + tool expansion; subscribe/getVersion for useSyncExternalStore
src/transcript.ts           pure block -> display row, turn sections, streaming flag
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
