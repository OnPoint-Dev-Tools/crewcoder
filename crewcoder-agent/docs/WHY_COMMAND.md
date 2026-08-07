# `/why` — explain the last decision

Ask the model to explain, in plain language, what the agent just decided and why.

```bash
crewcoder session why <id>
crewcoder session why <id> --json
crewcoder session why <id> --show-evidence
crewcoder session why <id> --provider opencode --model claude-sonnet-4-6 --effort low
```

TUI: `/why`.

## Why it is a separate one-shot call

`/why` does **not** send a prompt into the running session. It loads the durable
session record, reconstructs the last decision, and makes an isolated model call
with `availableTools: []`. Consequences that are deliberate:

- Asking for an explanation never adds turns to the transcript the agent is
  working in, and never changes what the next real turn sees.
- The explainer cannot run tools, edit files, or "helpfully" continue the task.
- It works on any session id, including finished ones, not just the live run.

## What counts as "the last decision"

`extractLastDecision` (`src/core/session-why.ts`) walks the transcript backwards
to the most recent assistant message that has text, tool calls, or a provider
error, and assembles:

```txt
request       the nearest preceding user message
assistantText what the agent said on that turn
stopReason    end | tool_calls | error | aborted (+ errorMessage)
toolCalls     name, arguments, ok/failed, truncated result text
changedFiles  the session mutation log
```

That structure is rendered into the evidence block handed to the model.
`--show-evidence` prints the exact same text, so the explanation can always be
checked against its inputs.

## Honest degradation

The model call can fail (auth, billing, network, empty reply). It never throws
and never silently invents a rationale. On failure the command returns a
**deterministic transcript readout** built only from what the record proves:

```txt
source: "model"      -> the model explained the decision
source: "transcript" -> the model was not used; fallbackReason says why
```

`fallbackReason` is surfaced everywhere: a yellow CLI line, a `fallbackReason`
JSON field, and a `transcript readout` badge in the TUI `why` block. Do not
collapse the two sources into one look — a readout that reads like reasoning is
the failure mode this design exists to prevent (same rule as the compaction
summarizer, see `AUTO_COMPACTION.md`).

## JSON shape

```json
{
  "explained": true,
  "source": "model",
  "fallbackReason": null,
  "explanation": "- It read the helper first\n- Because the request named that file",
  "decision": {
    "sessionId": "sess_123",
    "messageIndex": 7,
    "request": "add a retry to the fetch helper",
    "assistantText": "Reading the helper first.",
    "stopReason": "tool_calls",
    "toolCalls": [{ "name": "read", "arguments": { "path": "src/fetch.ts" }, "ok": true, "result": "…" }],
    "changedFiles": ["src/fetch.ts"]
  }
}
```

A session with no assistant turn yet returns `{ "explained": false, "reason": "no_decision" }`
and exits 0 — nothing to explain is not an error.

## Code

```txt
src/core/session-why.ts              extraction, evidence, model call, fallback
src/cli.ts                           session why
src/tests/session-why.test.ts        backend tests
crewcoder-tui/src/components/App.ts  /why -> session why --json -> `why` block
crewcoder-tui/src/tests/app-why.test.ts
```
