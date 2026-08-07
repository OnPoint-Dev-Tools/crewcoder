# Session Checkpoints and Rewind

CrewCoder creates filesystem checkpoints before built-in mutating tools run when automatic checkpoints are enabled. A checkpoint is a bounded snapshot of the current workspace that can be restored later to rewind files.

## What is captured

Checkpoints copy regular workspace files into the session directory before a mutating tool executes.

Excluded directories:

- `.git`
- `.crewcoder`
- `node_modules`
- `dist`
- `build`
- `coverage`
- `.next`
- `.turbo`

Safety bounds:

- Maximum 2,000 files per checkpoint
- Maximum 25 MB per checkpoint
- Maximum 10 checkpoints per session

When an eleventh checkpoint is successfully created, CrewCoder deletes the oldest checkpoint directory and retains the 10 newest snapshots. If a checkpoint hits a file or byte bound, it is marked `truncated`. Truncated checkpoints are still restorable, but only for the files that were captured.

## Where checkpoints live

Checkpoints are stored under the session folder:

```txt
~/.crewcoder/sessions/<session-id>/checkpoints/<checkpoint-id>/
├── manifest.json
└── files/
```

The session record also stores checkpoint metadata in `SessionRecord.checkpoints`.

## Enable or disable automatic checkpoints

Automatic checkpoints are enabled by default, including for existing config files that do not yet contain the setting. Persist the preference with:

```bash
crewcoder config set checkpointsEnabled true
crewcoder config set checkpointsEnabled false
```

The TUI exposes the same backend setting:

```txt
/checkpoints on
/checkpoints off
/checkpoints status
```

The setting is read when a run starts. Turning automatic checkpoints off prevents future runs from creating pre-mutation snapshots. It does not delete existing checkpoints, which remain available to list and rewind. Trusted extensions that explicitly call `ctx.checkpoints.create()` still create an intentional checkpoint.

## CLI

List checkpoints:

```bash
crewcoder session checkpoints <session-id>
crewcoder session checkpoints <session-id> --json
```

Preview a restore without changing files. JSON preview includes `restoreFiles`, `deleteFiles`, `changedFiles`, `missingFiles`, `unchangedFiles`, and bounded text `diffs` for changed files:

```bash
crewcoder session rewind-preview <session-id> <checkpoint-id>
crewcoder session rewind-preview <session-id> <checkpoint-id> --json
```

Restore a checkpoint into its original workspace:

```bash
crewcoder session rewind <session-id> <checkpoint-id>
```

Restore into a different workspace path:

```bash
crewcoder session rewind <session-id> <checkpoint-id> --cwd /path/to/workspace
```

Rewind restores captured files and deletes non-excluded files that were created after the checkpoint. Excluded directories are never deleted by rewind.

## Event stream

When a checkpoint is created, the backend emits:

```json
{
  "type": "checkpoint_created",
  "checkpointId": "checkpoint_...",
  "sessionId": "session_...",
  "reason": "Before write",
  "toolCallId": "call_...",
  "toolName": "write",
  "fileCount": 42,
  "totalBytes": 12345,
  "truncated": false
}
```

## TUI

The TUI tracks `checkpoint_created` events internally for `/rewind`, but does not add checkpoint-save markers to the main transcript. This keeps routine snapshot activity out of the conversation viewport.

`/rewind` opens a picker when multiple checkpoints are known in the active TUI session. `/rewind latest` restores the most recent checkpoint, and `/rewind <checkpoint-id>` restores a specific checkpoint. Before restoring, the TUI runs `crewcoder session rewind-preview ... --json` and shows restore/delete counts plus bounded diff lines for changed text files. If the preview includes deletes, the TUI asks for explicit confirmation before restore. The command refuses to run while a model request or another CrewCoder command is active.

## Extension helpers

Trusted module extensions can use checkpoint helpers from `ctx.checkpoints`:

```ts
crew.handleEvent("agent_event", { types: ["session_saved"] }, async (_event, ctx) => {
  const checkpoint = await ctx.checkpoints.create("After session save");
  ctx.ui.notify(`Created ${checkpoint.id}`);
});
```

Available checkpoint helpers:

- `ctx.checkpoints.create(reason)` creates a bounded snapshot for the active session.
- `ctx.checkpoints.list()` lists checkpoints for the active session.
- `ctx.checkpoints.preview(checkpointId)` returns restore/delete/changed/missing file lists.

Git workflow helpers are also available on the same context:

- `ctx.git.status()` returns `{ branch, clean, entries, raw }` from `git status --porcelain`.
- `ctx.git.currentBranch()` returns the current branch name when available.
- `ctx.git.changedFiles()` returns unique changed/untracked file paths.
- `ctx.git.createCheckpoint(reason)` aliases checkpoint creation with git-workflow naming.
- `ctx.git.issueReferences()` extracts issue-like references such as `#123`, `GH-123`, and `issue_123` from branch/status/recent commit text.
- `ctx.git.reviewSummary()` returns branch, clean/dirty state, changed files, issue references, and raw status details for review flows.

Rewind restores write a `checkpoint_restored` event and append `checkpointRestores[]` metadata to the session record. Rewind is intentionally not exposed to extensions yet. Use the CLI/TUI rewind path so users stay in control of destructive restores.

Review summaries can be queried without an extension:

```bash
crewcoder git review-summary
crewcoder git review-summary --json
```

The summary includes branch, clean/dirty state, changed files, issue references, and issue URLs for recognized GitHub/GitLab remotes.

## Current scope

This slice covers configurable local filesystem checkpoints, CLI rewind/preview, hidden TUI checkpoint tracking, TUI `/rewind`, checkpoint picker, delete confirmation, bounded preview diffs, and non-destructive extension checkpoint helpers. Rich side-by-side diff views and git merge helpers should build on this core instead of inventing separate state.
