# Auto-Compaction & Context Usage Tracking

CrewCoder can automatically compact a long-running session's context when it grows past a
configurable token threshold, and tracks detailed per-model token usage. Manual compaction is
always available alongside the automatic path.

## What problem this solves

A single long session grows its message history until the provider rejects the request. Before this
feature, deterministic compaction only ran **once, at resume start**, and was message-count based.
Now compaction is **token-aware**, runs **mid-session**, produces a **comprehensive LLM-generated
summary** (with a deterministic fallback), and can be **triggered manually**.

## Configuration

Two supported keys in `~/.crewcoder/config.json` (the optional fallback is omitted by default):

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `autoCompact` | boolean | `true` | Compacts at 60% of a known window when it is at least 1,000,000 tokens, or 50% for smaller known windows. When off, an 80% known-window safety guard remains. |
| `autoCompactThresholdTokens` | optional integer | absent | Explicit fallback used only when the model context window is unknown. Clamped 10,000–2,000,000. |

Set them from the CLI:

```bash
crewcoder config show                                  # inspect current settings
crewcoder config set autoCompact true
crewcoder config set autoCompactThresholdTokens 120000  # unknown-model fallback only
```

Per-run override (programmatic): `AgentLoopOptions.autoCompact` and
`AgentLoopOptions.autoCompactThresholdTokens` take precedence over config.

ACP respects these same persisted settings. With auto-compaction on, known model windows of at
least 1,000,000 tokens compact at 60%; smaller known windows compact at 50%. An absolute threshold
never overrides a known model window. When auto-compaction is off, CrewCoder still performs
provider-neutral safety compaction at 80% of a known window. These checks run between
tool turns, after a completed final-answer turn reports threshold-crossing usage, and before the
first request of a resumed session. The compaction progress message
reports the measured live-context tokens, the effective threshold, and whether it came from the
configured absolute value or the model-window percentage. This makes an apparently early
compaction diagnosable instead of showing only the configured cap. If a provider does not report
usage or its model has no context-window metadata, enable `autoCompact` and optionally set a
conservative explicit fallback. Without that explicit fallback, an unknown-window model does not
auto-compact. Claude's SDK-native auto-compaction is
also enabled as defense in depth for its opaque resumed session. While running as an ACP agent,
CrewCoder publishes its own compaction lifecycle on the additive
`_crewcoder/compaction_update` session-update kind so capable hosts can show progress before the
next usage snapshot arrives. CrewCode's compact button must call ACP `session/compact`
(advertised on `initialize._meta["crewcoder/sessionCompact"]`); that rewrites the durable
session the same way `crewcoder session compact` does and returns the summary. Do not
leave host compact as a local transcript summary-reset. Codex app-server durable threads
avoid repeatedly uploading full context across restarts, but they do not change the
model's context-window limit; see
[`CODEX_TRANSPORT.md`](./CODEX_TRANSPORT.md).

## Tool-output prevention

Compaction is recovery, not permission for tools to flood the transcript. CrewCoder's text-heavy
core tools follow Pi-proven 50 KB/2,000-line limits where applicable; `grep` additionally caps each
match line at 500 characters. Truncation notices are actionable rather than silent. See
[`TOOL_OUTPUT_SAFETY.md`](./TOOL_OUTPUT_SAFETY.md).

## Tiered known-window thresholds

| Model context window | Automatic trigger |
|----------------------|-------------------|
| 1,050,000 | 630,000 (60%) |
| 1,000,000 | 600,000 (60%) |
| 400,000 | 200,000 (50%) |
| 200,000 | 100,000 (50%) |

`gpt-5.6-sol` declares a 1,050,000-token context window in the built-in Codex model catalog, so
its automatic trigger resolves deterministically to 630,000 tokens.

## Trigger metric — live context size

The threshold is compared against **provider-reported active context occupancy**, when available,
or the most recent turn's input tokens as a fallback (`UsageSummary.lastInputTokens` via
`currentContextTokens()`). For legacy/provider usage that has neither value, cumulative total tokens
are the conservative last resort and the progress message labels them `cumulative fallback` rather
than claiming they are live occupancy. Claude Agent SDK reports context occupancy separately from
aggregate billing usage. This accurately reflects context-window pressure. After a compaction
fires, `lastInputTokens` is reset to `0` so it does not re-fire before the next turn provides a fresh
measurement.

## Summary generation

When compaction fires, `compactLiveMessages()` (in `src/core/session-compaction.ts`):

1. Keeps the most recent messages (default 8), snapped to a **tool-group boundary** (see below).
2. Sends the older slice plus a bounded view of the retained recent messages to the model. The
   retained messages are marked authoritative for current status, so work completed or verified in
   the recent tail is not revived as an open thread. Long transcript sections retain both their
   beginning and end rather than dropping the latest status.
3. Replaces the older slice with a single synthetic `user` background message holding the summary.
4. **Falls back** to the deterministic transcript summary if the model call fails or returns empty,
   so compaction never blocks the loop.

The existing `session_compacted` event and `SessionCompaction` record are reused. Applying a
compaction also clears provider-native resume IDs and cached transport continuation before the next
turn; otherwise Claude or Codex could silently reattach the discarded pre-compaction context.

## Tool-group boundaries (do not regress)

The retained window must never begin inside an `assistant` -> `toolResult` group. A plain
`messages.slice(-keepRecentMessages)` can cut mid-group and retain tool results whose originating
tool call was compacted away. Those serialize into `function_call_output` / `tool_result` items
with no matching call, which is a protocol error: Codex answered the request with a stream that
ended without assistant text, tool calls, or completion metadata, the run stopped with
`provider error: Codex stream ended without assistant text, tool calls, or completion metadata`,
and every subsequent resume replayed the same broken prefix.

`retainedStartIndex()` in `src/core/session-compaction.ts` moves the boundary **backwards** onto
the assistant message that owns the leading tool results, so no tool output is lost; only when
that would leave nothing to summarize does it walk forwards and fold the orphans into the summary
instead. Guarded by `src/tests/session-compaction.test.ts`.

Providers keep an independent safety net, because branching and checkpoint restores can truncate a
transcript the same way. `codex-provider.ts`, `websocket-provider.ts`,
`openai-responses-provider.ts`, and `http-provider.ts` all track pending tool-call ids and degrade
an unmatched tool result to a plain `Historical tool result from <tool>:` context item rather than
sending an orphaned call id or silently dropping the output.

## Per-model usage tracking

`UsageSummary` now carries:

- `lastInputTokens` — provider-native context occupancy, or most recent input tokens as fallback.
- `byModel` — cumulative `{ inputTokens, outputTokens, totalTokens, cachedInputTokens,
  cacheWriteTokens, reasoningTokens, turns }` keyed by `` `${providerId}:${model}` ``.

These are emitted on every `usage_update` event.

## Manual compaction

There are two manual paths, chosen automatically by the TUI based on whether a run is active.

### Mid-run (live) — stdin control channel

While the agent loop is actively running (TUI `bridge.running`), `/compact` writes a control line
to the backend process's **stdin**:

```json
{"type":"control","action":"compact"}
```

`src/core/stdin-control.ts` parses newline-delimited control messages and flips
`AgentLoopOptions.manualCompactSignal.requested`. The loop consumes it at the next **safe point
(between iterations)** — never mid provider request — and forces a compaction regardless of the
token threshold (using `keepRecentMessages: 6`, `minMessages: 8` so shorter live histories still
compact). The backend emits `session_compacted`, which the TUI renders. This compacts the
**in-flight** conversation, not the last saved snapshot.

Wired in `cli.ts` for both `run --json-events` and `session resume --json-events`; the listener is
detached in a `finally` so it never keeps the process alive.

### Idle — saved-session command

ACP clients use the same idle path over `session/compact` instead of the CLI. The method
accepts `{ sessionId, preview?, summary? }`, refuses while a prompt is in flight, and
returns the installed summary so the host can update its local transcript.

When no run is active, the TUI shells out to the backend, which atomically replaces the saved
session history and clears native provider continuation before the next resume:

```bash
crewcoder session compact <session-id> [--provider p] [--model m] [--effort level] [--json]
```

### TUI command palette

- `/compact` — mid-run: signal the live loop; idle: compact the saved session.
- `/compact on` / `/compact off` — toggle `autoCompact` (persists to config).
- `/compact status` — print the current config.

## Compaction preview

Compaction can be **previewed** — the proposed summary is shown before the older messages are
replaced, and the summary can be **edited** before it is installed.

The core is a prepare/apply split in `src/core/session-compaction.ts`:

- `prepareLiveCompaction(messages, options)` → generates the summary (LLM, deterministic fallback)
  and returns a `CompactionProposal` **without** touching the messages.
- `applyCompactionProposal(proposal, { editedSummary?, note? })` → installs the proposal, optionally
  substituting a user-edited summary.

`compactLiveMessages` is now a thin `prepare → apply` wrapper, so existing callers are unchanged.

### Live (mid-run) preview

Preview activates when the loop has a `compactionPreviewSignal` wired **and** either config
`compactionPreview` is `true`, or the manual compact request asked for it. On a triggered
compaction the loop:

1. `prepareLiveCompaction` → proposal.
2. Emits `session_compaction_preview` (`previewId`, `summary`, `source`, message counts).
3. Waits for a `compact_preview` control decision at the same safe point as approvals.
4. Applies (optionally with `decision.summary`) or, if `approved: false`, emits a `skipped`
   progress event and leaves context untouched.

Control messages (`src/core/stdin-control.ts`):

```json
{"type":"control","action":"compact","preview":true}                      // request a previewed manual compaction
{"type":"control","action":"compact_preview","previewId":"...","approved":true,"summary":"edited text"}
{"type":"control","action":"compact_preview","previewId":"...","approved":false}
```

`config compactionPreview` (default `false`) is the persisted opt-in for auto-compaction previews.

### Idle (saved-session) preview + edit

```bash
crewcoder session compact <id> --preview [--json]          # print the proposed summary, save nothing
crewcoder session compact <id> --summary-file <path>       # apply compaction with an edited summary
```

### TUI in-overlay editing

`/compact preview` (alias `/compact edit`) opens a focused multi-line editor
(`components/CompactionPreviewOverlay.ts`) pre-filled with the proposed summary. Keys:

```txt
type / ↵ / ←→↑↓ / home·end / backspace·delete   edit the summary
^S   apply the (edited) summary
^R   reset to the proposed summary
esc  cancel — leave context unchanged
```

Two paths feed the same overlay:

- **Live run** (a model turn is active): `/compact edit` sends
  `{"action":"compact","preview":true}`; the backend's `session_compaction_preview` event opens the
  overlay. Applying writes `{"action":"compact_preview","previewId","approved":true,"summary":<edited>}`
  back over the control channel; the live loop installs it and continues.
- **Idle** (no active run): `/compact edit` shells out to `session compact <id> --preview --json`,
  opens the overlay, and on apply runs `session compact <id> --summary-file <tmp>` with the edited text.

## Key files

- `src/core/config.ts` — `autoCompact`, `autoCompactThresholdTokens`.
- `src/core/usage.ts` — `lastInputTokens`, `byModel`, `currentContextTokens()`, `modelUsageKey()`.
- `src/core/session-compaction.ts` — `compactLiveMessages()` + deterministic fallback.
- `src/core/agent-loop.ts` — mid-loop threshold check and compaction.
- `src/cli.ts` — `config show`, `session compact`.
- TUI: `components/CommandPalette.ts`, `components/App.ts` (`/compact`).

## Tests

- `src/tests/usage.test.ts` — per-model breakdown, replaced last-input tokens, fallback.
- `src/tests/session-compaction.test.ts` — LLM summary + deterministic fallback.
- `src/tests/agent-loop.test.ts` — mid-session compaction fires past the threshold.
