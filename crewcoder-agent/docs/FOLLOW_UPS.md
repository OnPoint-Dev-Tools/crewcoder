# Live follow-ups

A host can send another user instruction while an agent run is active. The instruction adds context to the current task; it does not cancel the provider request, stop the current tool, or require the agent to finish its answer first.

## Delivery

- **Codex CLI:** after a tool completes, CrewCoder sends `turn/steer` with the active thread and `expectedTurnId`. This appends user input to the same native turn. Native commands, file changes, MCP tools, and CrewCoder dynamic tools participate.
- **Claude Agent SDK:** `PostToolUse` and `PostToolUseFailure` hooks return queued user instructions as `additionalContext`. This works for native and CrewCoder MCP tools and leaves the query running.
- **API providers and other clients:** the outer loop adds instructions between provider/tool steps before the next model request. A custom client with its own internal tool loop can implement the callback below.

Messages wait for tool completion; they do not interrupt a long-running tool. Already-running parallel tools continue. If no further tool runs, queued instructions are handled after the response, with another iteration when the configured limit allows it. A failed provider request remains terminal. A rejected Codex steer retains the batch for the outer-loop fallback rather than replaying the native turn.

## Host controls

Existing control payloads are unchanged:

- JSON-events stdin: `{"type":"control","action":"follow_up","message":"Also cover edge cases."}`
- Fleet HTTP or WebSocket control: the same `follow_up` payload for an active run.
- ACP extension: `session/follow_up` with `{ "sessionId": "...", "message": "Also cover edge cases." }`.
- In-process SDK: `session.followUp("Also cover edge cases.")` while `prompt()` runs.

A queue acknowledgement means accepted for later delivery. Delivered instructions emit user `message_start` and `message_end` events and enter the durable session. Concurrent tool completions consume each batch once, in queue order. Messages arriving while delivery is pending remain queued for a later boundary. Cancellation leaves undelivered messages untouched.

## Custom model clients

`ModelStreamCallbacks.deliverFollowUps(deliver)` lets a client ask the loop to deliver queued user context at a completed tool boundary. The supplied `deliver(messages)` function receives a read-only batch of user strings and must resolve only after its provider accepts the input. Rejecting leaves the batch queued. The loop serializes concurrent deliveries, records accepted user messages, and saves the session. No callback runs when the queue is empty or the run is already cancelled.

Forward these strings as user context through the provider's supported live-input mechanism. Keep them separate from tool output and permission decisions. This callback does not approve tools or change sandbox policy.

See [the backend control contract](contributor/TUI_BACKEND_CONTRACT.md), [fleet controls](FLEET_MODE.md), and [the SDK guide](SDK.md).
