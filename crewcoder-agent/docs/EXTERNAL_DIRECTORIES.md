# Session-scoped external directories

CrewCoder sessions may grant access to selected directories outside the primary workspace. Grants
are explicit, durable, revocable, and scoped to one session; they are not global configuration.

## CLI and TUI

The standalone TUI supports:

```text
/add-dir /absolute/path/to/shared-library
/remove-dir
/remove-dir /absolute/path/to/shared-library
```

`/remove-dir` without a path opens a picker. `/add-dir` without a path lists current grants and
shows usage. A new session starts with no external directories.

The equivalent CLI operations are:

```bash
crewcoder run --add-dir ../shared "inspect the shared package"
crewcoder session resume <id> --add-dir ../shared "continue"
crewcoder session directories <id>
crewcoder session add-dir <id> ../shared
crewcoder session remove-dir <id> ../shared
crewcoder session remove-dir <id> --all
```

Repeat `--add-dir` to attach multiple roots. Paths are canonicalized, must already exist as
directories, and the filesystem root is refused. A session may hold at most 32 grants.

## Tool behavior

`ToolContext.externalDirectories` extends the path allowlist used by file-oriented tools:

- `read`, `write`, `edit`, and transactional/symbol edits;
- `grep` and `listFiles`;
- plugin creation/validation when an explicitly granted output path is supplied.

Relative paths still resolve from the primary workspace. Use an absolute path to address an
external root. Tool results, mutation logs, and audit events keep external paths absolute rather
than rendering misleading `../` workspace paths. Git and LSP tools remain rooted in the primary workspace because their server/repo
state is workspace-specific rather than a generic filesystem operation.

Sandboxed shell commands bind the primary workspace and granted roots read-write. Without an OS
sandbox, `bash` retains its existing host-shell authority; external-directory grants do not claim
to constrain arbitrary shell syntax.

Filesystem checkpoints remain primary-workspace snapshots. They do not capture or rewind changes
to external directories, so external mutations still require the normal approval gate and should
be used deliberately.

## Persistence

`SessionRecord.externalDirectories` is stored in the append-only session JSONL metadata. Updating
grants appends metadata rather than rewriting transcript history. Branches inherit the source
session grants; genuinely new sessions start empty.

The active roots are included in the per-run system context so newly added or removed grants are
visible on resumed turns without confusing them with the primary repository.

## ACP and CrewCode

CrewCoder exposes the additive ACP extension method:

```json
{
  "method": "session/set_external_directories",
  "params": {
    "sessionId": "session_...",
    "directories": ["/absolute/shared"]
  }
}
```

CrewCode calls it after `session/new` or `session/load`. CrewCode's session state is authoritative:
an empty array revokes all prior grants. CrewCoder validates the directories on the machine where
its ACP process runs and persists changes for an already-started session.

ACP text reads/writes continue through the client filesystem capability when advertised. Path
authorization happens in CrewCoder before it asks the client to perform the operation.

## Security boundaries

- Grants are per session and never copied into a new session implicitly.
- The filesystem root cannot be granted.
- Paths outside the workspace and explicit roots are rejected by file tools.
- Removing a grant takes effect before the next bridge/run starts.
- CrewCode rejects its local directory-picker flow for SSH workspaces; CrewCoder's own remote TUI
  may grant paths that exist on the remote host.
- Path authorization resolves symlinks in the nearest existing ancestor, including for new-file
  writes, so a symlink inside an allowed root cannot escape to an ungranted directory.
