# AGENTS.md

## Project

This package is `@onpoint-dev-tools/crewcoder-opentui`, CrewCoder's OpenTUI + React
terminal UI and the UI that the `crewcoder` umbrella's bare invocation launches.
`@onpoint-dev-tools/crewcoder-tui` is the separately published legacy UI; do not
delete or deprecate it without the owner's decision.

crewcoder and crewcode are two different apps. Everything here is CrewCoder.

## Runtime boundary

- `engines.node` is `>=26.4.0` because OpenTUI loads its native layer through Node FFI.
  The umbrella launcher reads that exact field; keep it a simple `>=x.y.z` range and keep
  `scripts/check-sdk-release.cjs` in sync if it changes.
- This package must stay an **optionalDependency** of the umbrella and must never become a
  dependency of `crewcoder-agent`, `crewcoder-sdk`, `crewcoder-client`, or
  `crewcoder-tui-core`. Headless VPS/sandbox installs must not pull OpenTUI native binaries.
- Pin `@opentui/*` to exact versions; they are pre-1.0.

## Shared runtime

Bridge, event parsing, reducer, and state live in `@onpoint-dev-tools/crewcoder-tui-core`
and are shared with the legacy UI. Do not copy them into this package or reimplement the
agent loop here. Event rendering must follow the guardrails in
[`crewcoder-tui/AGENTS.md`](../crewcoder-tui/AGENTS.md#event-rendering-guardrails):
thinking stays a separate block, user `background` renders muted and separate from typed
text, approvals are live control-channel state resolved through the bridge.

## Full-screen transcript (alternate screen)

The renderer runs in `alternate-screen` with the mouse on, by owner decision (it replaced
the split-footer native-scrollback design so tools can update live and tool output can
expand and collapse). The React tree renders the whole UI: a `<scrollbox>` transcript
(`components/Transcript.tsx`) above a footer. See `docs/TRANSCRIPT.md`.

- The footer holds only the working spinner, alerts (errors and command results), the
  pending approval card, pending images, the composer, its `@` path suggestions, and the status line. Never put agent output
  (running tools, streaming text, other live blocks) in the footer; it belongs in the
  transcript. An open picker, summary editor, or extension question replaces the footer.
- A turn reads as sections in event order (`transcriptSections`): reasoning panel, then
  the agent's work, then the reply. Each run of consecutive `tool`/`approval` blocks is one
  dashed **Agent work** box (`DASHED_BORDER`). Never reorder blocks to group them.
- Tool rows come from the pure `tool-presentation.ts` (icon, title, target, layout, diff
  coloring); add new provider tool names to `KINDS_BY_NAME`. Every kind needs both an
  `emoji` and a single-cell `text` icon. `glyphs.ts` uses emoji only when OpenTUI's probe
  reports `unicode`/`unicode-wide` widths and `multiplexer: "none"`; everything else
  (tmux, wcwidth, no answer yet) gets single-cell icons, because a width mismatch clips
  emoji. `CREWCODER_TUI_ICONS=emoji|text` overrides. Never hardcode an emoji in the
  transcript outside `glyphs.ts` / `KIND_STYLES`. See `docs/TRANSCRIPT.md#icons`.
  Tool titles are highlighted chips. Running tools render live with a spinner. Every tool's output is shown (owner:
  never hide read contents); output over `COLLAPSED_OUTPUT_LINES` (12) collapses behind a
  clickable toggle, and `toggleToolOutput` (Ctrl+O) flips all. Expansion state lives in
  `SessionController.toolExpansion`, keyed by block identity.
- Edits and writes show an inline diff in place of their output (`tool-diff.ts`, OpenTUI
  `<diff>`), built from tool arguments so native Claude/Codex edits work too; add new
  argument shapes there. Snippet edits get real line numbers from `diff-anchors.ts` (one
  local read when the tool ends); unanchored diffs render as tinted +/- lines, never
  `<diff>` with fake numbers. Diffs hide per edit (header click) or all at once
  (`toggleDiffs`, Ctrl+T). Hunk stays an optional external install for `/diff`; ask the owner
  before making it a dependency (its binary is about 185 MB).
- Syntax highlighting (`docs/SYNTAX.md`): fenced code (`codeFence` wraps `<markdown>`'s
  default code block in a rail), `<diff>` with real line numbers, and `read` output
  (`<code>`) use OpenTUI's Tree-sitter client. Grammars beyond OpenTUI's own are bundled
  in `grammars/` by owner decision (no runtime downloads); `registerBundledGrammars()`
  runs in `cli.tsx` before the first render with absolute local paths. Never point a
  parser at a URL or a cwd-relative path. Each grammar is pinned in `BUNDLED_GRAMMARS`
  (package, exact version, SHA-256) and comes with its own `queries/highlights.scm`;
  update through `scripts/update-grammars.mjs` and `THIRD_PARTY_NOTICES.md`. Languages
  without a parser and line-numbered read output stay plain text (`codeFiletype`,
  `readOutputFiletype`); highlighting must never fail a render.
- Replies and reasoning render through OpenTUI's native `<markdown>` with styles from
  `markdown-style.ts` (owner decision over termcn `markdown`). Reasoning follows termcn's
  `thinking-block` design and stays expanded (summaries must stay visible).
- The transcript scrollbox sticks to the bottom and must stay `focusable={false}` so a
  click never takes focus from the composer. Scroll keys (`transcriptPageUp/Down`,
  `transcriptTop/Bottom`) go through `DEFAULT_APP_KEYBINDINGS`. A mouse selection is copied
  over OSC 52 from `cli.tsx`.
- The welcome screen shows only while `isHome` (no blocks, not running). Keep the big logo
  centered; it is the owner's landing identity. Below 70 columns or when too short, show
  only the composer; do not bring back the compact or mini logo (owner rejected them).
- Programs that need the real terminal (Hunk for `/diff`) run through
  `SessionController.runInTerminal`, which `cli.tsx` wires to `renderer.suspend()` /
  `resume()`. Never write raw escapes to stdout; `/clear` only empties the transcript.
- `/repaint` (alias `/redraw`) is the recovery path for a screen garbled by output that
  bypassed OpenTUI. `cli.tsx` wires `SessionController.repaint` as `resize(w, h - 1)` then
  `resize(w, h)`: OpenTUI 0.9.2 has no public full-redraw call and ignores a same-size
  resize (it repaints only after seeing a different size). Keep it silent, and keep it
  from touching the transcript or the agent. Verified in tmux by writing junk to the
  pane TTY: typing does not clear it, `/repaint` restores the exact prior screen.
- Verify layout changes in a real terminal (detached `tmux` on its own socket with a fake
  agent via `CREWCODER_BIN`, `capture-pane -p`, `-e` for colors); the test renderer does not
  exercise the real terminal, mouse reporting, or suspend/resume. Focus events need an
  **attached** tmux client (`set -g focus-events on`, then attach through `script`); a
  detached session never sends them, so a focus check there proves nothing.
- Focus gate (`hooks/use-terminal-focus.ts`, ported from legacy `InputFocusGate`): while
  OpenTUI reports `blur`, App drops every key (Ctrl+C included) and the hook drops pastes
  (global paste listeners run before the composer, which honors `preventDefault`). It
  starts focused so terminals without focus reporting keep working. OpenTUI enables
  DECSET 1004 and parses `CSI I`/`CSI O` itself; never write those escapes from here.
- `CREWCODER_TUI_MOUSE=0` turns mouse reporting off (`args.ts` `mouseEnabled`, same rule as
  legacy). `/quit` uses the same exit as Ctrl+C (`SessionController.quit`, wired by
  `cli.tsx`). `/ext.<id>.<command>` runs `crewcoder command run <name> -- <args>` through
  the injectable CLI: the agent enforces extension trust, `--` keeps arguments from being
  read as agent options, and it is never sent to the agent as a prompt.
- Footer rows that must not wrap use `height={1}`, `wrapMode="none"`, `flexShrink={0}`.
- The status line comes from the pure `status-line.ts` and reads only shared state
  (`fullAccess`, mode/worker, provider/model/effort, `gitRepo`, `blocks`, `usage`); usage
  uses tui-core's `formatContextStatus`, not a local copy. Access always shows (safety
  state); details truncate from the end, before usage, measured in terminal cells
  (`string-width`, pinned to OpenTUI's version). Hide usage until token counts arrive (no
  `?/?`). Never show the raw session id: the session reads as `<repo> · <first prompt>`
  (`sessionName`, the same label `/sessions` uses). `cli.tsx` sets `gitRepo` from tui-core
  `readGitRepoName` (main repo name for linked worktrees) and never in `--remote` mode.
  In `--remote` mode `cli.tsx` sets `state.remoteTarget` and the remote `state.cwd` (as
  legacy does); local spawns keep the local process cwd through the bridge.

## termcn components

Footer components are vendored from termcn and owned here (`docs/TERMCN.md`,
`THIRD_PARTY_NOTICES.md`). Do not run `npx shadcn add` into this package: its `@/` aliases
break the tsc/NodeNext build. When vendoring or updating a component:

- Remove global `useKeyboard` handlers. Upstream `tool-approval` approved on a bare `y`
  while the user typed; keys go through `DEFAULT_APP_KEYBINDINGS` in `App`.
- Set `flexDirection="row"` on inline rows (OpenTUI defaults to column, unlike Ink).
- Bordered boxes need `border`; upstream components that pass only `borderColor`/`borderStyle`
  draw no border in OpenTUI (`alert`).
- Replace hardcoded colors with theme tokens and stop timers when idle.
- Never default an unknown approval risk to a level; map the agent's
  `safe | review | dangerous` explicitly (`riskLevel`).
- Record changes in the file header and the `docs/TERMCN.md` table.

## Code rules

- `App.tsx` stays presentational. Session behavior belongs in `SessionController`;
  display conversion and block phases belong in the pure `transcript.ts`.
- Route every key check through `DEFAULT_APP_KEYBINDINGS` / `matchesAction`; never compare
  key names inline. The slash palette and every picker are controlled by `SessionController`
  (`picker`, `pickerQuery`, `pickerCursor`); flows live in `picker-flows.ts` behind
  `PickerHost`. The cursor indexes `pickerEntries()` order, which is also the drawn order.
  While a picker is open, `App` reads `controller.picker` live (not the render value) and
  calls `key.preventDefault()` so keys typed right after `/` never reach the composer.
- Picker CLI calls go through the injectable `CrewCoderCli` (`crewcoder-cli.ts`); tests use
  `FakeCli` and must never spawn the real agent. Destructive picks (rewind that deletes
  files) need a confirm picker that opens on Cancel. See `docs/COMMAND_PALETTE.md`.
- Agent text must pass through `normalize()` before rendering.
- Non-picker slash commands live in `command-runner.ts` behind `CommandHost`; the palette
  catalog and menus are in `commands.ts`. Status, on/off, and text-output results are
  footer alerts (`controller.alert`, vendored termcn `alert`) that last until the next key;
  they never go into the transcript. Only `/approve-plan` sends a prompt. `/why` is a
  one-shot `session why` call and must never push a turn. `/crew` is skipped by owner
  decision. Picker commands take their value directly (`/effort high`) through
  `PickerFlows.applyArgument`, which must reuse the same selection path as the picker.
  `/plugins` is listed only under the `crewcode` profile (`paletteCommands`).
- Branching from `/sessions`: `sessionBranch` (Tab) on the highlighted session runs
  `PickerFlows.branch`, which forks through `cli.branch` and then opens the branch through
  `resumeSession` with the source record's settings, so the transcript and new messages
  both belong to the branch (legacy's `b` only switched the id). It is refused while a run
  is active and rejects an empty or unchanged id. `/branch <id>` uses the same path; bare
  `/branch` forks the current session in place and is also refused mid-run (the fork would
  miss the rest of the turn and follow-ups, which still go to the original). Never bind it to a letter (letters search
  the picker) or Ctrl+B (sidebar). A picker with extra keys sets `Picker.hint`.
- Unported slash commands must report that they are unavailable; never send them to the
  agent as prompts.
- The composer is a multi-line `<textarea>` (`components/Composer.tsx`), uncontrolled:
  read and clear it through the ref (`plainText`, `setText`). Enter submits;
  Shift+Enter, Ctrl+J (`ctrl+j` under kitty, `linefeed` otherwise) insert a newline, all
  from `DEFAULT_APP_KEYBINDINGS` via `textareaBindings`. Its height comes from
  `wrappedLineCount`, not the textarea's `virtualLineCount` (that only covers the current
  viewport, so the composer could never grow).
- Prompt history (`composerHistoryPrev`/`Next`, Up/Down): `App.handleHistoryKey` first
  moves the cursor between wrapped lines and recalls only when the cursor offset did not
  change. Do not trust `moveCursorUp/Down`'s return value: OpenTUI 0.9.2 returns true on
  the first/last row. History comes from `state.blocks` user entries
  (`prompt-history.ts`), so it is session-scoped and resumed sessions recall their own
  messages; `SessionController.recallPrompt` holds the recall state and `submit` resets it.
- `@` path suggestions (`docs/MENTIONS.md`): the list renders under the composer (composer
  autocomplete, not agent output) and the composer keeps focus. `App.handleMentionKey`
  (`mentionUp/Down/Select/Close`) runs before transcript keys, history, and abort; Esc
  closes the list and never aborts. The lister is injectable (`PathLister`, fifth
  `SessionController` argument; `null` disables it, since an explicit `undefined` would
  take the default) and is `null` in remote mode: never list the local disk for an SSH
  workspace. Textarea `cursorOffset` counts display cells; convert with `text-offset.ts`
  before slicing strings.
- Images and composer shortcuts (`docs/ATTACHMENTS.md`): `pasteClipboard` (Ctrl+V),
  `clearAttachments` (Ctrl+X, only when images are pending), `togglePalette` (Ctrl+P),
  `openModes` (Tab, Ctrl+I) run in `App.handleComposerShortcut` after the `@` list.
  Clipboard access is injectable (`ClipboardSource`, sixth `SessionController` argument);
  tests never touch the real clipboard and isolate `CREWCODER_HOME`. Images go out only
  with a new run or resume as `--image`; follow-ups are text only. Remote mode attaches
  nothing. Clipboard and image-path helpers live in tui-core (`state/clipboard`,
  `state/image-attachment`); do not copy them here.
- Extension questions (`extension_ui_request`) are live control-channel state, like
  approvals: a focused `ExtensionQuestion` card replaces the footer while the run is live,
  and answers go back through `bridge.resolveUiRequest` (`ui_response`). Esc cancels the
  question with `null`; it must not abort the run. Question text, option labels, and
  descriptions wrap (never truncate), all rows come from `question-model.ts` so
  `questionView().height` equals what renders, and the card never shows extension or
  request ids. Overlay precedence in `App` is summary editor, then question, then picker.
  An overlay that opens on its own must preserve the composer draft. See
  `docs/QUESTIONS.md`.
- Right sidebar (`docs/SIDEBAR.md`): the only persistent place for workspace/git state,
  modified files, live crew agents, and crew tasks; agent output still belongs in the
  transcript. `App` lays out a row (main column, divider, sidebar), and every
  width-dependent piece uses the main column's `width`, never the terminal's. Rows come
  from the pure `sidebar-model.ts` (exactly `height` rows, each at most `width` cells,
  measured with `string-width`); paths, worker names, and task text wrap, never truncate.
  Section order and budgets follow legacy; keep the workspace footer anchored at the
  bottom, and show AGENTS only while a crew has pending/running workers. State lives in
  `SidebarController` (`SessionController.sidebar`): it starts closed, and open/closed,
  the dragged width, and `showFileChanges` are instance-local, never saved. `/file-changes off`
  hides the list but must never clear `state.changedFiles`, and it survives `/new`. Below
  60 columns the sidebar hides but stays open. The divider is a bordered `box` (text
  would start a selection instead of a drag). The task store reader is shared with legacy
  (tui-core `state/crew-tasks`) and injectable (seventh `SessionController` argument,
  `null` in remote mode: never read a local path for an SSH workspace). It polls only while
  open and re-renders only on change. The git label is refreshed with `readGitLabelAsync`
  after `agent_end` (wired by `cli.tsx`, local only); never call the sync reader outside
  startup. Tests inject a fake task reader so they never read `~/.crewcoder`.
- `/diff` runs `hunk diff -- <state.changedFiles>` (`hunk.ts`) through `runInTerminal`.
  Hunk is an external install, never a dependency; a missing binary is an error alert with
  install commands. See `docs/DIFF.md`.

## Verification

```bash
mise exec node@26 -- npm run typecheck -w @onpoint-dev-tools/crewcoder-opentui
mise exec node@26 -- npm test -w @onpoint-dev-tools/crewcoder-opentui
```

Tests that protect current behavior:

```txt
src/tests/session-controller.test.ts  run/resume/follow-up/approval/abort/new, unported commands
src/tests/transcript.test.ts          row mapping, control stripping
src/tests/transcript.test.ts          turn sections (tools + approvals grouped, event order), streaming flag
src/tests/tool-presentation.test.ts   tool names across providers, targets, relative paths, full output, clamping, diff tones, text icons,
                                      read filetype (never failures or line-numbered output)
src/tests/grammars.test.ts            bundled grammar hashes + licenses, absolute local paths, missing grammars skipped,
                                      filetype rules, every grammar highlights in OpenTUI's real worker
src/tests/app.test.tsx (syntax)       fenced block colored behind its rail, read output and <diff> colored by path, unknown language plain
src/tests/path-suggestions.test.ts    @ token parsing (no emails), file vs directory insert, list window, walker order/ignores/matching
src/tests/attachments.test.ts         clipboard image -> cache, clipboard text naming images, plain text passthrough, source dedupe
src/tests/app.test.tsx (shortcuts)    Ctrl+V image row + send alone with --image, Ctrl+X clear, Ctrl+V text, dropped path attaches,
                                      Ctrl+P toggle keeps the draft, Tab opens the modes picker
src/tests/text-offset.test.ts         textarea cursor cells <-> JS index, checked against a real OpenTUI textarea
src/tests/app.test.tsx (@ paths)      list under the composer, pick with Enter/Tab without sending, directory drill-in,
                                      Esc closes without abort, no-match Enter sends, emoji/CJK before the token, remote off
src/tests/glyphs.test.ts              emoji only for Unicode-width terminals without a multiplexer; CREWCODER_TUI_ICONS override
src/tests/prompt-history.test.ts      sent messages newest first, Up/Down walk, draft restore, edit restarts recall
src/tests/app.test.tsx (history)      Up/Down recall in the composer, multi-line drafts move lines before recalling
src/tests/status-line.test.ts         access/mode/model, repo + first prompt (no raw id), usage + cost pinned right, no ?/?, wide chars, width never exceeded
src/tests/tool-diff.test.ts           edit shapes per provider, single-file patches, Codex headers, anchors
src/tests/app.test.tsx (diffs)        inline diff replaces output, click/Ctrl+T hide, real line numbers, long diff collapse
src/tests/footer-layout.test.ts       composer sizing, approval height, home logo rule, path shortening
src/tests/command-palette.test.tsx    pickerHeight equals the rendered palette; grouped order matches cursor; long lists scroll
src/tests/picker-flows.test.ts        every picker against FakeCli: chains, resume, skills, rewind confirm, busy guards,
                                      branch from /sessions (opens the fork with saved settings, refused while running,
                                      failed/unchanged ids), /branch <id|prefix>
src/tests/app.test.tsx (pickers)      /sessions hint shows Tab branch; typed letters search; Tab branches the highlighted session
src/tests/app.test.tsx (transcript)   reply + Reasoning panel, composer/status at the bottom, PgUp/Ctrl+End scrolling,
                                      live tool in the dashed Agent work box and not the footer, stacked tools,
                                      read contents, collapse/expand with Ctrl+O and a click
src/tests/app.test.tsx (pickers)      palette below the transcript; fast "/commands" typing reaches the palette, not the composer
src/tests/app.test.tsx (composer)     Shift+Enter / Ctrl+J newline, Enter sends every line; alert until next key;
                                      summary editor opens at the end and applies with Ctrl+S
src/tests/command-runner.test.ts      every non-picker command against FakeCli/FakeBridge, alerts, compaction preview,
                                      /diff arguments and Hunk failures, /repaint and /redraw, /quit, /ext.* args after --
src/tests/app.test.tsx                bare "y" never approves; abort, quit; unfocused keys/pastes/Ctrl+C dropped; approval buttons;
                                      welcome screen centered, left on first prompt, restored by /new
src/tests/keybindings-args.test.ts    chord matching, overrides, CLI flags, key labels
src/tests/question-model.test.ts      question wrapping, option rows, windowing, answers, height cap
src/tests/sidebar-model.test.ts       width bounds, exact height, anchored <cwd>:<git> / <target>:<cwd> footer, cell wrapping,
                                      file budget + "… N more", file-changes off, agents only while live, task markers, SSH note
src/tests/sidebar.test.ts             task polling only while open, re-render on change, git label after runs, drag clamp,
                                      /sidebar and /file-changes (tracking kept across /new)
src/tests/app.test.tsx (sidebar)      Ctrl+B open/close beside the transcript, tasks and agents, hidden below 60 columns, divider drag
src/tests/app.test.tsx (questions)    select/confirm/input answers over ui_response, Esc cancels without abort,
                                      keys never reach the composer, draft restored, mouse choice
```

See `README.md` for what is implemented and what is not yet ported.
