# Extension Hook Contribution Point

> Not to be confused with `docs/HOOKS.md`, which is React/Electron hook guidance for UI code and
> is unrelated to this contribution point.

Extension hooks let an extension observe and control the agent loop: inject context, block or
rewrite tool calls, react after a tool runs, and react when one fails.

Implementation: `src/extensions/extension-hooks.ts`. Matching: `src/extensions/tool-call-matcher.ts`.
Wiring: `src/core/agent-loop.ts`. Tests: `src/tests/extension-hooks.test.ts`.

## Manifest shape

```jsonc
{
  "contributes": {
    "hooks": [
      { "id": "block-lock", "title": "Block lockfile edits",
        "event": "beforeToolCall",
        "command": "./hooks/guard.js",
        "matches": { "tools": ["edit", "write"], "paths": ["*.lock", "*-lock.json"] } },

      { "id": "lint-after-edit", "title": "Lint after edit",
        "event": "afterToolCall",
        "command": "npx", "args": ["eslint", "--fix"],
        "matches": { "tools": ["edit"], "paths": ["**/*.ts"] } },

      { "id": "report-failures", "title": "Report failures",
        "event": "onError", "command": "./hooks/report.js",
        "matches": { "tools": ["bash"] } }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `event` | `context`, `beforeToolCall`, `afterToolCall`, `onError`, or `compaction`. Defaults to `context` |
| `command` / `args` | Executable and argv. No shell. `{{json}}` / `{{payloadJson}}` expand to the payload |
| `env` | Extra environment values, same templating. `CREWCODER_EXTENSION_HOOK_PAYLOAD` is always set |
| `matches` | Declarative tool-call filter. Omitted means the hook fires for every tool call |
| `timeoutMs` | Per-hook timeout, clamped to 1s–60s (default 10s) |

## Events

| Event | When | Can it change behavior? |
|---|---|---|
| `context` | Once per run, before the first model turn | Returns text injected into the system prompt |
| `beforeToolCall` | Before each tool executes | Yes — `allow`, `block`, or `modify` |
| `afterToolCall` | After each tool completes | No, advisory context only |
| `onError` | After a tool call that failed | No, advisory context only |
| `compaction` | On a prepared compaction, before it is installed | Yes — rewrite or extend the summary |

`onError` fires only when `result.isError` is true, and runs before `afterToolCall`. It exists so
an extension can subscribe to failures alone rather than inspecting every successful result. Its
payload adds a flattened `error` string alongside `toolCall`, `result`, and `context`.

## Compaction hooks

Compaction discards older messages and replaces them with a summary. A `compaction` hook runs on
the **prepared but not yet installed** proposal, so an extension can make sure something survives.

Payload:

```jsonc
{ "summary": "…the proposed summary…",
  "source": "model",          // or "deterministic" when the LLM summarizer failed
  "fallbackReason": "Provider codex requires OAuth login. Run: crewcoder login codex",
  "originalMessageCount": 42,
  "retainedMessageCount": 8,
  "cwd": "/repo", "sessionId": "…" }
```

`fallbackReason` is set only when `source` is `deterministic`. A hook can use it to distinguish
"this summary is low quality because auth expired" from "this session was never configured for a
model summarizer" — and, for example, refuse to prune anything on a degraded summary.

Reply:

```jsonc
{ "summary": "…" }   // replace the summary outright
{ "append": "…" }    // append a line — the common "pin these facts" case
{ "context": "…" }   // advisory note only, surfaced as backend_debug
```

Hooks **chain**: each hook receives the previous hook's summary, not the original. `append` exists
because the usual goal is "make sure X survives compaction", and forcing an extension to
reproduce the entire summary just to add one line would be a footgun.

Ordering is deliberate: compaction hooks run **before** the human preview
(`session_compaction_preview` / `/compact preview`). The preview therefore shows the
hook-adjusted text, and a manual edit still gets the last word. A hook that returns nothing, or
whose process fails, leaves the summary untouched — compaction never breaks because a hook
misbehaved.

Unlike tool-call events, `matches` does not apply here: compaction is not a tool call.

## Protocol

The hook process receives the JSON payload on **stdin** and replies with JSON on **stdout**.
Non-JSON output is treated as `{ text: <output> }`. An empty reply is `{}` — a no-op.

`beforeToolCall` replies:

```jsonc
{ "action": "allow" }
{ "action": "block",  "reason": "lockfiles are protected" }
{ "action": "modify", "args": { "path": "safe.ts" } }
```

The first `block` wins and short-circuits the remaining hooks. `modify` rewrites the tool
arguments and passes them to the next hook, so hooks chain. Any hook may also return `context`,
which is surfaced as a `backend_debug` event.

## The `matches` filter

Without `matches`, every hook process spawns on every tool call and has to inspect the payload
itself. `matches` makes the common cases declarative:

- `tools` — tool name: substring, `*` glob, or `/regex/`
- `paths` — glob-matched against path-like args (`path`, `file`, `directory`, `target`, `cwd`, `out`)
- `commands` — bash command text: substring, glob, or `/regex/`

Groups are ANDed; patterns within a group are ORed. **An omitted or empty `matches` matches
everything**, which keeps hooks written before this field behaved identically.

Note the deliberate difference from `approvalPolicies`: a policy with no matchers never matches
(it would otherwise silently apply to every call), while a hook with no matchers always matches.
Both share `tool-call-matcher.ts` so the pattern semantics cannot drift apart.

## Hooks vs approval policies

They overlap and the line matters:

- **`approvalPolicies`** are pure data — `allow` / `review` / `block` with matchers. No process
  spawns. Use these for "block edits to `*.lock`" when no logic is needed.
- **`hooks`** spawn a process and can run arbitrary logic, rewrite arguments, or produce context.
  Use these when a decision needs computation, or for "run lint after edit".

If a rule is expressible as a policy, prefer the policy — it is cheaper and easier to audit.

## Trust and visibility

Hooks require **both** `allowExtensionHooks: true` in config **and** the extension in
`trustedExtensions`. Either missing means `loadTrustedExtensionHooks()` returns nothing. Note this
is the full `trusted` tier — `sandboxed` does not enable hooks.

Inspect what is actually live:

```bash
crewcoder extension hooks [--json]
```

It prints each active hook's event, command, and matchers, or `[all tool calls]` for an
unfiltered hook. An extension declaring hooks that are not active shows nothing here, which is the
fastest way to tell a trust/config problem from a manifest problem.
