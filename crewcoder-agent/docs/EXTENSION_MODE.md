# Agent modes

CrewCoder runs in one of three **explicit** modes. There is no `auto` mode and no
prompt-keyword routing: the requested mode is the resolved mode.

```txt
general    (default)  general coding agent; no manifest constraints enforced
plugin                CrewCode app plugin architect  (crewcode.plugin.json)
extension             CrewCoder extension architect  (crewcoder.extension.json)
```

## Why routing was removed

`auto` guessed a mode from prompt text against a keyword list. Two problems made it
worse than useless:

1. It silently changed **which constraints were treated as law**. A prompt that merely
   contained the word "permissions" got the CrewCode v0 sandbox rules injected as hard
   requirements.
2. The extension vocabulary (`hooks`, `skills`, `workflows`, `manifest`, `commands`,
   `tools`) collides almost completely with ordinary coding vocabulary. Any keyword list
   broad enough to be useful would hijack normal prompts.

Making the user say what they want is cheaper than making them debug a mode they never
asked for. Do not reintroduce keyword routing.

## Selecting a mode

```bash
crewcoder run --mode extension "add a compaction hook to my extension"
crewcoder config set defaultMode extension
```

In the TUI: `/modes` (alias `/workers`), or the command palette Modes section.

`general` is the default. Selecting a built-in mode clears the active worker.

## Legacy `auto` coercion

`auto` was a persisted value: it exists in older `config.json` files, saved session
records, and goal records. It is **coerced to `general` on read** rather than rejected,
so existing state keeps loading.

```txt
normalizeAgentMode("auto")     -> "general"   (src/core/mode-router.ts)
normalizeTuiMode("auto")       -> "general"   (crewcoder-tui/src/state/tui-store.ts)
config set defaultMode auto    -> error: defaultMode must be one of: general, plugin, extension
```

Coercion is read-only tolerance. Writing `auto` is a hard error, because accepting it
would let the removed concept creep back into new state.

## Extension mode

Extension mode is the CrewCoder-extension counterpart to plugin mode. It composes:

```txt
constraints -> src/knowledge/extension-constraints.ts  (CREWCODER_EXTENSION_CONSTRAINTS)
docs        -> src/knowledge/crewcoder-extension-docs.ts
skills      -> src/skills/crewcoder-extension/index.ts
prompt      -> src/core/system-prompt.ts               ("CrewCoder Extension Architect mode")
```

The system prompt states explicitly that extension mode is **not** the CrewCode app
plugin system. Conflating `crewcoder.extension.json` with `crewcode.plugin.json` is the
single most likely model error here, so the two knowledge sets are kept in separate
files and are asserted disjoint in `src/tests/extension-mode.test.ts`.

Unmatched prompts still get a useful baseline: extension mode falls back to the
manifest and trust skills, and to the full extension doc set.

## Embedded knowledge: id catalog in the prompt, body on demand

`EmbeddedDoc` has two tiers, and the split is the whole design:

```txt
id               -> static catalog line in the system prompt (~120 tokens, every run)
title + summary  -> returned BY the docs tool, never shipped in the prompt
content          -> full buildable reference, loaded ONLY via the docs tool
```

The prompt carries a bare comma-separated id list plus one instruction. Nothing else:

```txt
Embedded CrewCoder extension docs:
extensions, extension-manifest, extension-skills, extension-tools, extension-hooks, ...
Call the `docs` tool with { "id": "<id>" } to read one in full ...
```

Cost: **~120 tokens (extension), ~87 (plugin), flat and identical for every prompt**,
against ~12.5k tokens of reference available on demand.

### Why not per-prompt matched summaries

The first version selected docs by keyword-matching the prompt and injected
`id: title — summary` for each match. Measured, that was worse on both axes:

| prompt | docs injected | cost |
|---|---|---|
| `"add a beforeToolCall hook"` | 1 of 14 | ~134 tok |
| `"refactor this parser"` (irrelevant) | 9 of 14 | ~655 tok |

A miss fell back to querying `"extension"`, which matched most of the set — so the
**least** relevant prompts cost the **most** tokens. And a near-miss hid the exact doc
the model needed, because it only ever saw the matched subset.

A static id list is cheaper in the worst case, deterministic, and shows the model the
whole menu. Do not reintroduce prompt-matched doc selection or summaries in the prompt;
`src/tests/extension-mode.test.ts` asserts both.

### The docs tool

`src/tools/docs.ts`:

```txt
docs()                          -> list every available doc id for the active mode
docs({ query: "hooks" })        -> search; a single match returns the full body directly
docs({ id: "extension-hooks" }) -> full buildable reference
```

It is **mode-scoped**: plugin mode reads only plugin docs, extension mode only
extension docs, general mode both. That scoping is what stops the model pulling a
`crewcode.plugin.json` reference into an extension task.

A fetched body stays in session history for later turns (~840 tokens for a typical
doc). That is inherent to tool results, paid once, and only when the model asked.

## Adding knowledge

- CrewCoder extension facts go in `crewcoder-extension-docs.ts` / `extension-constraints.ts`.
- CrewCode app plugin facts go in `crewcode-docs.ts` / `constraints.ts`.

Keep `content` grounded in files it can be re-derived from — `src/extensions/types.ts`,
`src/extensions/api.ts`, `docs/EXTENSION_*.md`, and the real
`/CrewCode/examples/plugins` templates. Invented prose drifts silently; derived prose
can be rechecked.

Never merge the two sets. `crewcoder docs query <text>` searches both and prints them
under separate headings for the same reason. `src/tests/docs-tool.test.ts` asserts
every doc has a real body and that neither set leaks the other's manifest name.
