# Session Compaction Progress

CrewCoder TUI shows a visible progress meter when `/compact` is run after a model response has finished.

## Post-run compaction only

`/compact` compacts the current saved session through:

```bash
crewcoder session compact <id> --json
```

The TUI displays a meter while the command is running and completes it when the command succeeds.

## Active runs

`/compact` is intentionally disabled while the model is running. Compacting a conversation while a provider call is in flight is confusing and can create unsafe timing behavior, so the TUI shows a skipped compaction notification:

```txt
Cannot compact while the model is running. Wait for the current response to finish, then run /compact.
```

## Tiny sessions

If the saved session is too small to compact, the CLI returns `compacted:false`. The TUI keeps this visible with a skipped meter:

```txt
Nothing to compact yet — this session is still too small.
```

## Failed compaction

If the CLI command fails, the meter ends in a failed state with the stderr or error message.
