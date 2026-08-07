# Worker Crews

Worker crews let multiple named CrewCoder workers run coordinated tasks while keeping each worker's identity and session separate.

## Run a crew

```bash
crewcoder crew run --workers reviewer,builder "Implement feature X"
```

Each worker listed in `--workers`:

- must already exist (`crewcoder workers create <name>`),
- runs with its own worker identity,
- gets its own durable session,
- uses the selected provider/model/options for the run.

Useful options mirror `crewcoder run`:

```bash
crewcoder crew run \
  --workers architect,implementer,reviewer \
  --provider codex \
  --model gpt-5 \
  --max-iterations 4 \
  "Plan and build the checkout flow"
```

Use `--json` for a machine-readable summary. Use `--json-events` to stream the underlying worker run events. Crew orchestration adds `crew_start`, `crew_worker_start`, `crew_worker_end`, and `crew_end` lifecycle events around each worker stream so hosts can display pending, active, completed, and failed agents without inferring identity from nested agent events.

## Use workers and crews from the TUI

Workers must already exist before the TUI can use them. Create them from a shell:

```bash
crewcoder workers create architect
crewcoder workers create builder
crewcoder workers create reviewer
```

Use `/reload` after creating workers, or restart the TUI.

### Select one worker

```txt
/modes
/workers
```

Choose a worker from the picker. Future prompts use that identity, the composer shows its name, and the status bar displays `MODE: worker:<name>`. Selecting `general`, `plugin`, or `extension` clears the worker.

### Hand off the active session

Open a worker picker:

```txt
/handoff
```

Or specify the worker and optional continuation prompt directly:

```txt
/handoff worker:reviewer Review the implementation and run relevant tests
```

A handoff requires an active saved session. It creates a child session containing the source transcript and session context, then switches the TUI to the new session and target worker. Omitting the prompt uses CrewCoder's default continuation instruction.

### Run a worker crew

```txt
/crew architect,builder,reviewer Plan, implement, and review checkout validation
```

Worker names are comma-separated with no spaces. Each worker receives the task and runs sequentially in its own durable session. The run inherits the TUI's active provider, model, mode, effort, approval mode, and custom system prompt. It does not replace the TUI's current session.

### List and run worker teams

List teams declared in the workspace's `crewcoder.json`:

```txt
/teams
```

Run one of those teams:

```txt
/team feature Add checkout validation
```

Each team role receives the task plus its configured description, role prompt, handoff rules, and shared memory. Team roles run sequentially and create separate durable worker sessions.

All commands are also discoverable from `/help` or the command palette. Errors and run summaries are printed in the conversation viewport. See `../../crewcoder-tui/docs/WORKER_CREWS.md` for the full TUI workflow.

## Handoff to another worker

```bash
crewcoder crew handoff worker:reviewer <sessionId> "Review the implementation"
```

Handoff starts a new session with the target worker, reusing the source transcript, mutation log, usage, compactions, checkpoints, and extension session entries as context. The new session records the source session as its parent.

If no prompt is provided, CrewCoder uses a default continuation prompt asking the target worker to continue from the handed-off transcript.

## Child worker delegation

Agents can use the built-in `delegateWorker` tool to spawn a bounded child worker for a scoped subtask. The child gets the parent transcript, cwd, mutation log, provider/model, approval mode, and a child session linked back to the parent session.

The tool accepts:

```json
{
  "worker": "researcher",
  "task": "Find docs on the package API and summarize constraints.",
  "maxIterations": 2
}
```

Delegation is depth-limited by default so child workers cannot recursively spawn unlimited workers.

## Worker teams

A repository can declare teams in `./crewcoder.json`:

```json
{
  "teams": {
    "feature": {
      "description": "Plan, build, and review features",
      "roles": [
        { "worker": "architect", "role": "Plan", "prompt": "Design the approach first." },
        { "worker": "builder", "role": "Build", "prompt": "Implement the approved plan." },
        { "worker": "reviewer", "role": "Review", "prompt": "Review for correctness and regressions." }
      ],
      "handoffRules": ["architect before builder", "reviewer after builder"],
      "sharedMemory": ["Prefer small diffs", "Run relevant checks before final summary"]
    }
  }
}
```

List teams:

```bash
crewcoder crew team list
```

Run a team:

```bash
crewcoder crew team run feature "Add checkout validation"
```

Each role receives the base task plus team description, role instructions, handoff rules, and shared memory.

## Current limitations

Worker and team runs are sequential in the local CLI process. Team handoff rules are prompt context only; CrewCoder does not yet enforce a dependency graph, shared memory store, or remote runners.
