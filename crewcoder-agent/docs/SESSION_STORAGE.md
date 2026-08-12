# Session Storage

CrewCoder stores conversation sessions as append-only JSONL logs under CrewCoder home:

```txt
~/.crewcoder/sessions/<session_id>/session.jsonl
```

Each line is one session entry. Legacy `session.json` snapshots are still loaded and migrated on read.
The JSONL is an internal durable/audit format, not the recommended conversation viewer. Use
`crewcoder sessions` to find an id, then `crewcoder session show <id>` to read the conversation or
`crewcoder session show <id> --out conversation.md` to create an ordinary Markdown file.

## What stays global

Only sessions are project-local. Other CrewCoder home data still uses the global CrewCoder home resolved by `CREWCODER_HOME`, root fallback, or `~/.crewcoder`:

- `config.json`
- `extensions/`
- `system-prompts/`
- `commands/`
- `cache/`
- `logs/`

## Session files

Each `session.jsonl` starts with a header entry and then append-only entries:

- `session` header (`id`, `timestamp`, `cwd`, provider/model, mode)
- `message` entries for user/assistant messages
- `tool` entries for tool results
- `compaction` entries for explicit/live compaction summaries
- `branch_summary` entries for future branch summaries
- `metadata` entries for events, mutation log, usage, checkpoints, and extension state
- `leaf` entries for future navigation/branch leaf changes

The public loader still returns a `SessionRecord` by building context from the current leaf path.

## Last-run settings (`runtime.json`)

```txt
~/.crewcoder/sessions/<session_id>/runtime.json
{"provider":"codex","model":"gpt-5.6-luna","effort":"high","updatedAt":"..."}
```

The `session` header is written once and never rewritten (the log is append-only,
and rewriting line 1 of a large session on every save is not viable), so it records
what the session *started* on. Switching provider, model, or effort mid-session
would otherwise send every later resume back to the original settings, and effort
was not persisted at all.

`runtime.json` is a fixed-size sidecar holding the most recent run's
provider/model/effort. It is rewritten only when one of those values changes, so
the header-only listing path can read it without losing its O(1)-per-session cost.

- `SessionRecord.provider`/`.model`/`.effort` report these last-run values; the
  header remains the fallback when the sidecar is absent.
- A missing, truncated, or wrongly typed sidecar silently degrades to the header
  values rather than pushing a bad model id into a resumed run.
- `crewcoder session resume` uses them when `--provider`/`--model`/`--effort` are
  omitted (explicit flags and env overrides still win, and a disabled
  `thinkingEnabled` config still forces effort `none`).
- The TUI restores them on `/sessions` resume, clamping a saved effort that the
  resumed provider/model does not support.
- `session prune` treats `runtime.json` as session state, never a disposable artifact.

## Resume behavior

Opening/resuming a session with no prompt is replay-only: CrewCoder emits the
saved transcript for the TUI and does not call the provider, create a child
session, invent a resume prompt, or compact history. A provider request starts
only after the user sends a new message.

Prompted continuations load the saved conversation messages and mutation context
from the current leaf, append the new user/assistant/tool entries to the same
`session.jsonl`, and keep the same session id. They do not attach a fresh
per-turn project background block to the resumed user message; that avoids
duplicating repo/session context in both the model input and TUI transcript.

## Compaction

`/compact` rewrites the current saved session in place. Older messages are replaced by a synthetic background summary while recent messages are retained. The session remains in the same project-local session file.
