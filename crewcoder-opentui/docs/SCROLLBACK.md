# Split-footer scrollback

`crewcoder-opentui` runs OpenTUI in `split-footer` screen mode. The conversation is
written into the terminal's **native scrollback** above a small footer, the same model as
the legacy UI's scrollback transcript. Terminal scrolling, search, selection, and copy all
work on the transcript, and it stays on screen after you quit. The UI never switches to the
alternate screen.

```txt
┌ terminal ───────────────────────────────┐
│ YOU                                     │  native scrollback, written once,
│ fix the tests                           │  in order, by ScrollbackWriter
│                                         │
│ CREW CODER                              │
│ Line 1 of the reply …                   │  finished rows of a streaming reply
├─────────────────────────────────────────┤  ← footer (React, resized per frame)
│ Line 12 of a                            │  streaming tail: the row still changing
│ ⠧ Working                               │  termcn Spinner
│ ╭─────────────────────────────────────╮ │
│ │ Send a follow-up to the running turn│ │  composer
│ ╰─────────────────────────────────────╯ │
│ provider · model · mode · session       │  status
└─────────────────────────────────────────┘
```

## How blocks reach scrollback

`src/scrollback-writer.ts` (`ScrollbackWriter`) is synced on every state change via
`attachScrollback(controller, writer)`. Each reducer block is classified by
`blockPhase()` in `src/transcript.ts`:

| Phase | Blocks | Written |
|---|---|---|
| `final` | user, system, error, finished tools, resolved approvals, … | whole, once |
| `streaming` | the last `assistant`/`thinking` block while a run is active | every finished row as text arrives; the last row is held back |
| `live` | running tools, pending approvals, pending extension questions, running compaction/validation/background jobs, active crews, Live UI | not yet; shown in the footer |

The first `live` block stops the writer: nothing after it is written until it becomes final,
so scrollback is never out of order. When no run is active every block is `final`, so a tool
left `running` by a crashed agent cannot hold the transcript back.

Rules the writer depends on:

- **Identity, not index.** Committed blocks are tracked in a `WeakSet` because the reducer
  trims `state.blocks` to the last 500 entries and re-slices the array.
- **Append-only streaming.** Committing rows before a block is final is only safe because the
  reducer only appends to the last assistant/thinking block. If that ever changes, those
  blocks must become `live`.
- **Bounded commits.** Each commit stays under about 200,000 cells (OpenTUI rejects commits
  above about 349,000), so very long replies are committed in chunks.
- A blank spacer row separates blocks after the first. A streaming block that disappears
  (for example after `/new`) is dropped; rows already written stay in the terminal.

## Theme background

OpenTUI paints only the footer; the transcript above it is the terminal's own scrollback.
Like the legacy UI, `src/terminal-background.ts` sets the terminal's default background to
the slate theme with OSC 11 at startup and restores it with OSC 111 on quit and on process
exit, so the whole window, scrollback included, carries the theme. These are written outside the
renderer's lifetime because `capture-stdout` turns stdout writes made while it runs into
plain scrollback text. Only a `#rrggbb` value may reach the escape sequence.

## Footer geometry

OpenTUI's inline split footer has rules the layout depends on (read from
`@opentui/core` 0.9.2 and confirmed in a real terminal):

- The footer sits directly below the last committed row and moves down as rows are
  committed, until it reaches the bottom of the terminal.
- Shrinking the footer keeps its **top** row; growing it while at the bottom moves the top up.
- A resize requested during a render, or while commits are queued, is deferred.
- After a block's final commit the scrollback cursor must be on a new line
  (`trailingNewline`), or the footer sits one row higher.

How the UI works with them:

- **Welcome screen.** While the session is empty and idle (`isHome`) the footer is
  `renderer.terminalHeight` tall. Any block, even an error, ends it. Use
  `renderer.terminalHeight`, not `useTerminalDimensions()`, which reports the footer's own
  size in split-footer mode.
- **Leaving it.** `prepareFooterForWrites` shrinks the full-height footer before anything
  is written, and `attachScrollback` writes nothing until `footerSettled` reports the
  resize applied. Writing earlier committed the first message with no room above the
  footer, so it scrolled straight into history.
- **First message position.** At 70 columns and wider, the writer starts with the first
  submitted block at the top of the viewport and adds later blocks directly below it. Below
  70 columns, it prepends blank rows to keep recent output near the composer.
- **Stable height.** `footerModel()` always reserves the streaming-tail row and the
  working/empty row (`RESERVED_ROWS`), so a turn finishing never shrinks the footer.
  Otherwise the footer is the approval card (`toolApprovalHeight`), up to three running
  tools plus a "more" row, up to two other live blocks, the composer (3), and the status
  line (1). After a temporary growth (approval card, tools) the shrink can leave a gap under
  the status line until the next committed rows push the footer back down.
- **Ordering.** Only the welcome transition is sized before writing; all other sizing
  (`applyFooterHeight`) runs right after `writer.sync`, in the same synchronous step, and on
  terminal resize. Sizing from the previous sync's pending blocks over-counts and made the
  footer grow then shrink, ending one row off the bottom.

Every footer row is fixed-height (`height={1}`, `wrapMode="none"`, `flexShrink={0}`) so the
computed height matches the layout. The streaming tail shows the end of the last logical
line, truncated from the left; it always contains the row still being held back.

## Verification

- `src/tests/scrollback-writer.test.ts`: ordering, single commit, streaming row hold-back,
  live blocks holding later ones, trimmed arrays, dropped streaming blocks, first-block
  placement.
- `src/tests/footer-layout.test.ts`, `src/tests/footer-sizer.test.ts`: footer row math,
  reserved rows, the welcome transition, settled detection, the streaming tail.
- `src/tests/terminal-background.test.ts`: OSC 11/111 and color validation.
- `src/tests/app.test.tsx`: end to end through the test renderer's captured scrollback.
- **Real terminal check.** The test renderer does not model split-footer scrolling, so
  layout changes must be checked in a real emulator: run the built CLI inside a detached
  `tmux` session (separate socket) with `CREWCODER_BIN` pointing at a fake agent that
  streams JSON events, send keys, and `tmux capture-pane -p -S -<n>`. The transcript must be
  in history exactly once and in order, the status line must be the bottom row after a
  turn, and `ESC[?1049h` must never appear.

## Not yet done

Markdown and syntax highlighting in scrollback (OpenTUI's `MarkdownRenderable` streams by
committed block and needs a tree-sitter client), assistant throughput metadata, images, and
terminal resize reflow of rows already written (they stay as the terminal wrapped them,
like any other scrollback).
