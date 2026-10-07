# Session bundles

A session bundle moves one CrewCoder session to another machine so the conversation continues there
with the same context. CrewMate uses it for Crew handoff (PC to VPS and back); it works the same by hand.

```sh
crewcoder session bundle <id> --out move.ccbundle [--json]
crewcoder session import move.ccbundle [--cwd /new/workspace] [--replace] [--json]
```

## Two copies of the context

A session has two transcripts:

- **CrewCoder's own** `session.jsonl`: the source of truth. It works with every provider, survives
  provider switches, and drives compaction, checkpoints, `session show`, and replay in the UI.
- **The provider's native session**: Claude Code's project JSONL or a Codex rollout. It holds the
  provider's exact messages (thinking, native tool blocks, its system prompt), so resuming it keeps the
  history byte for byte and the prompt cache warm.

A bundle carries both, so Claude and Codex continue their own session on the new machine. If the
native session cannot be used there, CrewCoder replays its own transcript instead, so a move never
loses context.

## Format

A gzip file. The first line is a JSON header:

```json
{"format":"crewcoder-session-bundle","version":2,"sessionId":"...","exportedAt":"...","sourceCwd":"...","sourceHost":"...","crewcoderVersion":"...","runtime":{"provider":"...","model":"...","effort":"..."},"sessionBytes":12345,"native":[{"provider":"claude","providerSessionId":"<uuid>","relativePath":"<uuid>.jsonl","bytes":678}]}
```

Then the session's `session.jsonl` (`sessionBytes` long), then each native file listed in `native`,
back to back. Checkpoints and artifacts do not travel; the workspace moves separately (CrewMate's
workspace transfer), and checkpoints are tied to the old machine. Version 1 bundles (no native files)
still import.

Each file is copied up to a size that ends on a complete line, so a copy taken while a CLI appends is
still valid. Pause the session before bundling it anyway; CrewMate's handoff does.

## Native sessions

| Provider id | Native session | Found in |
|---|---|---|
| `claude` | Claude Code project JSONL | `$CLAUDE_CONFIG_DIR` (default `~/.claude`) `/projects/<folder>/<id>.jsonl` |
| `codex-cli` | Codex rollout | `$CODEX_HOME` (default `~/.codex`) `/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl` |
| `codex` | Codex rollout | `<CREWCODER_HOME>/codex-app-server/sessions/...` |

Only providers in the session's `providerSessionIds` with a file on this machine are carried. On import:

- Claude's file goes under the project folder for the new workspace (`/srv/work/app` becomes
  `-srv-work-app`), so Claude's own `/resume` list shows it there. Claude finds a session by id in any
  project folder, so other copies of the same id are moved to backups to leave one live copy.
- A Codex rollout keeps its `sessions/YYYY/MM/DD/` path. Other copies of the thread are moved to backups.
- Backups go to `<CREWCODER_HOME>/backups/native/<provider>/<time>/`. Nothing is deleted.
- The provider's id is kept in `providerSessionIds` only when its file was placed. A file that cannot
  be placed only costs the native resume.
- Codex resumes the moved thread because the continuation hash leaves out the workspace path (see
  `docs/CODEX_TRANSPORT.md`). A different model, system prompt, or tool set on the new machine
  starts a new thread with a replay instead.

Verified with real CLIs (Claude Code 2.1.289, Codex 0.160.0): a session moved to a new machine and
folder answered from a tool result that existed only in its history, with the prompt cache warm, and
taking it back returned a fact learned on the other machine.

## Import rules

- The session keeps its id, so the same session continues rather than a copy.
- An existing session with that id is refused (`SESSION_EXISTS`) unless `--replace`. With `--replace`
  the old session directory is moved to `<CREWCODER_HOME>/backups/sessions/<id>-<time>`, never deleted.
  Taking a session back is an import with `--replace`, because the old copy is still there.
- `--cwd` sets the workspace path on the new machine, so `crewcoder sessions` run in that folder lists
  the session. The header line is rewritten only in the private temp copy before it goes live; live
  session headers are never rewritten. Without `--cwd` the old path is kept.
- External directories are cleared, since those paths belong to the old machine.
- `runtime.json` is rebuilt from the header, so the session continues on the provider, model, and
  effort it last ran with.
- A one-time note (`pendingMoveNote`) tells the model the session moved and, when it changed, the old
  and new workspace path, so it does not trust stale absolute paths. It is added to the next prompted
  turn and cleared by that turn's save. Unlike `pendingResumeContext`, prompted resumes do carry it.

The bundle is read as a stream with a 4 GB cap and a 64 KB header cap into a temporary file in the
sessions directory, and every length, id, and native path is checked before anything goes live. The
header id must match the session inside, each native id must be one the session holds, and native paths
must match the provider's layout exactly. A bad bundle leaves nothing behind.

## Errors

With `--json`, failures print `{"error":{"code":"...","message":"..."}}` and exit with code 3:

| Code | Meaning |
|---|---|
| `SESSION_EXISTS` | The id is already on this machine; pass `--replace` |
| `INVALID_BUNDLE` | Not a session bundle, a newer version, an invalid id or path, lengths that do not add up, or ids that do not match |
| `SESSION_NOT_FOUND` | `session bundle` was given an unknown id |

`session bundle` refuses to overwrite `--out` and writes the file owner-only (0600), because a
transcript can contain anything the user pasted.

## Limits

- The CLI on the new machine must read the native file. An older Claude Code or Codex than the one
  that wrote it may not; Claude then falls back to the replay through its "No conversation found"
  retry and Codex through its failed `thread/resume` path. Other Claude errors are not retried, so
  keep the CLIs on both machines at similar versions.
- Codex keeps per-thread SQLite indexes beside the rollouts. They are not carried; the CLI resumed
  from the rollout alone in testing, including on a machine whose index already listed the thread.

## Files

- `src/core/session-bundle.ts`: export, import, and the moved-session note.
- `src/core/native-session-files.ts`: finding, validating, and placing Claude and Codex session files.
- `src/core/agent-loop.ts`, `agent-loop-continue.ts`: deliver `pendingMoveNote` once.
- `src/providers/codex-app-server-provider.ts`: the path-independent continuation hash.
- `src/cli.ts`: the `session bundle` and `session import` commands.
- Tests: `src/tests/session-bundle.test.ts` (round trip with native files, take back with backups,
  version 1, hostile headers), `src/tests/codex-app-server-provider.test.ts` (thread kept across paths,
  legacy hash), `src/tests/agent-loop.test.ts` (note delivered once).
