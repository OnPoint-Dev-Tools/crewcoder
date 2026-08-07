# TUI Settings

CrewCoder's command palette groups interactive configuration under **Settings**. Open it with `/` or `Ctrl+P`, or type a command directly.

## Commands

| Command | Scope | Behavior |
| --- | --- | --- |
| `/provider` | session selection | Select the provider used by future prompts. |
| `/model` | session selection | Select a model for the active provider. |
| `/effort` | session selection | Select supported reasoning effort. |
| `/modes` | session selection | Select `general`, `plugin`, `extension`, or a saved worker. `/workers` is an alias. |
| `/prompts` | session selection | Select a stored custom system prompt. |
| `/full-access on\|off` | session | Enable or disable approval bypass. `/new` resets it to review mode. |
| `/checkpoints on\|off\|status` | backend config | Enable or disable automatic pre-mutation filesystem checkpoints. Existing checkpoints are preserved. |
| `/set-budget 200k\|off\|status` | session | Set an opt-in cumulative token budget. `/new` clears it; budget handoff preserves it. |
| `/add-dir <path>` | session | Grant a validated external directory to file tools. |
| `/remove-dir [path]` | session | Revoke an external-directory grant; no path opens a picker. `/new` clears all grants. |
| `/file-changes on\|off\|status` | TUI display | Show or hide the floating file-change panel and `CHANGES` status pill. Bare `/file-changes` toggles it. |
| `/sidebar on\|off\|status` | TUI display | Open or close the blank right sidebar. Bare `/sidebar` and `Ctrl+B` toggle it. |

Provider, model, effort, mode, worker, and system prompt affect future backend runs. They do not rewrite historical turns.

## File-changes display

File-change visibility is separate from tracking:

```txt
file_changed event -> state.changedFiles (always tracked and deduplicated)
                   -> floating panel (only when showFileChanges is true)
                   -> CHANGES status pill (only when showFileChanges is true)
```

Turning the display off does **not** clear `state.changedFiles`. Turning it back on restores the current tracked list. `/new` clears the list because it starts a new session, but preserves the visibility preference because that preference belongs to the TUI rather than session history.

Examples:

```txt
/file-changes off
/file-changes status
/file-changes on
```

## Right sidebar

The right sidebar reserves space instead of covering the main surface and is local to the current TUI process. It displays safety policy and focused Live UI status first, followed by modified files and live crew workers above current-session crew tasks. An anchored footer renders the wrapped `<cwd>:<branch>` identity above CrewCoder branding. The task list rereads the project task store as it changes and reports completed/total progress in the `CREW TASKS` heading. Rows use `◉` for active, `○` for queued, `!` for blocked, and `✓` with strikethrough for completed work. In-progress rows show `activeForm`, and tasks from older sessions are excluded. Use `Ctrl+B` for quick comparisons or `/sidebar on|off|status` for explicit control. Terminals narrower than 60 columns suppress the panel while preserving its open setting.

## Backend configuration

Some related controls persist through CrewCoder's backend config rather than TUI state. `/checkpoints on|off` sets `checkpointsEnabled`, `/compact on|off` sets `autoCompact`, and extension execution gates are stored with `crewcoder config set`. Automatic checkpoints default on; changing the setting affects future runs and never deletes existing rewind points. Reload backend metadata with `/reload` after changing config outside the TUI.

Do not treat `full-access`, token budgets, or external-directory grants as global defaults: they are deliberately session-scoped safety controls.

## Verification

Relevant regression suites:

```txt
src/tests/command-palette.test.ts  Settings grouping
src/tests/app-input.test.ts       command behavior and /new persistence
src/tests/main-viewport.test.ts   file-change panel visibility
src/tests/status-bar.test.ts      CHANGES pill visibility
src/tests/right-sidebar.test.ts   task progress, state markers, and completed styling
src/tests/set-budget.test.ts      token-budget lifecycle
```
