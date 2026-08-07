# External directories

CrewCoder's TUI can grant a session access to directories outside its primary workspace.

```text
/add-dir /path/to/shared-project
/remove-dir
/remove-dir /path/to/shared-project
```

`/add-dir` without a path lists the current roots and usage. `/remove-dir` without a path opens a
picker. The TUI validates paths through the CrewCoder CLI, stores the canonical paths in
`TuiState.externalDirectories`, and passes them as repeatable `--add-dir` options on new and
resumed subprocess runs.

For an already-durable session, add/remove commands update session metadata immediately through
`crewcoder session add-dir|remove-dir`. Selecting a saved session restores its grants from
`session list --json`. `/new` clears all grants so access never leaks between sessions.

In local mode paths refer to the local machine. In CrewCoder TUI SSH mode validation runs through
the remote CrewCoder CLI, so paths refer to the remote host. This differs from CrewCode's desktop
directory picker, which intentionally rejects local picker results for SSH workspaces.

Core authorization, persistence, sandbox behavior, and ACP synchronization are documented in
`crewcoder-agent/docs/EXTERNAL_DIRECTORIES.md`.
