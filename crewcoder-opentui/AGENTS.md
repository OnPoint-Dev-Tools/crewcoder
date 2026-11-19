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
  pending approval card, the composer, and the status line. Never put agent output
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
- Verify layout changes in a real terminal (detached `tmux` on its own socket with a fake
  agent via `CREWCODER_BIN`, `capture-pane -p`, `-e` for colors); the test renderer does not
  exercise the real terminal, mouse reporting, or suspend/resume.
- Footer rows that must not wrap use `height={1}`, `wrapMode="none"`, `flexShrink={0}`.

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
  decision; `/sidebar` and `/file-changes` wait for the sidebar port. Picker commands
  take their value directly (`/effort high`) through `PickerFlows.applyArgument`, which
  must reuse the same selection path as the picker. `/plugins` is listed only under the
  `crewcode` profile (`paletteCommands`).
- Unported slash commands must report that they are unavailable; never send them to the
  agent as prompts.
- The composer is a multi-line `<textarea>` (`components/Composer.tsx`), uncontrolled:
  read and clear it through the ref (`plainText`, `setText`). Enter submits;
  Shift+Enter, Ctrl+J (`ctrl+j` under kitty, `linefeed` otherwise) insert a newline, all
  from `DEFAULT_APP_KEYBINDINGS` via `textareaBindings`. Its height comes from
  `wrappedLineCount`, not the textarea's `virtualLineCount` (that only covers the current
  viewport, so the composer could never grow).
- Extension questions (`extension_ui_request`) are live control-channel state, like
  approvals: a focused `ExtensionQuestion` card replaces the footer while the run is live,
  and answers go back through `bridge.resolveUiRequest` (`ui_response`). Esc cancels the
  question with `null`; it must not abort the run. Question text, option labels, and
  descriptions wrap (never truncate), all rows come from `question-model.ts` so
  `questionView().height` equals what renders, and the card never shows extension or
  request ids. Overlay precedence in `App` is summary editor, then question, then picker.
  An overlay that opens on its own must preserve the composer draft. See
  `docs/QUESTIONS.md`.
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
src/tests/tool-presentation.test.ts   tool names across providers, targets, relative paths, full output, clamping, diff tones, text icons
src/tests/glyphs.test.ts              emoji only for Unicode-width terminals without a multiplexer; CREWCODER_TUI_ICONS override
src/tests/tool-diff.test.ts           edit shapes per provider, single-file patches, Codex headers, anchors
src/tests/app.test.tsx (diffs)        inline diff replaces output, click/Ctrl+T hide, real line numbers, long diff collapse
src/tests/footer-layout.test.ts       composer sizing, approval height, home logo rule, path shortening
src/tests/command-palette.test.tsx    pickerHeight equals the rendered palette; grouped order matches cursor; long lists scroll
src/tests/picker-flows.test.ts        every picker against FakeCli: chains, resume, skills, rewind confirm, busy guards
src/tests/app.test.tsx (transcript)   reply + Reasoning panel, composer/status at the bottom, PgUp/Ctrl+End scrolling,
                                      live tool in the dashed Agent work box and not the footer, stacked tools,
                                      read contents, collapse/expand with Ctrl+O and a click
src/tests/app.test.tsx (pickers)      palette below the transcript; fast "/commands" typing reaches the palette, not the composer
src/tests/app.test.tsx (composer)     Shift+Enter / Ctrl+J newline, Enter sends every line; alert until next key;
                                      summary editor opens at the end and applies with Ctrl+S
src/tests/command-runner.test.ts      every non-picker command against FakeCli/FakeBridge, alerts, compaction preview,
                                      /diff arguments and Hunk failures
src/tests/app.test.tsx                bare "y" never approves; abort, quit; approval buttons;
                                      welcome screen centered, left on first prompt, restored by /new
src/tests/keybindings-args.test.ts    chord matching, overrides, CLI flags, key labels
src/tests/question-model.test.ts      question wrapping, option rows, windowing, answers, height cap
src/tests/app.test.tsx (questions)    select/confirm/input answers over ui_response, Esc cancels without abort,
                                      keys never reach the composer, draft restored, mouse choice
```

See `README.md` for what is implemented and what is not yet ported.
