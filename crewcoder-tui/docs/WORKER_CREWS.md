# Worker Crews in the TUI

CrewCoder workers are saved agent identities. A **single worker session** and a **crew run** are different workflows.

## Select one worker in the TUI

Open the agent picker with either command:

```txt
/modes
/workers
```

Choose a saved worker. The TUI then:

- sets the current session worker;
- shows `MODE: worker:<name>` in the status bar;
- changes the composer label to the worker name;
- passes `--worker <name>` to future `run` or `session resume` backend calls.

Selecting `general`, `plugin`, or `extension` clears the saved worker selection.

Workers must already exist. Create and inspect them from a shell:

```bash
crewcoder workers create reviewer --description "Reviews implementation quality"
crewcoder workers create builder --description "Builds focused changes"
crewcoder workers list
```

Then restart the picker or use `/reload` so the TUI refreshes CrewCoder metadata.

## Hand off the active session

Run `/handoff` without arguments to choose a target from the worker picker:

```txt
/handoff
```

Specify a worker and optional continuation prompt inline when you already know the target:

```txt
/handoff worker:reviewer Review the implementation and run relevant tests
```

The current session must already have a durable session id. Handoff copies its transcript and session context into a linked child session. On success, the TUI switches to the child session and selects the target worker. If no prompt is supplied, the backend uses its default continuation prompt.

## Run multiple workers

```txt
/crew architect,builder,reviewer Plan, implement, and review checkout validation
```

The first argument is a comma-separated worker list; everything after it is the task. Workers execute sequentially in separate durable sessions. The command inherits the provider, model, mode, effort, approval mode, and custom system prompt selected in the TUI. A crew run reports its output in the viewport and leaves the currently attached session unchanged.

## Run a declared team

Teams are loaded from `./crewcoder.json`. List them with:

```txt
/teams
```

Run a team with:

```txt
/team feature Add checkout validation
```

The first argument is the team id and the remainder is the task. Every role receives the configured team description, role instructions, handoff rules, and shared memory in addition to the task.

## Command discovery and errors

The commands appear in `/help` and the command palette. Common errors include:

- `/handoff` before the first saved agent turn: start or resume a session first;
- an unknown worker: create it with `crewcoder workers create <name>`, then use `/reload`;
- `/crew` without both a worker list and task;
- `/team` without both a team id and task;
- `/teams` with no `crewcoder.json` or no declared teams.

Crew lifecycle event streams still include `crew_start`, `crew_worker_start`, `crew_worker_end`, and `crew_end`. Hosts that feed those events into the TUI reducer can render the crew roster and active `AGENTS` status pill. Native slash-command runs currently display command output in the conversation viewport rather than attaching the TUI to every child session.

## Execution model

Crew workers currently execute sequentially in the local CLI process. The event/state model permits multiple workers to be marked active so a future concurrent runner will not require a new display contract.

A nested worker emits ordinary `agent_start` and `agent_end` events. Worker identity must come from `crew_worker_start` and `crew_worker_end`, not from those nested events.

See also:

- `../../crewcoder-agent/docs/WORKER_CREWS.md` for CLI crews, teams, handoffs, and delegation.
- `../AGENTS.md` for TUI event-rendering guardrails.
