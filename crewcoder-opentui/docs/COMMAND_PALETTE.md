# Slash commands, pickers, and alerts

Typing `/` in an empty composer opens the command palette. Typed letters filter the list
(fuzzy; label matches rank above description matches), Up and Down move the selection,
Enter runs it, and Escape closes it and returns focus to the composer. Every picker and
menu uses the same component, so they all search, scroll, and size the same way.

Commands also work when typed in the composer, with their arguments
(`/thinking off`, `/goal --max-turns 20 ship it`, `/remember use pnpm`).

## Results: alerts

Status, on/off, and text-output results show as an **alert above the composer** (vendored
termcn `alert`: info, success, warning, error). It stays until the next keypress or
command; that key still does its normal job. Alerts never go into the transcript. Long
output shows the first lines and `… N more lines`.

## Commands

### Pickers

Every picker command also takes its value directly and skips the list. Results show as an
alert; bad values report what is accepted.

| Typed | Effect |
|---|---|
| `/effort high` | Set the effort; an unsupported level lists the model's levels. |
| `/provider opencode` | Must be a known provider; keeps the model if the provider offers it, otherwise its default. |
| `/model gpt-6-sol` | Set the model (clamps effort). |
| `/modes crewcoder`, `/workers builder` | A built-in mode, or a saved worker (this session only). |
| `/prompts terse`, `/skills tdd` | Select a system prompt; attach a skill. |
| `/commands review key=value …` | Insert the prompt command with its arguments. |
| `/profile crewcode`, `/tool-mode native|crewcoder|status` | Save the profile; save or show Tool mode. |
| `/remove-dir <path>` | Revoke that grant. |
| `/sessions <id>` (`/resume <id>`) | Resume by exact id or a unique prefix. |
| `/rewind latest|<id>` | Preview and restore that checkpoint (confirm if it deletes files). |
| `/handoff worker:<name> [prompt]` | Hand off with an optional continuation prompt. |

| Command | Picker | On select |
|---|---|---|
| `/sessions` (`/resume`) | Saved sessions, grouped by day | Resume with the session's saved provider, model, mode, and external directories. A saved effort the model does not support is clamped. |
| `/rewind` | Checkpoints, newest first | Preview, then restore. If the restore deletes files, a confirm opens on **Cancel**. |
| `/provider` → `/model` → `/effort` | Providers (built-in catalog when offline), models, effort levels | Chained. Changing the model clamps effort. |
| `/modes` (`/workers`, `/mode`, `/worker`) | Built-in modes, then saved workers | A mode clears the worker; a worker applies to this session only. `plugin` only under the `crewcode` profile. |
| `/prompts` | Custom system prompts | Select after confirming it exists. |
| `/tool-mode` | Provider-native or CrewCoder tools | Saved for new sessions. Refused during a run. |
| `/profile` | `standalone` or `crewcode` | Saved for the project; standalone leaves `plugin` mode. |
| `/remove-dir` | Granted external directories | Revoke the grant. |
| `/commands` | Saved prompt commands | Insert into the composer (multi-line kept). |
| `/skills` | Saved skills | Attach to your next message only. |
| `/handoff` | Saved workers | Hand this saved session to the worker; switch to the new session. |

### Switches (menu: on / off / status, current value marked)

| Command | Setting | Scope |
|---|---|---|
| `/thinking` | `thinkingEnabled` (default on) | CrewCoder config |
| `/identity` | `workerIdentityEnabled` (default off) | CrewCoder config |
| `/checkpoints` | `checkpointsEnabled` (default off; existing checkpoints kept) | CrewCoder config, refused during a run |
| `/compact auto` (`/compact on|off|status`) | `autoCompact` (default on) | CrewCoder config |
| `/full-access` | Approval bypass (warning alert when on) | This session |
| `/memory` | `crewcoder memory on|off|status|list` | This project |
| `/task` | `on|off|status` set `CREWCODER_TASKS_ENABLED` for this instance only; `list` and `add` run `crewcoder task` | This instance |
| `/set-budget` | `status`, `off`, or a value such as `200k` / `1.5m` | This session (next run) |

### Session and review

| Command | What it does |
|---|---|
| `/branch` | Fork the saved session; new messages go to the branch. |
| `/compact` | Compact the saved session now; alert shows the message counts. |
| `/compact preview` (`/compact edit`) | Open the **summary editor** in the footer. Ctrl+S applies, Ctrl+R resets, Escape cancels. During a run, the live loop pauses and sends its proposed summary; when idle, the CLI proposes it and the edit is applied from a temp file (removed after; not available in remote SSH mode). |
| `/export [path]` | Export the session to HTML (default `<session>.html`). |
| `/goal` | Menu: start (prefills `/goal ` in the composer), status, list, logs. Typed: `/goal [--max-turns N] [--check-model M | --no-check-model] [--timeout-minutes N] <objective>`, or `status|list|logs|pause|resume|clear|approve|deny`. Goals run detached in CrewCoder's supervisor. |
| `/reload` | Reload config defaults, the integration profile, providers, and workers. |
| `/clear` | Clear the conversation from the screen and return to the welcome screen. The session is kept; the next message resumes it. Refused during a run. |
| `/diff` | Open [Hunk](https://www.hunk.dev) on the files this session changed; the UI resumes when Hunk exits. Needs Hunk installed and a git repo. See [`DIFF.md`](DIFF.md). |
| `/why` | One-shot `session why`: the model's explanation of its last decision. A deterministic transcript readout (model failed) shows as a warning with the fallback reason. Never adds a turn. |
| `/review-summary` | Git branch, changed files, and issue references. |
| `/extensions`, `/teams` | CLI listings in an alert. |
| `/team <team> <task>` | Run a declared team; output in an alert. |
| `/approve`, `/deny [id]` | Resolve the pending tool call (the approval card buttons and Ctrl+Y / Ctrl+N do the same). |
| `/approve-plan` | Accept the CrewCoder-mode plan: a prompt when idle, a follow-up during a run. |
| `/follow-up <message>` | Queue a message for the running turn (plain messages during a run do the same). |
| `/new`, `/stop`, `/help` | Fresh session; stop the run; open this palette. |
| `/repaint` (`/redraw`) | Redraw every cell of a screen garbled by outside output. Silent. |
| `/quit` | Exit, the same as Ctrl+C. |
| `/ext.<extension-id>.<command-id> [args]` | Run an extension's executable command (`crewcoder command run <name> -- <args>`; the agent enforces trust). Output in an alert; never a prompt. Not listed in the palette; `/commands` shows the available extension commands. |

Commands that need an argument (`/remember`, `/add-dir`, `/follow-up`, `/team`) put
`/name ` into the composer when picked from the palette. `/add-dir` without a path lists
the granted directories.

`/plugins` lists CrewCode app plugin templates. Like the legacy UI, it appears in the
palette only under the `crewcode` integration profile; typed in standalone, it says how to
enable it.

Not in OpenTUI: `/crew` (skipped), `/sidebar` and `/file-changes` (wait for the right
sidebar); they report that they are unavailable.

## Composer

The composer is a multi-line `<textarea>`. Enter sends; Shift+Enter or Ctrl+J adds a
line (Shift+Enter needs the kitty keyboard protocol, which OpenTUI turns on; Ctrl+J works
in every terminal). It grows with its wrapped content up to 8 lines, then scrolls. Keys
come from `DEFAULT_APP_KEYBINDINGS` (`composerSubmit`, `composerNewline`).

## Implementation

```txt
src/commands.ts                     palette catalog, menus, config-backed switches
src/command-runner.ts               non-picker commands, via CommandHost
src/command-format.ts               goal / why / review-summary / CLI output → alert text
src/alert-model.ts                  alert type, clamping, footer rows
src/components/ui/alert.tsx         termcn alert presentation
src/components/SummaryEditor.tsx    /compact preview editor
src/components/Composer.tsx         multi-line composer
src/palette-model.ts                pure: matching, grouped order, windowing, height
src/components/ui/command-palette.tsx  termcn presentation of a PickerView
src/pickers.ts                      picker kinds and item builders
src/picker-flows.ts                 picker loading and selection, via PickerHost
src/crewcoder-cli.ts                injectable one-shot CLI client (remote-safe via core)
src/session-controller.ts           owns picker, alert, editor, composer lines; implements both hosts
```

- **Menu and palette items carry their action in the id**: a command (`/thinking on`) is
  submitted as if typed; `draft:<text>` fills the composer.
- **Overlays replace the footer.** An open picker, the summary editor, or an extension
  question renders below the transcript in place of the composer (editor, then question,
  then picker). The transcript shrinks to make room; nothing is sized by hand.
- **One order for the cursor and the drawn rows.** `pickerEntries` returns items in
  grouped display order; the cursor indexes that list and `CommandPalette` draws it.
- **Keys go to the open picker or editor, read live.** `App` checks `controller.picker` and
  `controller.editor` rather than the last render, and calls `preventDefault()` so the
  focused textarea does not also take the key (keys typed right after `/` would otherwise
  reach the composer, and Enter would submit leftover text).
- **Composer height is computed from the text** (`wrappedLineCount`): the textarea's
  `virtualLineCount` only covers its current viewport, so it never reported more lines than
  the composer already showed.
- Result parsers (`parseGoalRecord`, `parseDecisionExplanation`, `parseReviewSummary`,
  `parseCompactionResult`, `parseGoalStartInput`, `tokenizeGoalCommand`, `parseBudgetInput`)
  and provider defaults live in `@onpoint-dev-tools/crewcoder-tui-core/state/*`, shared with
  the legacy UI.

Tests: `src/tests/command-runner.test.ts`, `src/tests/picker-flows.test.ts`,
`src/tests/command-palette.test.tsx`, `src/tests/footer-layout.test.ts` (composer sizing),
and the `pickers`, `multi-line composer`, `alerts`, and `compaction summary editor` blocks in
`src/tests/app.test.tsx`.
