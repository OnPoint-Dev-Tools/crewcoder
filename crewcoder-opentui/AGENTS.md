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
  pending approval card, pending images, the composer (or the transcript search bar in its
  place), its `@` path suggestions, and the status line. Never put agent output
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
- Structured blocks (`crew`, `goal`, `review_summary`, `why`, `background_job`,
  `validation`, `checkpoint`, `checkpoint_diff`) render as status panels: rows come from
  the pure `block-panels.ts` (`blockPanel`), `PanelView` only draws. All text goes through
  `normalize()`, wraps (never truncates), and crew rows never show session ids. The `why`
  panel keeps model explanation and transcript readout visibly different (title and color)
  with the fallback reason shown. Slash-command results (`/goal`, `/review-summary`,
  `/why`) stay footer alerts by owner decision; do not push them into the transcript.
  `blockToRow` stays exhaustive (`PanelBlock` assignment) so a new block type fails the
  build until it has a view. See `docs/TRANSCRIPT.md#status-panels`.
- CrewCoder-mode workflow tools (`docs/TRANSCRIPT.md#plans-and-questions`): `crewcoder_propose_plan`
  and `crewcoder_clarify` draw from their arguments through the pure `workflow-tools.ts`
  (`workflowView`), never collapsed and without a target; the plan ends with
  `PLAN_APPROVAL_HINT`. Failed calls fall back to the error view. Section headings and the
  hint are `chromeId` labels; keep `workflowTexts` equal to the drawn content.
- Extension tool renderers (`docs/TRANSCRIPT.md#extension-tool-renderers`): loaded into
  `state.rendererHooks` by `SessionController.loadExtensionRenderers` (startup in `cli.tsx`,
  `/reload`) through the injectable CLI, never from local files. Matching and templates are
  tui-core `state/tool-renderers` (shared with legacy; never copy them here); a renderer
  replaces the whole tool view (`RenderedTool`), checked before workflow tools. Templates
  only substitute values: never evaluate extension code or expressions. An empty `match`
  matches nothing. Whether a renderer may match another extension's or a built-in tool
  (`toolName: "bash"`) is an open owner question; it still can, as in legacy.
- Replies and reasoning render through OpenTUI's native `<markdown>` with styles from
  `markdown-style.ts` (owner decision over termcn `markdown`). Reasoning follows termcn's
  `thinking-block` design and stays expanded (summaries must stay visible).
- The transcript scrollbox sticks to the bottom and must stay `focusable={false}` so a
  click never takes focus from the composer. Scroll keys (`transcriptPageUp/Down`,
  `transcriptTop/Bottom`) go through `DEFAULT_APP_KEYBINDINGS`. A mouse selection is copied
  over OSC 52 from `cli.tsx`.
- Transcript search (`docs/TRANSCRIPT.md#search`): `searchOpen` (Ctrl+F) or `/find [text]`
  puts `SearchBar` in the composer's place (draft preserved; spinner, approval card, and
  status line stay). State is `TranscriptSearch` (`SessionController.search`); matching is
  the pure `transcript-search.ts`, which must search only what blocks draw (never labels)
  and cover collapsed output and hidden diffs. `App.handleSearchKey` runs after the sidebar
  key and before everything else: `searchOlder`/`searchNewer`/`searchClose`, scroll and
  toggle keys, approvals; other keys type into the field. Esc closes and never aborts. The
  jump measures in `scroll.afterLayout` through public renderables only (`search-jump.ts`:
  `blockElementId` boxes, `TextBufferRenderable.plainText`/`lineInfo`); any transcript text
  that is not block content (labels, toggles, headers) needs a `chromeId` id so occurrence
  numbers stay aligned. Never reach into OpenTUI's protected `textBuffer` to highlight
  matches in place (owner decision: jump and mark; Tree-sitter clears those highlights).
  The marker (`SEARCH_MARKER`) is an absolute child placed last in the scrollbox, in the
  content's left padding. Search closes on `/new`, resume, and `/clear`.
- The welcome screen shows only while `isHome` (no blocks, not running). Keep the big logo
  centered; it is the owner's landing identity. Below 70 columns or when too short, show
  only the composer; do not bring back the compact or mini logo (owner rejected them).
  The logo pulses as in legacy (`logo-pulse.ts`, pure; `PulsingLogo` in `Home.tsx` is the
  only component that re-renders per frame): one color from `AppTheme.logo` (`accent` at
  half brightness to `glow`), never a sweep, never a hardcoded hex. Its timer runs only while
  the logo is mounted, stops after `PULSE_FREEZE_MS` without a key (any key restarts it),
  and never starts under reduced motion (`useMotion`), which draws `glow`.
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
- Themes (`docs/THEMES.md`): slate is the default by owner decision; `dark` is Gotham and
  `light` as in legacy. The loader, built-ins, and JSON schema are tui-core
  `theme/crewcoder-theme`, shared with legacy (same names, same files); never fork them
  here. `toAppTheme` (`src/theme.ts`) maps the shared tokens onto termcn tokens plus diff
  and syntax colors. Components read colors only through `useTheme()` (termcn tokens) or
  `useAppColors()` (diff, syntax, markdown); never hardcode a hex color or import a palette
  in a component. Every built-in carries full `syntax` and `markdown` palettes (slate's
  markdown colors equal what replies drew before); theme files may override any token and
  choose their base with `extends` (default `dark`, legacy-compatible). `markupStyles` is
  the one `markup.*` map for replies and markdown source; list every full capture name
  (OpenTUI falls back only to the first segment). Read output passes `conceal={false}`:
  a `.md` read shows its markers, highlighted, never rendered. `examples/themes/ember.json`
  is the shipped full example; keep it setting every token.
  Startup order is `--theme` > `CREWCODER_THEME` > saved `/theme` pick > slate
  (`resolveStartupTheme`); `cli.tsx` resolves it before `createCliRenderer`, so a bad flag
  or variable is a plain startup error, while a saved pick that broke falls back to slate
  with a warning. `/theme` (`ThemeController`, `SessionController.themes`): the highlighted
  theme previews live, Esc (`closePicker`) returns to the applied one, Enter applies before
  the picker closes and saves to `$CREWCODER_HOME/opentui.json` through the injectable
  `ThemeStore`. Tests configure temp dirs and an in-memory store; never let a test write the
  real file. Unusable theme files are listed with the reason, never hidden. `Root` provides
  `themes.current`, so anything that caches colors (native `SyntaxStyle`s) must rebuild
  when they change (`useSyntaxStyle` deps).
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
  footer alerts (`controller.alert`, vendored termcn `alert`) that last until the next key.
  Alert text wraps, never truncates: rows come from `alertView(alert, width)` at the alert's
  real width (the main column, or `homeComposerWidth` on the welcome screen), and
  `footerExtras(alertWidth)` sizes the footer from the same rows. Alerts never go into the
  transcript. Only `/approve-plan` sends a prompt. `/why` is a
  one-shot `session why` call and must never push a turn. Live UI (`contributes.liveUi[]`,
  sandboxed extension worker panels) is skipped by owner decision: never mount or run an
  extension `entry` module here; ask the owner before porting it. Picker commands take
  their value directly (`/effort high`) through `PickerFlows.applyArgument`, which must
  reuse the same selection path as the picker.
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
- Image pixels (`docs/ATTACHMENTS.md#inline-pixels`): `ImageView` draws `image` blocks with
  OpenTUI's native `<image>`; never port legacy's raw kitty/iTerm escape pass. Pass the
  source as a `file:` URL (plain strings that look like `http(s)://` are fetched). Mode
  comes from `resolveImageMode` (`CREWCODER_TUI_IMAGE_PROTOCOL`, `none` in remote mode:
  never read a local file for an SSH path) and the cell box from `imageBox` (legacy caps).
  A load error keeps the caption plus `IMAGE_FAILED_TEXT`.
- Extension questions (`extension_ui_request`) are live control-channel state, like
  approvals: a focused `ExtensionQuestion` card replaces the footer while the run is live,
  and answers go back through `bridge.resolveUiRequest` (`ui_response`). Esc cancels the
  question with `null`; it must not abort the run. Question text, option labels, and
  descriptions wrap (never truncate), all rows come from `question-model.ts` so
  `questionView().height` equals what renders, and the card never shows extension or
  request ids. Overlay precedence in `App` is summary editor, then question, then the
  `/goal` form, then picker. The bare `/goal` form (`goal-form.ts` pure, `GoalForm` draws,
  `SessionController.goalForm`) prefills from `config.goals`, starts through
  `CommandRunner.startGoal` (the same path as typed flags), and a blank check model sends
  `--no-check-model`.
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
- Crews (`docs/CREWS.md`): `/crew <workers> <task>` and `/team <team> <task>` stream through
  `bridge.crew()` (tui-core `crewRunArgs`, `--` before the task, ids checked with
  `isCrewName`), never as a one-shot CLI alert. Refuse while a run is active. While
  `state.crewRunning`, the shared reducer must not move `sessionId` or mark the UI idle on a
  worker's `agent_end`, and tags user/thinking/tool/approval/assistant blocks with `worker`;
  a worker-tagged `user` block is a brief (`TASK → <worker>`), never the `●` user row, and prompt
  history and `sessionName` skip it. `transcriptSections` starts a new work box when the
  worker changes. Anything that stops a crew without `crew_end` (abort, `/new`, resume) must
  call `stopCrew`. Starting a crew opens the sidebar; CREW TASKS includes
  `state.crewSessionIds`. Tests that start a crew must inject a fake task reader.
  With tmux installed and a local workspace (`SessionController.crewTmux`, wired by
  `cli.tsx`), `launchCrew` first asks "Run in tmux" / "Run here" (`crewLaunch` picker; Esc
  cancels). Run in tmux starts a second UI with `--crew-file`: settings and `CREWCODER_*`/
  `PATH` go in an owner-only handoff file (`tmux.ts`), never on the command line, and the
  reader validates owner, permissions, and every field before deleting it. Inside tmux it
  is a background window, outside a detached session; the attach hint is written to the
  transcript (a deliberate exception to alerts-only, since it is needed later). Never start
  real tmux in tests (fake launcher).
- tmux (`docs/TMUX.md`): inside tmux, `cli.tsx` shows one startup alert listing missing
  settings (`tmux-check.ts`: `set-clipboard on`, `extended-keys on`, `focus-events on`,
  client `RGB` feature), silenced by `CREWCODER_TUI_TMUX_HINT=0`; unreadable values and an
  empty client feature list stay quiet. A mouse copy re-reads `set-clipboard` and must never
  claim "Copied" when tmux drops the write (`copyAlert`). Never write tmux passthrough
  escapes from here. Verify tmux behavior with an attached client from a pty you control;
  a detached session proves nothing about focus, color, or clipboard.
- The user's own messages render as `UserMessage`: `USER_MESSAGE_MARKER` (`●`, `glyphs.ts`)
  in the theme's `primary` color left of the text on the same row, never a `YOU` label row
  (owner decision).
- `/diff` runs `hunk diff -- <state.changedFiles>` (`hunk.ts`) through `runInTerminal`.
  Hunk is an external install, never a dependency; a missing binary is an error alert with
  install commands. See `docs/DIFF.md`.

## Verification

```bash
mise exec node@26 -- npm run typecheck -w @onpoint-dev-tools/crewcoder-opentui
mise exec node@26 -- npm test -w @onpoint-dev-tools/crewcoder-opentui
```

`src/tests/test-env-setup.ts` (vitest `setupFiles`) gives every test file a private
`CREWCODER_HOME` and removes the operator's `CREWCODER_*` variables, so a local
`CREWCODER_PROVIDER` cannot make tests pass that fail on CI. Never remove it; tests that need
a variable set it themselves.

Tests that protect current behavior:

```txt
src/tests/session-controller.test.ts  run/resume/follow-up/approval/abort/new, unported commands
src/tests/transcript.test.ts          row mapping, control stripping, throughput label (format, missing/NaN/zero rate)
src/tests/app.test.tsx (transcript)   tok/s beside CREW CODER only after message_end, muted
src/tests/transcript.test.ts          turn sections (tools + approvals grouped, event order), streaming flag
src/tests/block-panels.test.ts        status panels: crew/goal/review/why/job/validation/checkpoint titles, tones, live flag,
                                      list bounds, job output tail without escapes, why badge, no crew session ids
src/tests/app.test.tsx (panels)       background job, validation, and crew roster from agent events, live then settled
src/tests/app.test.tsx (crews)        /team streams: TASK → worker, Agent work · worker, CREW CODER · worker, AGENTS roster live then gone
src/tests/command-runner.test.ts      crews: /crew and /team options, repeats dropped, bad ids and usage never spawn, busy refusal
src/tests/session-controller.test.ts  crews: session id kept, one run across workers, follow-up to the crew, abort and /new finish the roster;
                                      tmux: question, Run here, Run in tmux via handoff file, Esc cancels, failed launch, no question without tmux
src/tests/tmux-check.test.ts          tmux defaults -> fixes, quiet when unreadable, startup alert text, copy never claims a dropped write
src/tests/tmux.test.ts                tmux arguments (window inside, detached session outside, no shell), names, forwarded env, handoff 0600/validation
src/tests/app.test.tsx (transcript)   user message: ● marker left of the text on the same row, theme primary, no YOU
../crewcoder-tui-core/src/tests/event-reducer.test.ts  crew session ids, worker tagging (approvals too), stopCrew; crew-run-args.test.ts
src/tests/tool-presentation.test.ts   tool names across providers, targets, relative paths, full output, clamping, diff tones, text icons,
                                      read filetype (never failures or line-numbered output)
src/tests/grammars.test.ts            bundled grammar hashes + licenses, absolute local paths, missing grammars skipped,
                                      filetype rules, every grammar highlights in OpenTUI's real worker
src/tests/app.test.tsx (syntax)       fenced block colored behind its rail, read output and <diff> colored by path, unknown language plain,
                                      a custom theme's syntax palette reaches rendered code, reply markdown elements in theme colors
                                      (markers hidden), .md read highlighted with markers kept, ```markdown fence kept as source
src/tests/theme.test.ts               slate palette and markdown styles unchanged, shared tokens -> termcn/diff/syntax/markdown,
                                      every markup capture in OpenTUI's markdown queries styled, ember example loads/full/readable
../crewcoder-tui-core/src/tests/crewcoder-theme.test.ts  built-ins (slate, Gotham base colors), files, extends, syntax, vars/256,
                                      readable errors with the file path, $CREWCODER_HOME/themes
src/tests/path-suggestions.test.ts    @ token parsing (no emails), file vs directory insert, list window, walker order/ignores/matching
src/tests/attachments.test.ts         clipboard image -> cache, clipboard text naming images, plain text passthrough, source dedupe
src/tests/image-view.test.ts          image mode override (iterm/junk -> auto, remote -> none), cell box caps and shape
src/tests/app.test.tsx (images)       tool image pixels between caption and path at the right size, undecodable file keeps
                                      the caption, protocol none draws nothing, pasted image drawn after sending
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
src/tests/logo-pulse.test.ts          pulse ends from accent/glow (built-in peak = primary), peak/trough timing, freeze clock
src/tests/workflow-tools.test.ts      plan sections (incl. investigation, file changes), running/failed calls, clarify numbering, search text
../crewcoder-tui-core/src/tests/tool-renderers.test.ts  renderer match rules (empty match never matches), template values, record parsing
src/tests/goal-form.test.ts           /goal defaults from config.goals, field edits, bounds and errors on their field, blank check model
src/tests/command-runner.test.ts      bare /goal form -> goal start args (--no-check-model), bad field starts nothing; renderers on /reload
src/tests/app.test.tsx (audit ports)  plan shown whole with hint, clarify numbered, renderer template as markdown, /goal form keys
src/tests/transcript-search.test.ts   smart case, searchable text per block (no labels, full output, diff lines, panels), order, cap, snippet widths
src/tests/search-controller.test.ts   newest first, older/newer wrap, re-search on step, reveal of collapsed output and hidden diffs
src/tests/app.test.tsx (search)       Ctrl+F bar in the composer's place, jump + marker on the match line, Esc closes without abort,
                                      older/newer, collapsed output expands, draft kept, /find <text>, welcome screen refuses
src/tests/app.test.tsx (welcome)      logo pulses dim <-> glow, freezes when idle, a key resumes it; reduced motion stays on glow
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
src/tests/text-wrap.test.ts           indent kept, hanging list items, long words broken, width never exceeded
src/tests/app.test.tsx (alerts)       a long error wraps inside its border in the conversation and on the welcome screen
src/tests/command-runner.test.ts      every non-picker command against FakeCli/FakeBridge, alerts (wrapping, indent, clamp after wrap), compaction preview,
                                      /diff arguments and Hunk failures, /repaint and /redraw, /quit, /ext.* args after --
src/tests/app.test.tsx                bare "y" never approves; abort, quit; unfocused keys/pastes/Ctrl+C dropped; approval buttons;
                                      welcome screen centered, left on first prompt, restored by /new
src/tests/keybindings-args.test.ts    chord matching, overrides, CLI flags (--theme), key labels
src/tests/theme-controller.test.ts    startup order (flag > env > saved > slate), broken saved pick falls back with a warning,
                                      opentui.json store, list groups/order, unusable + shadowed files, alias, path theme,
                                      preview/Esc/apply/save, override and save-failure notes
src/tests/app.test.tsx (/theme)       palette list, live preview on arrows, Esc keeps the applied theme, Enter applies + saves
                                      and recolors code already on screen, /theme <name>, unknown theme leaves it unchanged
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
