# Extension questions

A trusted extension can ask the user something mid-run through `ctx.ui.confirm`,
`ctx.ui.input`, `ctx.ui.select`, or a declarative `component`. The agent emits
`extension_ui_request`, waits, and continues when the answer arrives over the
`ui_response` control message. The question gates a live extension call, so OpenTUI shows
it as a focused card that replaces the footer, the same way the compaction summary editor
does. It is never a passive log row.

## Flow

```txt
extension_ui_request  -> reducer pushes a pending `extension_ui` block (crewcoder-tui-core)
                      -> SessionController.question() returns the oldest pending one
                      -> App renders ExtensionQuestion in place of the footer
answer / Esc          -> SessionController.answerQuestion(value)
                      -> bridge.resolveUiRequest(requestId, value)   (ui_response)
                      -> block settles locally (answered / cancelled), card closes
extension_ui_resolved -> reducer confirms the status
transcript            -> the block stays as a "QUESTION · <status>" row
```

A question shows only while the bridge is running, because only a live agent can receive
the answer. Several pending requests are answered oldest first.

## Answers

| Kind | Reply control | Value sent |
|---|---|---|
| `confirm` | termcn `confirm` (Yes / No) | `true` / `false` |
| `select` | termcn `select` | the chosen option's original `value` |
| `input` | OpenTUI native `<input>`, prefilled with `defaultValue` | the typed text |
| `component` | component body, then termcn `select` over its actions | the action `id` (`"close"` if none) |
| any | Esc | `null` (cancel) |

## Keys

All keys come from `DEFAULT_APP_KEYBINDINGS` (`src/keybindings.ts`):

| Action | Default | Applies to |
|---|---|---|
| `questionPrev` / `questionNext` | Up, Left / Down, Right | confirm, select, component |
| `questionSubmit` | Enter | all (input sends the typed text) |
| `questionCancel` | Esc | all; cancels the question, it does **not** abort the run |
| `questionYes` / `questionNo` | `y` / `n` | confirm only |
| `questionScrollUp` / `questionScrollDown` | PgUp / PgDn | a question too long for the card |

For an `input` question, Left/Right and typing go to the text field. For the other kinds,
every key is consumed by the card, so nothing typed leaks into the composer. Clicking an
option or Yes/No answers with it.

## Layout

`src/question-model.ts` is the single source for the card's rows. `questionView` returns
the visible rows and the exact `height` of the card that `App` renders in place of the
footer.

- The question title, message, option labels, and option descriptions **wrap**, never
  truncate. Agent-authored questions are full sentences, and their options carry the
  rationale needed to choose.
- Descriptions are indented under their label. A blank row separates options only when
  some option has a description.
- The card is capped at `questionMaxRows(terminalHeight)`, at most 30 rows. Up to six reply
  rows stay visible. A longer question is windowed with a PgUp/PgDn hint. A long option
  list scrolls so the whole highlighted option stays visible.
- The card shows the question and its reply controls only. Extension and request ids stay
  internal. The transcript row shows the question title and `Answer: <value>`.
- All agent text passes through `normalize()`.

## Composer draft

The card unmounts the composer. `SessionController` tracks the composer text. When a
question or a live compaction preview opens on its own, the controller saves that text
as the composer draft, and `App` restores it when the composer remounts.

## Tests

- `src/tests/question-model.test.ts`: wrapping, option rows, windowing, answers, control
  stripping, height cap.
- `src/tests/app.test.tsx` ("extension questions"): select by keyboard with the original
  value and the committed outcome; confirm by `y` without leaking into the composer; input
  text plus draft restore; Esc cancels without aborting; mouse click.
- `src/tests/transcript.test.ts`: the transcript row hides internal ids.
