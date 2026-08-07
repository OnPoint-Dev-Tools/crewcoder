# Session Prune

`crewcoder session prune` reports and reclaims disk used by the session store. It is
the only sanctioned way to delete session data in bulk.

```bash
crewcoder session prune                                  # report leftover artifacts
crewcoder session prune --apply                          # delete them
crewcoder session prune --checkpoints --older-than 30    # report old checkpoints
crewcoder session prune --sessions --older-than 90 --apply
crewcoder session prune --keep session_abc --sessions --older-than 90
crewcoder session prune --json
```

## Safety model

**Dry run is the default.** Nothing is deleted without `--apply`. There is no
interactive confirmation prompt on purpose: a prompt would make the command unusable
in CI and scripts, and would train users to answer `y` reflexively. An explicit flag
is a better gate than a question.

**Categories are opt-in and asymmetric in risk:**

| Flag | What it removes | Age required |
| --- | --- | --- |
| `--artifacts` (default) | Files in a session directory that are neither `session.jsonl`/`session.json` nor `checkpoints/` | no |
| `--checkpoints` | The `checkpoints/` tree for sessions older than the threshold | **yes** |
| `--sessions` | Whole session directories older than the threshold | **yes** |

`--artifacts` is the default because it is the only category that cannot change
behavior: nothing under it is reachable by any code path. It is how the 538 MB
`session.jsonl.bloated.bak` leftover was found and removed.

`--checkpoints` and `--sessions` **hard-error without `--older-than`**. Without that
guard, a bare `--sessions` would delete the entire store, and the cost of a typo
would be unbounded.

**Age comes from the session header, not mtime.** A session file is rewritten on
every save, so mtime reports when a session was last *touched*, not how old the work
is. Resuming a year-old session would otherwise make it look brand new — or, worse,
an untouched-but-recent session look ancient. `listSessionHeaders()` supplies
`startedAt` cheaply, so this costs nothing.

**Delete-time containment.** `SessionPrunePlan` is a plain object, so a caller could
alter it between planning and applying. Every target is therefore re-validated at
delete time: it must resolve inside the sessions directory, must not be the sessions
directory itself, and must not be a symlink. A symlinked artifact is refused rather
than followed — otherwise a link planted in a session directory would turn prune into
an arbitrary-file-deletion primitive.

**Failures are per-target.** One undeletable path is recorded in `failures` and
reported, and the command exits non-zero, but the remaining targets still get
cleaned. A single permission error must not abandon a 500 MB cleanup.

## Output

Human output lists the 20 largest targets with size, kind, session id, and the reason
that target was selected, then a total. `--json` emits the full `SessionPrunePlan`
(`targets`, `totalBytes`, `sessionsScanned`, `applied`, `failures`).

`applied` distinguishes a report from a deletion, and after `--apply` the `targets`
array contains only what was *actually* removed — never what was merely planned.

## What it does not do

- It does not run automatically, on a schedule, or as part of any other command.
- It does not enforce the `MAX_SESSION_CHECKPOINTS = 10` per-session retention; that
  is applied at checkpoint-creation time and is unrelated.
- It does not know which sessions are currently running. Use `--keep <id>` for
  anything active, and prefer a conservative `--older-than`.

Guarded by `src/tests/session-prune.test.ts`: dry-run-by-default, apply-deletes,
session files and checkpoints never counted as artifacts, the age-threshold
requirement, header-based age selection, `--keep`, and symlink refusal.
