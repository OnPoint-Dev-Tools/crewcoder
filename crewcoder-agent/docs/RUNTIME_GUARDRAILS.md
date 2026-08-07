# Runtime guardrails

CrewCoder supports durable session token budgets and an optional post-run verification gate.

## Session token budgets

Start a budgeted run with either equivalent option:

```bash
crewcoder run --budget 200k "implement the feature"
crewcoder run --max-tokens 200000 "implement the feature"
```

Accepted suffixes are `k` and `m`, including decimals such as `1.5m`. The budget counts cumulative provider-reported `totalTokens` across the durable session, not the latest context-window size. Cached and reasoning tokens follow the provider's reported total.

Behavior:

1. Every `usage_update` includes `tokenBudget` and `budgetExceeded`.
2. At 80%, CrewCoder emits `token_budget_warning` and requests context compaction before another tool-driven turn when the transcript is large enough.
3. At or above the limit, CrewCoder emits `token_budget_exceeded`, does not execute pending tool calls, and ends safely.
4. The session JSONL persists the budget inside its usage metadata.
5. `session resume` inherits the saved budget. Pass a new `--budget` to replace it.
6. When context-window data is unavailable, the TUI composer status shows cumulative burn as `● 160k/200k budget - 80% | 160k tokens`.
7. When the limit is reached, the TUI offers either staying in the exhausted session or handing off to a fresh child session.

For a handoff, CrewCoder generates a bounded compact summary from the exhausted transcript. The TUI then asks for provider, model, and effort. The new session receives only that summary as its conversation input; it does not inherit the original messages, usage, or exhausted budget. Its session record keeps `parentSessionId` pointing to the source for auditability.

Provider usage is normally delivered after a model response, so one response can overshoot the exact ceiling. CrewCoder prevents subsequent model turns and pending tool execution; it cannot retract tokens already consumed by the provider.

## Verification gate

Enable post-run verification explicitly:

```bash
crewcoder run --verify "implement the feature"
crewcoder session resume <id> --verify "finish and verify"
```

CrewCoder discovers `typecheck` and `test` scripts in the workspace `package.json`, runs them sequentially without a shell, and emits:

- `verification_start`
- `verification_end` with each check's status, output, and duration

Verification failure is reported in the run result and event stream. It does not erase the session or workspace changes.

### Extension validators

Trusted extensions can contribute executable validators:

```json
{
  "contributes": {
    "validators": [
      {
        "id": "lint",
        "title": "Lint",
        "command": "npm",
        "args": ["run", "lint"],
        "timeoutMs": 60000
      }
    ]
  }
}
```

Executable validators require both `allowExtensionHooks=true` and the extension id in `trustedExtensions`. Commands run directly with `shell: false`, from the workspace root, with bounded output and timeout.

The roadmap's cheap-model review pass is intentionally not automatic: spending additional model tokens would conflict with a reached session budget and requires an explicit review-model policy. Extensions can supply a deterministic review validator today.
