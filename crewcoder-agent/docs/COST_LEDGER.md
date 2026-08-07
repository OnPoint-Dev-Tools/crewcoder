# Token Cost Ledger

CrewCoder records every billed model turn to an append-only ledger and reports spend in
US dollars alongside the full token breakdown.

```txt
ledger:   <CREWCODER_HOME>/logs/cost.jsonl
command:  crewcoder cost [--today | --since <time>] [--by-model|--by-provider|--by-worker|--by-session|--by-day]
rates:    crewcoder cost price <provider:model> --input <usd/1M> --output <usd/1M>
path:     crewcoder cost path
```

## What gets recorded

`src/core/cost-ledger.ts` writes one JSON line per model turn, from the agent loop's
`onUsage` callback. Token counts are copied verbatim from the provider; nothing is
estimated or reconstructed.

```jsonc
{
  "timestamp": "2026-07-27T15:04:05.000Z",
  "providerId": "codex",
  "model": "gpt-5.6-luna",
  "sessionId": "…",
  "worker": "Crew",
  "cwd": "/repo",
  "inputTokens": 1200000,
  "outputTokens": 60000,
  "cachedInputTokens": 900000,
  "cacheWriteTokens": 0,
  "reasoningTokens": 22000,
  "totalTokens": 1260000,
  "costUsd": 1.0875,
  "pricingSource": "config"
}
```

`costUsd` and `pricingSource` are **absent** when no rate is known for the model. An
unpriced turn is reported as `unpriced`, never as `$0.00` — free and unknown are
different facts, and a ledger that silently reports unknown spend as zero is worse than
no ledger.

A ledger write failure never breaks a run. It degrades to a `backend_debug` warning at
`source: "cost-ledger"`.

## Where prices come from

| Source | Precedence | Notes |
|--------|-----------|-------|
| `config.modelPricing` | first | Keyed by `provider:model`, then bare `model` |
| OpenRouter catalog | fallback | Reuses the existing 24h model-catalog cache |

The OpenRouter catalog (`src/providers/openrouter-model-catalog.ts`) already backed
context-window resolution; it now also carries `pricing`, so most models are priced with
no configuration. The disk cache is `version: 2` — a v1 cache is discarded and refetched.

Set an override when you are on a discounted, self-hosted, or unlisted endpoint:

```bash
crewcoder cost price codex:gpt-5.6-luna --input 1.25 --output 10 --cache-read 0.125
crewcoder cost price claude-sonnet-4-5 --input 3 --output 15 --cache-read 0.3 --cache-write 3.75
```

Rates are USD per **million** tokens. Overrides apply to turns recorded from that point
on; entries already in the ledger keep the cost they were written with, because the
ledger is a record of what happened, not a live recomputation.

## Cache accounting

Cache token conventions are provider-shaped, and getting this wrong either double-bills
the cache or hides it entirely:

```txt
OpenAI-shaped     prompt_tokens_details.cached_tokens   -> INSIDE inputTokens
Anthropic-shaped  cache_read_input_tokens               -> ALONGSIDE inputTokens
```

`normalizeUsage` therefore sets `TokenUsage.cachedInputIncluded` where the field is
*read*, and `computeCost` trusts that flag instead of guessing from the numbers. Do not
replace it with a heuristic like "cached <= input means included".

Other rules:

- Cache reads fall back to the input rate when a vendor does not price them separately.
- Cache writes are billed only when a cache-write rate exists (Anthropic-style providers).
- Reasoning tokens are already counted inside output tokens for every supported provider,
  so they are **reported but never billed twice**.

## Reporting

```bash
crewcoder cost                          # by model, all time
crewcoder cost --today --by-worker      # today's spend per worker identity
crewcoder cost --since 7d --by-day      # last week, per calendar day
crewcoder cost --by-session --json      # machine-readable rollup
crewcoder cost --session <id>           # one session
crewcoder cost --model gpt-5.6-luna     # one model
```

Every view prints the dollar total plus the complete token breakdown: turns, input,
cached, cache-write, output, reasoning, and total. `--json` emits `{ ledger, since,
total, groups, groupBy }`.

## Live cost in the TUI

`UsageSummary.costUsd` accumulates per turn (and per model in `byModel`), rides the
existing `usage_update` event, and renders on the composer status line:

```txt
◔ 12.4k/200k - 6% | 12.4k tokens | $0.42
```

The dollar segment is omitted entirely when the model could not be priced, for the same
reason the CLI prints `unpriced`.

## Files

```txt
src/core/cost-ledger.ts                     ledger append/read/rollup
src/core/model-pricing.ts                   rate resolution + cost math
src/providers/openrouter-model-catalog.ts   catalog pricing source (cache v2)
src/core/usage.ts                           cachedInputIncluded + costUsd
src/core/agent-loop.ts                      per-turn recording (priceTurn)
src/cli.ts                                  crewcoder cost show|price|path
crewcoder-tui/src/state/usage.ts            status-line USD rendering
```
