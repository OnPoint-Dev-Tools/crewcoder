# Session Compaction Progress Events

CrewCoder can emit progress events around internal live compaction so clients can show user-visible feedback while context is being summarized.

Opening/resuming a session does not compact history. Compaction happens through explicit `/compact` or live token-triggered compaction while a run is active. When compaction does remove older assistant tool calls, provider adapters degrade any retained orphan tool results into ordinary user-context text so OpenAI-compatible providers never receive invalid `tool` messages without preceding `tool_calls`.

## Events

### `session_compaction_progress`

Emitted before and during backend-driven compaction.

Fields:

- `phase`: `requested`, `summarizing`, `saving`, `skipped`, or `failed`
- `percent`: progress hint from `0` to `100`
- `message`: human-readable status text
- `originalMessageCount`: optional number of messages before compaction
- `retainedMessageCount`: optional number of recent messages retained

### `session_compacted`

Emitted when compaction succeeds and the compacted context has been installed.

Fields:

- `compactionId`
- `originalMessageCount`
- `retainedMessageCount`
- `summary`

## ACP behavior

`crewcoder acp` projects these events onto the additive
`_crewcoder/compaction_update` `session/update` kind. Active phases map to
`status: "started"`, failures to `"failed"`, and `session_compacted` to
`"completed"`. A skipped no-op closes an already-open progress indicator with a
completed lifecycle status while preserving the explicit skip message and phase.
The payload is marked `automatic: true` because ACP currently exposes no native
manual-compaction request; host-triggered manual compaction remains host-owned.
The summary body is not sent over this notification channel.

Standard-only ACP clients may ignore the unknown namespaced update. CrewCode
parses it into its provider-neutral compaction meter and therefore does not infer
a second event from the later context-usage drop.

## TUI behavior

The TUI does not request manual compaction while a model response is running. Users run `/compact` after the response finishes, which compacts the saved session through the `session compact --json` CLI path. If the session is too small, the TUI displays a skipped compaction notification.
