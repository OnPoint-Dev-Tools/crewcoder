# Model context windows

CrewCoder uses model context-window metadata to render live context occupancy, for example:

```txt
◔ 12.4k/200k - 6% | 12.4k tokens
```

When no trustworthy context-window limit is available, the TUI falls back to cumulative usage such as `12.4k tokens`. CrewCoder does not infer a maximum window from consumed tokens.

## Resolution precedence

Context windows are resolved in this order:

1. `modelCatalog[].contextWindow` declared by the active built-in or extension provider.
2. OpenRouter's public model catalog at `https://openrouter.ai/api/v1/models`.
3. No context-window value; the TUI keeps its token-only fallback.

Provider metadata wins because a provider-specific endpoint may expose less context than the underlying model supports.

## OpenRouter matching

CrewCoder accepts an OpenRouter catalog entry only when one of these rules identifies a single model:

1. Exact ID match, such as `moonshotai/kimi-k2.7-code`.
2. One unique namespaced suffix match, such as CrewCoder's `gpt-5.4-mini` matching only `openai/gpt-5.4-mini`.

CrewCoder does not use fuzzy name matching. Missing and ambiguous models remain token-only.

## Cache and failure behavior

The OpenRouter catalog is loaded lazily when CrewCoder first resolves a model without provider-declared context metadata. A successful response is reduced to model IDs and context lengths, then cached for 24 hours at:

```txt
$CREWCODER_HOME/cache/openrouter-model-context.json
```

Pricing and other OpenRouter metadata are not persisted. The cache is shared across CLI/TUI processes and written atomically. A stale cache is refreshed before use; if OpenRouter is unavailable, returns invalid data, or exceeds the five-second timeout, model execution continues without a context-window value.
