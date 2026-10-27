# TUI Settings

CrewCoder's command palette groups interactive configuration under **Settings**. Open it with `/` or `Ctrl+P`, or type a command directly.

## Commands

| Command | Scope | Behavior |
| --- | --- | --- |
| `/provider` | session selection | Select the provider used by future prompts. |
| `/model` | session selection | Select a model for the active provider. |
| `/effort` | session selection | Select supported reasoning effort. |
| `/modes` | session selection | Select `general`, `crewcoder`, `plugin`, `extension`, or a saved worker. `/workers` is an alias. |
| `/prompts` | session selection | Select a stored custom system prompt. |
| `/identity on\|off\|status` | backend config | Include or omit the worker persona in future prompts while preserving the selected worker. Bare `/identity` shows status. |
| `/full-access on\|off` | session | Enable or disable approval bypass. `/new` resets it to review mode. |
| `/checkpoints on\|off\|status` | backend config | Enable or disable automatic pre-mutation filesystem checkpoints. Existing checkpoints are preserved. |
| `/set-budget 200k\|off\|status` | session | Set an opt-in cumulative token budget. `/new` clears it; budget handoff preserves it. |
| `/add-dir <path>` | session | Grant a validated external directory to file tools. |
| `/remove-dir [path]` | session | Revoke an external-directory grant; no path opens a picker. `/new` clears all grants. |
| `/file-changes on\|off\|status` | TUI display | Show or hide the floating file-change panel and `CHANGES` status pill. Bare `/file-changes` toggles it. |
| `/sidebar on\|off\|status` | TUI display | Open or close the blank right sidebar. Bare `/sidebar` and `Ctrl+B` toggle it. |

Provider, model, effort, mode, worker, and system prompt affect future backend runs. They do not rewrite historical turns.

## Optional worker identity

Worker identity is off by default, including before backend config has loaded.
An explicitly saved `true` enables it. `/identity off` persistently sets `workerIdentityEnabled: false` on the backend
host. Default and custom system prompts remain active; the selected worker and
its files are preserved. The composer shows the current mode instead of a worker
name while disabled. `/identity on` restores the selected persona. Selecting a
worker does not silently re-enable identity.

The setting applies to future runs; existing provider requests and old
conversation messages are unchanged. After changing the setting from a shell,
use `/reload`. Start a fresh conversation to avoid earlier identity-related text.
See [worker identity](../../crewcoder-agent/docs/WORKER_IDENTITY.md).

## Provider and model discovery

Fresh TUI sessions and offline Codex picker defaults use `codex-cli`. The former
managed `codex` entry is removed. `/provider` and `/model` request catalogs from
the backend, including native Codex CLI and Claude Code discovery.

Claude discovery and execution use the same executable: `CREWCODER_CLAUDE_PATH`,
then installed `claude` on `PATH`, then the SDK bundle. A separately updated
Claude Code can expose new models before the SDK bundle does. In remote mode,
these executables and model discovery run on the backend host.

Change an existing backend default with
`crewcoder config set defaultProvider codex-cli`, then use `/reload` and `/model`.
See [backend provider discovery](../../crewcoder-agent/docs/PROVIDERS.md#automatic-model-discovery).

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
