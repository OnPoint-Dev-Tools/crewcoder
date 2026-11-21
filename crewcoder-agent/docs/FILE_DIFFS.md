# Per-tool file diffs (`file_diff`)

Every file edit/write tool call emits a `file_diff` event with the exact changes it made to
files it **created or modified**: CrewCoder `edit`, `write`, `edit_transaction`,
`edit_symbol`, and provider-native edit tools (Claude `Edit`/`MultiEdit`/`Write`/
`NotebookEdit`, Codex `Codex file change`, `apply_patch`). Shell commands, git primitives,
generators, and delegated workers are **never** diffed, and deleted files are never reported
(owner decision: diffs belong to file edits; command diffs are not practical). Hosts render
it inline under the tool (OpenTUI: `crewcoder-opentui/docs/TRANSCRIPT.md`, "Inline diffs").

```txt
{ "type": "file_diff", "toolCallId": "...", "toolName": "edit",
  "files": [ { "path": "src/a.ts", "status": "added|modified",
               "additions": 3, "deletions": 1, "binary": false, "truncated": false,
               "patch": "diff --git a/src/a.ts b/src/a.ts\n..." } ] }
```

- Emitted **before** the tool's `tool_execution_end`, only when something changed.
- `path` is workspace-relative. `patch` is one file's unified git diff (3 lines of context);
  it is omitted for binary files and for patches over 64 KB (`truncated: true`, counts kept).
  At most 50 files per tool call.
- `file_diff` does not replace `file_changed`, which still reports CrewCoder mutation-log paths
  for extension file triggers and audit.

## How it works (`src/core/workspace-diffs.ts`)

`WorkspaceDiffTracker` keeps a **private snapshot git directory** per workspace at
`<CREWCODER_HOME>/snapshots/<sha256(cwd)[0:16]>`, with the workspace as its work tree. A
snapshot is `git add --all` into that private index plus `git write-tree`; a diff is
`git diff <before-tree> <after-tree>`.

- The user's own repository, index, refs, and hooks are never read or written. Inherited
  `GIT_*` variables are dropped and `GIT_DIR`/`GIT_WORK_TREE` point at the private store.
  Works in non-git workspaces too.
- The workspace's `.gitignore` applies, plus default excludes (`node_modules/`, `dist/`,
  `build/`, `coverage/`, `.next/`, `.turbo/`, `.crewcoder/`, `.venv/`, `target/`,
  `__pycache__/`).
- Cost: the first snapshot of a workspace hashes its files (about 100 ms on this monorepo);
  later ones reuse git's stat cache (about 10 ms).
- Operations are serialized (one private index). Any git failure, a missing `git`, or a
  snapshot slower than 10 s disables tracking for the rest of the run with one
  `backend_debug` warning (`source: "workspace-diffs"`); tools are never slowed or failed by it.
- Disabled for the filesystem root and the home directory, for virtual/hosted filesystems
  (ACP remote files, hosted text tools), and by `crewcoder config set fileDiffs false`.

## Which calls are snapshotted

`isFileEditTool(name)`, by tool name only: `edit`, `multiedit`, `write`, `notebookedit`,
`strreplace`, `createfile`, `editsymbol`, `edittransaction`, `codexfilechange`, `applypatch`
(normalized: lower case, separators and MCP prefix removed). CrewCoder's `isMutation` flag is
deliberately not used: it also covers git primitives and generators. Reads, searches, and
commands are never snapshotted.

- **CrewCoder-executed tools**: the "before" snapshot is awaited before the tool runs.
- **Provider-native tools** run in the provider, which may announce them after they start
  writing. The loop calls `prime()` before every model turn; their baseline is that
  snapshot (or the last finished tool's), never one taken mid-flight.
- **Overlapping (parallel) tools**: each diff starts from the later of the tool's own
  baseline and the last finished tool's snapshot, so a change is credited to the first
  tool that finishes after it and never reported twice.

## Limits

- Changes made by the user or another process while a tool runs are attributed to it.
- The snapshot store grows with changed file contents (unchanged blobs are shared). It is
  not pruned yet; deleting `<CREWCODER_HOME>/snapshots` is safe at any time.

## Tests

`src/tests/workspace-diffs.test.ts` (created/modified only, no deletions, excludes, the
user's repo untouched, parallel attribution, primed baselines, home-directory refusal, binary
and oversized patches, tool classification) and `src/tests/agent-loop.test.ts` (edit and
write diffs before their `tool_execution_end` and none for `bash`; a provider-native file
change that wrote before it was announced, and none for a native command).
