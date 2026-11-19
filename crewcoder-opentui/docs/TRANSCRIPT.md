# Full-screen transcript

`crewcoder-opentui` runs OpenTUI on the **alternate screen** (`screenMode: "alternate-screen"`,
mouse on). The UI draws the whole conversation itself in a scrollbox, so blocks update in
place: running tools show live, and tool output expands and collapses. This replaced the
earlier split-footer design, where the transcript was written into the terminal's native
scrollback and could not change after it was written (owner decision).

```txt
┌ terminal ──────────────────────────────────────────┐
│ YOU                                                │  Transcript (<scrollbox>, sticky bottom)
│ fix the tests                                      │
│                                                    │
│ ┌───────────────────────────────────────────────┐  │
│ │ 💭 Reasoning                                  │  │  Reasoning panel
│ └───────────────────────────────────────────────┘  │
│                                                    │
│ ╭╌ Agent work ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮  │  dashed box: consecutive tools
│ ╎ ✓  📖 Read File                               ╎  │  and approvals
│ ╎   src/app.ts                                  ╎  │
│ ╎     1  const a = 1;   (first 12 lines)        ╎  │
│ ╎   ▸ Show 28 more lines  (click, or ^O for all)╎  │
│ ╎                                               ╎  │
│ ╎ ⠏  💻 Run Command  running…                   ╎  │  live, output streams in
│ ╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯  │
│                                                    │
│ ⠏ Working  Esc to stop                             │  footer: spinner (only while running)
│ ╭────────────────────────────────────────────────╮ │  alert, approval card (when present)
│ │ Send a follow-up to the running turn           │ │  composer
│ ╰────────────────────────────────────────────────╯ │
│ provider · model · mode · session                  │  status
└────────────────────────────────────────────────────┘
```

## Footer

The footer holds only the working spinner (`Thinking` while reasoning streams, `Working`
otherwise), alerts (errors and slash-command results), the pending approval card, the
composer, and the status line. Nothing the agent produces is written there: running tools
and streaming text live in the transcript. An open picker, summary editor, or extension
question replaces the footer; the transcript stays visible above it.

## Sections

`transcriptSections()` (`src/transcript.ts`) groups blocks in event order, never reordering
them. Each run of consecutive `tool` and `approval` blocks is one **Agent work** section;
every other block is its own section. Sections are divided by a blank row.

| Component (`src/components/Transcript.tsx`) | Blocks | Layout |
|---|---|---|
| `AssistantMessage` | `assistant` | `CREW CODER`, then markdown |
| `ReasoningPanel` | `thinking` | amber single border, bold `💭 Reasoning`, blank row, markdown; always expanded |
| `AgentWork` | `tool`, `approval` runs | dashed rounded box (`DASHED_BORDER`) titled `Agent work` |
| `ToolEntry` | `tool` | spinner / `✓` / `✗`, highlighted title chip (primary background), target, output |
| `ApprovalEntry` | `approval` | `⚠`/`✓`/`✗ Approval · tool · status`, muted resolution reason |
| `RowView` | everything else | tone label, plain text, muted detail |

The last assistant/thinking block of an active run renders with `streaming` on
(`isStreaming`), so OpenTUI's markdown engine shows the unfinished last line as far as it
is decided.

## Tool output

`toolPresentation()` (`src/tool-presentation.ts`) maps tool names across CrewCoder, Claude
Code, Codex, and MCP prefixes to an icon, title, target, and layout. Every tool's output is
shown: reads, searches, commands, and the rest. Edits and writes show an inline diff
instead (see below); edit output that is not a diff is still colored by line (`+`, `-`, `@@`).

### Icons

Tool chips and the Reasoning header use one of two icon sets (`src/glyphs.ts`):

| Kind | `emoji` | `text` |
| --- | --- | --- |
| Reasoning | `💭` | `∴` |
| read | `📖` | `→` |
| edit / write | `±` / `+` | `±` / `+` |
| command | `💻` | `$` |
| search | `🔍` | `✱` |
| list | `📂` | `≡` |
| web | `🌐` | `%` |
| tasks | `☑` | `#` |
| agent | `🤖` | `@` |
| other | `⚙` | `*` |

Emoji are two cells wide. When a terminal measures them differently from OpenTUI, the next
cell overwrites half the glyph and the icon looks clipped. `resolveGlyphSet()` therefore
reads OpenTUI's terminal capability probe and uses `emoji` only when the terminal reports
Unicode width handling (`unicode` or `unicode-wide`) **and** no multiplexer is in between.
Everything else gets the single-cell `text` set: tmux, screen, and zellij (they redraw
cells with their own width tables), plain `wcwidth` terminals, and the moment before the
probe answers. `useGlyphSet()` follows the renderer's `capabilities` event, so icons switch
as soon as the terminal is known.

Measured: Ghostty 1.3 reports `unicode-wide` with no multiplexer (emoji); Ghostty inside
tmux 3.8 reports `unicode` with `multiplexer: "tmux"` (text).

Override with `CREWCODER_TUI_ICONS=emoji|text` (`auto`, the default, uses the probe).

Output longer than `COLLAPSED_OUTPUT_LINES` (12) shows its first 12 lines and a toggle row:

- **Click** `▸ Show N more lines` / `▾ Show less` to expand or collapse that tool.
- **Ctrl+O** (`toggleToolOutput`) expands or collapses every tool, resetting per-tool toggles.

The state lives in `SessionController.toolExpansion`, keyed by block identity in a
`WeakSet` (the reducer mutates blocks in place, so identity is stable for a block's life).

## Inline diffs

Files an edit or write tool **created or modified** show as a diff inside its tool entry, in
the Agent work box, in place of its output (`Edited src/a.ts` says nothing more). Shell
commands never show diffs (they keep their output), and deleted files are never shown
(owner decision).

The primary source is the agent's `file_diff` event (`crewcoder-agent/docs/FILE_DIFFS.md`):
exact git patches from workspace snapshots around each edit/write tool. The reducer attaches them to the tool block
(`fileDiffs`). Binary files and patches the agent left out as too large show a note.

Without `file_diff` (older agents, `fileDiffs` off, virtual filesystems), `toolDiffs()`
(`src/tool-diff.ts`) falls back to reading the change from the tool's arguments:

| Source | Arguments | Diff |
|---|---|---|
| Codex `Codex file change` | `changes[]` with `kind` and unified `diff` | real hunks (file headers added); adds as whole content; deletes not shown |
| Claude `Edit` / `MultiEdit` | `old_string` / `new_string` (`edits[]`) | snippet diff, anchored |
| CrewCoder `edit` / `edit_transaction` | `find` / `replace` (`edits[]` with paths) | snippet diff, anchored |
| Claude `Write`, CrewCoder `write` | `content` | whole content as added, from line 1 |
| anything else of kind edit/write | output that is a unified diff | one diff per file |

Failed edits show their error output instead. `edit_symbol` carries no old text and keeps
its output.

**Line numbers.** Agent diffs carry real line numbers. A snippet edit from arguments only
knows the replaced text, not where it is. When the
tool finishes, `SessionController` reads the file once (`computeLineAnchors` in
`src/diff-anchors.ts`; local sessions only, files up to 4 MB), finds where the new text
starts, and shifts the hunk there. Anchored and real-hunk diffs render with OpenTUI's
native `<diff>` (unified view, line numbers, green/red row tints from `DIFF_COLORS`). A diff
that cannot be anchored (remote mode, a pure deletion, text no longer in the file) renders
as tinted `+`/`-` lines, because OpenTUI draws signs in its line-number gutter. `<diff>`
renders only the first file of a patch, so each file gets its own.

**Hiding.** Each diff starts with a `▾ Diff  +3 -1  src/a.ts` header:

- **Click** the header to hide or show that edit's diff.
- **Ctrl+T** (`toggleDiffs`) hides or shows every diff, resetting per-edit toggles.
- Diffs over 12 rows collapse like other output (click `▸ Show N more lines`, or Ctrl+O).

`/diff` (Hunk, `docs/DIFF.md`) stays available for reviewing the whole session in a
dedicated full-screen viewer.

## Scrolling and copy

| Action | Default | Notes |
|---|---|---|
| `transcriptPageUp` / `transcriptPageDown` | PgUp / PgDn | one viewport |
| `transcriptTop` / `transcriptBottom` | Ctrl+Home / Ctrl+End | Ctrl+End resumes following new output |
| mouse wheel | | scrolls the transcript |

The scrollbox sticks to the bottom while output arrives and stays where the user scrolled
until they return to the end. It is not focusable, so clicking the transcript never takes
focus from the composer. A finished mouse drag selection is copied with OSC 52
(`renderer.copyToClipboardOSC52`) and confirmed with a short alert; Shift+drag still uses the
terminal's own selection in most emulators.

## Known trade-offs

The alternate screen gives up what native scrollback provided for free:

- The conversation is not left in the terminal after quitting.
- Terminal search (Ctrl+Shift+F and similar) cannot see the transcript; in-app search is
  not built yet.
- Copy depends on OSC 52 support (most modern terminals; tmux needs `set-clipboard on`).

## Verification

- `src/tests/transcript.test.ts`: section grouping, streaming flag, row mapping.
- `src/tests/tool-presentation.test.ts`: names, targets, full output, `clampOutput`,
  `diffLineTone`.
- `src/tests/tool-diff.test.ts`: every provider's edit shape, single-file patches that
  parse, Codex headers, output diffs, anchors (one read per file, finished edits only).
- `src/tests/app.test.tsx` ("inline diffs"): diff replaces output, header click and Ctrl+T
  hide/show, real line numbers from an injected file reader, long diff collapse.
- `src/tests/app.test.tsx`: the transcript and footer end to end, a live tool in the dashed
  box (and nowhere in the footer), stacked tools, read contents, collapse and expand with
  Ctrl+O and a click, PgUp / Ctrl+End scrolling, the welcome screen, pickers, questions.
- **Real terminal check.** Run the built CLI in a detached `tmux` session on its own socket
  with `CREWCODER_BIN` pointing at a fake agent that streams JSON events (tool results use
  `result: { content: [{ type: "text", text }] }`, deltas `tool_delta`), send keys, and
  `tmux capture-pane -p` (`-e` to check colors). Ctrl+C must restore the shell screen.
