# TUI Backend Contract

The CrewCoder TUI should treat CrewCoder as a backend process and consume newline-delimited JSON events.

## Start a run

```bash
crewcoder run --json-events --provider opencode --mode general "fix this bug"
```

## Resume a run

Resume without a prompt creates a new branched session and returns immediately, without calling the model. This lets the TUI switch to the resumed session and wait for the user's next message.

```bash
crewcoder session resume <session-id> --json-events
```

Resume with a prompt runs the agent loop and injects `Resume this session from the existing conversation context.` as background context on the first resumed user message.

```bash
crewcoder session resume <session-id> --json-events "continue"
```

## Event expectations

The TUI should be prepared for these event types:

```txt
agent_start
crew_start / crew_worker_start / crew_worker_end / crew_end
agent_error
provider_start
provider_end
provider_error
turn_start
message_start
assistant_delta
thinking_delta
usage_update
message_end
tool_execution_start
tool_delta
tool_execution_end
file_changed
background_job_start / background_job_output / background_job_status / background_job_end
approval_required
approval_resolved
extension_ui_notify / extension_ui_request / extension_ui_resolved
checkpoint_created / checkpoint_restored
session_compaction_progress / session_compaction_preview / session_compacted
validation_start
validation_end
turn_end
session_saved
agent_end
```

Every event line is JSON with an `emittedAt` timestamp appended by the JSON stream sink.

## Stdin control channel

When the backend is launched with `--json-events`, the TUI may write newline-delimited JSON control messages to stdin.

```json
{"type":"control","action":"compact"}
{"type":"control","action":"follow_up","message":"Add this detail to the current task"}
{"type":"control","action":"approval","approvalId":"approval_...","approved":true,"reason":"Approved in TUI"}
{"type":"control","action":"ui_response","requestId":"ui_...","value":"selected-action"}
```

`follow_up` messages are queued by the active loop and injected as user messages at the next safe point between provider/tool steps. The backend never cancels the in-flight provider request. If a follow-up arrives while a final assistant response is being produced, the loop continues for another iteration when `maxIterations` allows it.

## Approval behavior

Interactive JSON-event hosts receive `approval_required` before tool execution and answer through the stdin control channel. The agent loop waits for the matching decision, emits `approval_resolved`, and proceeds or returns a denied tool result. A non-interactive host has no live decision channel and safely denies approval-required work instead of hanging.

## Rendering recommendation

- `agent_start`: mark the run active and update the current session id.
- `agent_error`: render an error block with the message and optional stack details.
- `provider_start`: record provider/model start as system or status metadata.
- `provider_end`: record provider completion and update usage totals when present.
- `usage_update`: refresh usage state from `summary`. Beyond cumulative token totals it carries `lastInputTokens` (live context occupancy), `cacheWriteTokens` (Anthropic `cache_creation_input_tokens`), and `contextWindow` (active model's max input tokens, when known) so the TUI can render a context-window status like `◔ 12.4k/200k - 6% | 12.4k tokens`. Without a trustworthy window, the TUI retains its token-only fallback. When model pricing resolves, `summary.costUsd` carries cumulative estimated session spend; unpriced models omit it. Context-window and pricing sources are documented in `../MODEL_CONTEXT_WINDOWS.md` and `../COST_LEDGER.md`.
- `provider_error`: render an error block for the provider failure.
- `turn_start`: optionally record the turn start in system/status metadata.
- `message_start`: no-op, or use it to prepare per-message UI state.
- `assistant_delta`: append to the current assistant bubble.
- `thinking_delta`: append to a streaming thinking/reasoning block. CrewCoder forwards provider-supplied reasoning for every provider that exposes it; hosts should render rather than suppress these events. Claude effort levels explicitly enable adaptive thinking, and completed Claude thinking blocks are forwarded when partial deltas are unavailable. `/thinking off` persists `thinkingEnabled=false` and requests `none`/disabled reasoning from all built-in provider paths; `/thinking on` restores the selected effort.
- `message_end`: commit the final user or assistant message if it was not already streamed. Model-generated assistant events optionally include `durationMs` and `outputTokens`; divide output tokens by wall-clock seconds to display the turn's generation throughput. Synthetic and historical messages omit these fields.
- `tool_execution_start`: open a running tool block with the tool name and arguments.
- `tool_delta`: append to the matching tool block output.
- `tool_execution_end`: mark the matching tool block success/error and append result details.
- `file_changed`: add the path to the changed-files panel.
- `approval_required`: open an approval UI/block with risk, reason, and arguments.
- `approval_resolved`: record the approval outcome in system/status metadata.
- `validation_start`: open a running validation block for the target.
- `validation_end`: mark the validation block passed/failed and show errors or warnings.
- `turn_end`: optionally record the turn completion in system/status metadata.
- `session_saved`: update the current session id/path state.
- `agent_end`: mark the run inactive.
