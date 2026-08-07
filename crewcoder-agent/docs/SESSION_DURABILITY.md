# Session Durability

How much of a run survives when it does not finish cleanly.

## Contract

A session is persisted **after every completed turn**, not only at the end of the run.
A turn is one loop iteration: one provider request plus the tools it called.

```txt
turn_end          -> saveSession()   (silent, best-effort)
agent_error       -> saveSession()   (silent, best-effort) then rethrow
end of run        -> saveSession()   -> session_saved event
```

Only the final save emits `session_saved`. Incremental saves are deliberately silent so
the event stream shape is unchanged for hosts.

## Why per-turn

`saveSession` used to run exactly once, after the loop. Anything that stopped a run before
that point discarded the entire transcript, including tool results for files the agent had
already written to disk:

- `/stop` or Esc in the TUI (`SIGTERM` to the backend child)
- Ctrl+C in a headless run (`SIGINT`)
- a provider throwing mid-run (auth expiry, network, billing)
- process crash or OOM

An agent that changed twelve files and then hit an auth error left a session file claiming
it had done nothing.

## Cost

The JSONL store is append-only and delta-based (`session-store.ts`): a save appends only
entries added since the last one. Measured on a synthetic 120-turn session with ~8 KB of
message content per turn:

```txt
turn  30   1.0ms
turn  60   1.9ms
turn  90   2.2ms
turn 120   3.2ms
total      255ms across 120 saves (avg 2.1ms)
```

Per-save cost grows linearly with session length because the delta is computed against the
existing file. At ~2ms against multi-second model turns this is not a meaningful budget.
If it ever becomes one, the fix is an in-memory persisted-cursor, not less frequent saving.

## Best-effort mid-run, strict at the end

`persistTurn` swallows failures into a `backend_debug` warn. Durability matters, but killing
a working run because a disk write failed is worse. The final `persistCurrentSession` call is
not wrapped, so a genuinely broken store still surfaces.

This mirrors the cost-ledger precedent: accounting and durability degrade loudly but never
take down a run.

## Signal handling

`installSignalFlush()` in `cli.ts` installs `SIGTERM`/`SIGINT` handlers that drain in-flight
session writes before exiting.

This is not about finishing the current turn — a stop must stop. It exists because
`session.jsonl` is appended in whole-entry chunks and an append is **not atomic**. A process
killed mid-write can leave a truncated line, and one unparseable line makes the whole session
unreadable (it degrades to a header stub with `loadError`). Per-turn saving multiplies the
number of those windows, so the handler closes them.

```txt
SIGTERM -> drain writes -> exit 143
SIGINT  -> drain writes -> exit 130
second signal            -> exit 130 immediately
```

`whenSessionWritesSettle()` in `session-store.ts` is the drain primitive. A second signal
bypasses it: the user insisting must always win over the flush.

## What is still lost

The turn in flight when the run dies. Its assistant message and any tool results from that
turn are not persisted, because they were never appended. Everything through the previous
`turn_end` survives.

Detached goals (`docs/DURABLE_GOALS.md`) are the mechanism for surviving process death
mid-turn; ordinary runs do not claim that guarantee.

## Guarded by

```txt
src/tests/agent-loop.test.ts
  - persists each completed turn so a run killed mid-flight keeps its transcript
  - keeps completed turns when the provider fails mid-run
src/tests/session-store.test.ts
  - whenSessionWritesSettle waits for an in-flight save to finish
  - whenSessionWritesSettle resolves immediately when nothing is writing
```

Both agent-loop tests were verified to fail when the `persistTurn` calls are removed.
