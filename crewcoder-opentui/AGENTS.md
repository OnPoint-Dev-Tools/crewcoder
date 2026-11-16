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
  rows early, and always hold back the last row. This relies on the reducer appending to
  them only; if a block type starts changing in place, classify it `live` in `blockPhase`.
- The first `live` block stops the writer. With no active run every block is `final`.
- Keep commits chunked under the OpenTUI per-commit cell limit.
- `attachScrollback` must run before the footer mounts so `pending` is current on render.
- The welcome screen shows only while `isHome` (no blocks, not running) and sizes the
  footer from `renderer.terminalHeight`, never `useTerminalDimensions()` (that is the
  footer's own size in split-footer mode). Keep the big logo centered; it is the owner's
  landing identity. Below 70 columns or when too short, show only the composer; do not
  bring back the compact or mini logo (owner rejected them).
- After the first message the composer must stay pinned to the bottom with the Gotham
  background across the whole window. Preserve the mechanisms in `docs/SCROLLBACK.md`
  "Footer geometry": OSC 11/111 written outside the renderer lifetime, the welcome
  transition sized before writing and writes deferred until `footerSettled`, fresh-screen
  `leadingRows` padding, `RESERVED_ROWS`, `trailingNewline` on final commits, and all
  other sizing after `writer.sync`. Footer sizing never lives in a React effect.
- Verify layout changes in a real terminal (detached `tmux` on its own socket with a fake
  agent via `CREWCODER_BIN`); the test renderer does not model split-footer scrolling.
- Footer rows are fixed height (`height={1}`, `wrapMode="none"`, `flexShrink={0}`) and
  `footerModel().rows` must equal what `App` renders; update both together.

## termcn components

Footer components are vendored from termcn and owned here (`docs/TERMCN.md`,
`THIRD_PARTY_NOTICES.md`). Do not run `npx shadcn add` into this package: its `@/` aliases
break the tsc/NodeNext build. When vendoring or updating a component:

- Remove global `useKeyboard` handlers. Upstream `tool-approval` approved on a bare `y`
  while the user typed; keys go through `DEFAULT_APP_KEYBINDINGS` in `App`.
- Set `flexDirection="row"` on inline rows (OpenTUI defaults to column, unlike Ink).
- Replace hardcoded colors with theme tokens and stop timers when idle.
- Never default an unknown approval risk to a level; map the agent's
  `safe | review | dangerous` explicitly (`riskLevel`).
- Record changes in the file header and the `docs/TERMCN.md` table.

## Code rules

- `App.tsx` stays presentational. Session behavior belongs in `SessionController`;
  display conversion and block phases belong in the pure `transcript.ts`.
- Route every key check through `DEFAULT_APP_KEYBINDINGS` / `matchesAction`; never compare
  key names inline.
- Agent text must pass through `normalize()` before rendering.
- Unported slash commands must report that they are unavailable; never send them to the
  agent as prompts.
- The composer `<input>` is uncontrolled; clear it through the ref after submit. A
  controlled `value=""` does not reset it because the prop never changes.

## Verification

```bash
mise exec node@26 -- npm run typecheck -w @onpoint-dev-tools/crewcoder-opentui
mise exec node@26 -- npm test -w @onpoint-dev-tools/crewcoder-opentui
```

Tests that protect current behavior:

```txt
src/tests/session-controller.test.ts  run/resume/follow-up/approval/abort/new, unported commands
src/tests/transcript.test.ts          row mapping, block phases, control stripping
src/tests/scrollback-writer.test.ts   order, single commit, streaming hold-back, live blocking, trimmed arrays
src/tests/footer-layout.test.ts       footer row math, reserved rows, approval height, streaming tail, home logo rule
src/tests/footer-sizer.test.ts        welcome transition, after-write sizing, settled detection
src/tests/terminal-background.test.ts OSC 11/111 and color validation
src/tests/app.test.tsx                scrollback + footer end to end; bare "y" never approves; abort, quit;
                                      welcome screen centered, left on first prompt, restored by /new
src/tests/keybindings-args.test.ts    chord matching, overrides, CLI flags
```

See `README.md` for what is implemented and what is not yet ported.
