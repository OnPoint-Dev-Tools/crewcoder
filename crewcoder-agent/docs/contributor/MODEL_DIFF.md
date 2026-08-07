# Model diff (`crewcoder diff-models`)

Run one prompt against N models side by side and compare **response, cost, and latency**.

```bash
crewcoder diff-models "Write a retry helper with exponential backoff" \
  --models codex:gpt-5.6,opencode:claude-sonnet-4-6
```

## What it is (and is not)

`diff-models` is a **comparison harness, not an agent run**:

- Each candidate gets exactly **one** model call, with `availableTools: []`.
- Nothing is written to a session — no `SessionRecord`, no transcript, no resume.
- No mode routing, skills, extension hooks, memory, or repo background context.

Same reasoning as `session why`: asking a question about models must not add turns
to any session, and the compared models must not be able to run tools.

The one durable side effect is the **cost ledger**: these are real billed turns, so
every candidate that reports usage is appended to `<home>/logs/cost.jsonl` under the
active worker. Use `--no-ledger` to opt out.

## Candidate specs (`--models`)

`--models` is repeatable and comma-splittable. Each spec resolves as:

| Spec | Resolves to |
|---|---|
| `codex:gpt-5.6` | provider `codex`, model `gpt-5.6` |
| `codex` | provider `codex`, its default model |
| `gpt-5.6` | the default provider, model `gpt-5.6` |
| `qwen-2.5:free` | the default provider, model `qwen-2.5:free` |

The `provider:` prefix is honored **only when the left side is a known provider id**.
Model ids legitimately contain colons, so splitting on punctuation alone would silently
route a real model to a provider that does not exist. Duplicate candidates are deduped
by their `provider:model` label.

The default provider comes from `CREWCODER_PROVIDER`, then `config.defaultProvider`.

## Flags

| Flag | Meaning |
|---|---|
| `--models <list>` | Required. Candidates, repeatable and comma-separated. |
| `--effort <level>` | Reasoning effort applied to every candidate (`none`…`xhigh`). |
| `--system-prompt <name>` | Use a stored system prompt instead of the neutral comparison prompt. |
| `--sequential` | Run one at a time. Slower, but latency numbers are not contended. |
| `--no-ledger` | Do not record these turns in the cost ledger. |
| `--full` | Print each full response instead of an 8-line preview. |
| `--json` | Emit the raw `ModelDiffReport`. |

Candidates run **in parallel by default**, so `totalMs` is normally well below the sum
of per-candidate latencies. Use `--sequential` when you are measuring latency rather
than comparing answers.

## Reporting rules

- A candidate that fails is reported as a **failed row**, never as a missing one — one
  dead provider must not hide the results of the others. Both throw-style failures and
  `stopReason: "error"` provider failures are captured.
- The command exits `1` if any candidate failed.
- An **unpriced** model reads as `unpriced`, never `$0.00`. Free and unknown are
  different facts (same rule as `crewcoder cost`).
- Pricing resolves through `resolveModelPricing`: `config.modelPricing` overrides first,
  then the OpenRouter catalog. Cache accounting uses `TokenUsage.cachedInputIncluded`.
- Usage is only present when the provider reported it; `no usage reported` is shown
  rather than a fabricated zero.

## JSON shape

```jsonc
{
  "prompt": "…",
  "startedAt": "2026-07-27T…Z",
  "totalMs": 4210,
  "concurrent": true,
  "results": [
    {
      "candidate": { "providerId": "codex", "model": "gpt-5.6", "label": "codex:gpt-5.6" },
      "ok": true,
      "text": "…",
      "latencyMs": 4180,
      "usage": { "inputTokens": 120, "outputTokens": 310, "totalTokens": 430, "costUsd": 0.0031 },
      "costUsd": 0.0031,
      "pricingSource": "openrouter"
    }
  ]
}
```

Failed results carry `ok: false` and `errorMessage`, with `text: ""`.

## Source

- `src/core/model-diff.ts` — spec parsing, the race, pricing.
- `src/cli.ts` — `diff-models` command, table rendering, ledger recording.
- `src/tests/model-diff.test.ts` — spec-parsing edge cases, failure isolation, unpriced handling, parallel/sequential.

Related: [COST_LEDGER.md](../COST_LEDGER.md), [WHY_COMMAND.md](../WHY_COMMAND.md).
