# crew-tasks

`crew-tasks` is CrewCoder's native project task tracker, task model into CrewCoder.

## Enable and disable

`crew-tasks` is disabled by default. Enable it explicitly:

```bash
crewcoder task on
```

In the TUI, use:

```txt
/task on
```

Disable the entire task extension with:

```bash
crewcoder task off
```

or:

```txt
/task off
```

When disabled, CrewCoder does not expose task tools to the agent and does not inject task guidance. Existing task data is not deleted.

## Storage

Global config lives at:

```txt
~/.crewcoder/tasks/config.json
```

When `CREWCODER_HOME` is set, tests and isolated runs store config under:

```txt
$CREWCODER_HOME/tasks/config.json
```

Project task data lives in the current project:

```txt
.crewcoder/tasks/tasks.json
.crewcoder/tasks/sessions.json
```

## TUI task widget

When `crew-tasks` is enabled, the CrewCoder TUI renders a compact task widget above the status/composer area. It shows:

- total task count
- completed/in-progress/open counts
- active tasks first
- pending tasks next
- completed tasks last
- blocker and owner hints when present

The widget reads `.crewcoder/tasks/tasks.json` on render, so `/task` commands and agent task-tool updates appear without restarting the TUI.

## CLI and TUI commands

Supported commands:

```txt
crewcoder task status
crewcoder task on
crewcoder task off
crewcoder task list
crewcoder task add <subject>
crewcoder task start <id>
crewcoder task done <id>
crewcoder task delete <id>
crewcoder task clear-completed
```

The TUI accepts the same commands through `/task`, for example:

```txt
/task list
/task add Fix provider stream regression
/task done 1
```

## Agent tools

When enabled, the agent receives these tools:

- `TaskCreate`
- `TaskList`
- `TaskGet`
- `TaskUpdate`
- `TaskDelete`

Agent-created tasks are automatically associated with the current CrewCoder session ID and persisted in the project `.crewcoder/tasks` store.

## Agent todo integration

`crew-tasks` acts as the persistent project/session-aware todo layer. When enabled, CrewCoder's system prompt tells the agent to use task tools for complex multi-step work, mark tasks `in_progress` before starting, and mark tasks `completed` only after the work is fully done.
