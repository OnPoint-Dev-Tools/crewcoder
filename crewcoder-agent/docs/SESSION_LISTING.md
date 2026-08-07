# Session Listing

Listing sessions is a hot path — `/sessions` in the TUI, `crewcoder sessions`,
`crewcoder session list`, and the SDK admin API all hit it. It must stay cheap
regardless of how large the session store grows.

## The rule

**A listing reads session headers. It never reads message bodies.**

Every field a listing renders lives in the first JSONL line of a session file:

```txt
id · startedAt · cwd · requestedMode · resolvedMode · prompt
provider · model · parentSessionId · externalDirectories · systemPrompt
```

`listSessionHeaders()` in `src/core/session-store.ts` reads that one line and
destroys the stream. `listSessionSummaries()` in `src/core/session-admin.ts` is the
public entry point and uses it by default.

## What went wrong before

Two independent O(store-size) costs stacked on the same command:

1. **`listSessionsForProject` fully parsed every session** — messages, events,
   mutation log, model turns — then discarded all of it. The `cwd` filter ran
   *after* the parse, so listing a project with zero matching sessions still paid
   the full cost.
2. **`printSessions` serialized whole `SessionRecord`s to JSON**, piped them to the
   TUI, and the TUI `JSON.parse`d them back — to render six header fields. It also
   applied `.slice(0, 20)` *after* loading everything.

Measured on a real store (511 sessions, ~570 MB of JSONL):

| | before | after |
| --- | --- | --- |
| `listSessionSummaries()` | 4241 ms | **183 ms** |
| `listSessionSummaries({ cwd })`, 0 matches | 4106 ms | **117 ms** |
| `session list --json` (wall clock) | 7.77 s | **0.85 s** |
| `session list --json` payload | 268 MB | **64 KB** |

The remaining 0.85 s is almost entirely Node startup, not work.

## `messageCount` is opt-in

`messageCount` is the one summary field not present in the header, so it is the one
field that forces a full parse. It is therefore gated:

```ts
listSessionSummaries()                              // header-only, no messageCount
listSessionSummaries({ includeMessageCount: true }) // full parse
```

`toSessionSummary()` deliberately does **not** derive `messageCount` from a header
record. A header has `messages: []`, so deriving it would report a confident `0`
rather than an honest "not loaded" — the same class of bug as reporting `$0.00` for
an unpriced model. Absent and zero are different facts.

## Invariants to preserve

- The `session` header entry must stay the **first line** of `session.jsonl`.
  `recordToJsonl` writes it first on both the create and the atomic-rewrite path.
- A listing must never regress to `listAllSessions`/`listSessions` — those exist for
  callers that genuinely need message and event bodies (replay, search, export).
- The header path must tolerate a corrupt body. A session whose later lines are
  unparseable still lists correctly, because those lines are never read.
- Legacy single-JSON `session.json` files have no cheap header and fall back to a
  full read. They are small and rare; do not optimize this away by dropping support.
- `loadSessionHeaderStub` (used when a *full* parse fails) shares the same header
  reader, so a broken session still surfaces with `loadError` instead of vanishing.

Guarded by `src/tests/session-listing.test.ts`, which asserts header fields, absent
`messageCount`, cwd filtering and sort order, parity with the full-parse path, and
that a session with a deliberately corrupted body still lists.

## Store size is a separate problem

Header-only listing makes load time independent of session size, but it does not
shrink the store. On the measured machine `~/.crewcoder/sessions` held 2.0 GB:

```txt
825 MB  checkpoints/       23,348 files (10 snapshots retained per session)
568 MB  session.json(l)    largest single session 101 MB
538 MB  *.bloated.bak      one leftover file from an earlier bloat fix
```

These affect disk, backups, and full-parse operations (`session why`, `search`,
`export`) — not listings. Reclaim them with `crewcoder session prune`; see
[SESSION_PRUNE.md](SESSION_PRUNE.md). Pruning is never automatic.
