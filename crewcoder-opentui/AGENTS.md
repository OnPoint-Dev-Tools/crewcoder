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

## Native scrollback (split-footer)

The renderer runs in `split-footer` with `externalOutputMode: "capture-stdout"`; never
switch back to the alternate screen. The transcript belongs in the terminal's native
scrollback, written by `ScrollbackWriter`; the React tree renders only the footer. See
`docs/SCROLLBACK.md`.

- Write each block exactly once and in order. Track committed blocks by identity (the
  reducer trims and re-slices `state.blocks`), never by index.
- Only `streaming` blocks (the last assistant/thinking block of an active run) may commit
  rows early, and only the rows their `BlockView.stableRows()` reports final
  (`scrollback-blocks.ts`). This relies on the reducer appending to them only; if a block
  type starts changing in place, classify it `live` in `blockPhase`.
- Assistant replies and reasoning render as markdown through OpenTUI's native
  `MarkdownRenderable` (`markdown-body.ts`), by owner decision over termcn `markdown`
  (React-only, cannot render into scrollback). Streaming commits only what
  `MarkdownBody.stableEnd()` allows; keep the "streamed equals one-shot" writer test
  passing. Reasoning is termcn's `thinking-block` design ported to core renderables and
  always expanded (committed rows cannot toggle; summaries must stay visible).
- A turn reads as sections in event order: reasoning panel, then the agent's work as one
  stacked section (no blank rows between consecutive tool blocks), then the reply. Never
  reorder blocks to group them. Tool rows come from the pure `tool-presentation.ts`
  (icon, title, target, layout, output policy) for both scrollback (`ToolView`) and the
  footer's running tools; add new provider tool names to `KINDS_BY_NAME`.
- The first `live` block stops the writer. With no active run every block is `final`.
- Keep commits chunked under the OpenTUI per-commit cell limit.
- `attachScrollback` must run before the footer mounts so `pending` is current on render.
- The welcome screen shows only while `isHome` (no blocks, not running) and sizes the
  footer from `renderer.terminalHeight`, never `useTerminalDimensions()` (that is the
  footer's own size in split-footer mode). Keep the big logo centered; it is the owner's
  landing identity. Below 70 columns or when too short, show only the composer; do not
  bring back the compact or mini logo (owner rejected them).
- On terminals 70 columns and wider, the first submitted user message starts at the top
  of the viewport; later transcript blocks follow below it in order. On narrower terminals,
  use fresh-screen padding so the latest messages stay near the composer. Preserve the
  mechanisms in `docs/SCROLLBACK.md` "Footer geometry": OSC 11/111 written outside the
  renderer lifetime, the welcome transition sized before writing and writes deferred until
  `footerSettled`, `RESERVED_ROWS`, `trailingNewline` on final commits, and all other sizing
  after `writer.sync`. Footer sizing never lives in a React effect. The default theme is
  minimal slate; keep transcript and footer colors synchronized.
- Verify layout changes in a real terminal (detached `tmux` on its own socket with a fake
  agent via `CREWCODER_BIN`); the test renderer does not model split-footer scrolling.
- Footer rows are fixed height (`height={1}`, `wrapMode="none"`, `flexShrink={0}`) and
  `footerModel().rows` must equal what `App` renders; update both together. Variable parts
  (open picker, summary editor, or extension question, alert, composer lines) come only from
  `controller.footerExtras(terminalHeight, terminalWidth)`, passed to `footerModel` by both `App` and
  `cli.tsx`.

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
  request ids. Overlay precedence is summary editor, then question, then picker, in both
  `footerExtras` and `App`. An overlay that opens on its own must preserve the composer
  draft. See `docs/QUESTIONS.md`.
- `/clear` wipes the screen and scrollback with `renderer.resetSplitFooterForReplay({
  clearSavedLines: true })` (wired in `cli.tsx`); never write raw escapes to stdout, which is
  captured as transcript in split-footer mode.

## Verification

```bash
mise exec node@26 -- npm run typecheck -w @onpoint-dev-tools/crewcoder-opentui
mise exec node@26 -- npm test -w @onpoint-dev-tools/crewcoder-opentui
```

Tests that protect current behavior:

```txt
src/tests/session-controller.test.ts  run/resume/follow-up/approval/abort/new, unported commands
src/tests/transcript.test.ts          row mapping, block phases, control stripping
src/tests/scrollback-writer.test.ts   first block placement, order, single commit, streaming hold-back, live blocking, trimmed arrays,
                                      Reasoning panel + hold-back, markdown rendering, streamed markdown equals one-shot,
                                      turn sections (reasoning, stacked tools, reply)
src/tests/tool-presentation.test.ts   tool names across providers, targets, relative paths, output policy
src/tests/footer-layout.test.ts       footer row math, reserved rows, approval height, streaming tail, home logo rule
src/tests/footer-sizer.test.ts        welcome transition, after-write sizing, settled detection
src/tests/terminal-background.test.ts OSC 11/111 and color validation
src/tests/command-palette.test.tsx    pickerHeight equals the rendered palette; grouped order matches cursor; long lists scroll
src/tests/picker-flows.test.ts        every picker against FakeCli: chains, resume, skills, rewind confirm, busy guards
src/tests/app.test.tsx (pickers)      footer sized to the palette; fast "/commands" typing reaches the palette, not the composer
src/tests/app.test.tsx (composer)     Shift+Enter / Ctrl+J newline, footer grows, Enter sends every line; alert until next key;
                                      summary editor opens at the end and applies with Ctrl+S
src/tests/command-runner.test.ts      every non-picker command against FakeCli/FakeBridge, alerts, compaction preview
src/tests/app.test.tsx                scrollback + footer end to end; bare "y" never approves; abort, quit; approval buttons;
                                      welcome screen centered, left on first prompt, restored by /new
src/tests/keybindings-args.test.ts    chord matching, overrides, CLI flags, key labels
src/tests/question-model.test.ts      question wrapping, option rows, windowing, answers, height cap
src/tests/app.test.tsx (questions)    select/confirm/input answers over ui_response, Esc cancels without abort,
                                      keys never reach the composer, draft restored, mouse choice
```

See `README.md` for what is implemented and what is not yet ported.
