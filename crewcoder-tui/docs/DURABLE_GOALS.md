# Durable goals in the TUI

CrewCoder's `/goal` command launches a provider-independent detached worker. The worker continues after the TUI closes; the TUI does not duplicate or host the goal loop.

## Commands

```txt
/goal              Open the per-goal preflight editor
/goal <objective>  Start immediately with inherited goal defaults
/goal --max-turns 50 --check-model gpt-5.6-luna --timeout-minutes 120 "<objective>"
/goal --no-check-model "<objective>"
/goal status       Refresh the current goal card
/goal list         Render recent workspace goals
/goal pause        Stop the worker and preserve resumable state
/goal resume       Restart the preserved goal
/goal clear        Cancel the current goal and allow a replacement
/goal approve      Approve the persisted pending tool call
/goal deny         Deny the persisted pending tool call
/goal logs         Show recent durable goal events
```

Bare `/goal` opens a preflight editor for the objective, maximum supervisor cycles, same-provider checker model, and wall-clock timeout. It starts with the global `goals` defaults, but submitted values apply only to the new goal and do not rewrite `config.json`. Clear the checker field to disable independent verification for that goal. Use Tab or Up/Down to move fields, Enter to advance/start, Ctrl+S to start, and Esc to cancel.

Inline flags provide the same per-goal overrides without opening the editor. Quoted objectives and `--flag=value` are supported. Omitted settings inherit the global defaults.

The selected reasoning effort, system prompt, worker, token budget, and full-access/review mode are also passed when starting a goal. Resume uses the TUI's current approval mode. Goal settings are snapshotted when the goal starts.

## Rendering

Goal JSON is rendered as a dedicated transcript card rather than raw command output. The card shows:

- lifecycle status and goal id
- objective
- maker provider/model, cycle count, and maximum cycles
- same-provider verifier model and latest `continue|complete` reason
- wall-clock timeout
- durable session id
- pending approval and `/goal approve|deny` controls
- pause/failure reason
- completion summary and evidence

Starting a goal only keeps `state.running` true for the short CLI launch command. Once the detached worker is spawned, the composer becomes available again. Use `/goal status` to refresh durable state.

See `crewcoder-agent/docs/DURABLE_GOALS.md` for process supervision, persistence, completion tools, and approval behavior.
