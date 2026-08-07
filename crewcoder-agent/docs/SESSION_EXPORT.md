# Session → HTML Export

Export a durable session as a single, self-contained HTML document — no external assets, safe to
open or share offline.

## Command

```bash
crewcoder session export <id> --html                 # write HTML to stdout
crewcoder session export <id> --html --out <path>    # write HTML to a file (creates parent dirs)
```

`--html` is the default (and currently only) format. TUI: `/export [path]` writes
`<sessionId>.html` (or the given path) and logs the location.

## What the document contains

1. **Header** — session id, start time, working dir, requested → resolved mode, provider, model,
   and the original prompt.
2. **Token usage** — a per-model table (`byModel`) with turns and input/output/total tokens,
   plus a totals row and the token budget line when one is set. Pricing estimates are not recorded.
3. **File changes** — diffs **reconstructed from the recorded tool calls**, so the export is
   self-contained and reflects exactly what the agent did:
   - `write` calls render the full content as added (`+`) lines.
   - `edit` calls render `find` as removed (`-`) lines and `replace` as added (`+`) lines.
4. **Transcript** — every message (user / assistant / tool result) with roles, assistant stop
   reasons, user `background` context (muted), and collapsible tool-call argument blocks.

## Safety

All user-controlled content (prompt, message text, tool args, tool output, file paths) is
HTML-escaped, so a session that contains `<script>` or other markup cannot inject executable
content into the exported page. Styling is a single inline `<style>` block with a
`prefers-color-scheme` dark variant.

## Key files

- `src/core/session-export.ts` — `renderSessionHtml(record)`.
- `src/cli.ts` — `session export` command.
- `src/tests/session-export.test.ts` — self-containment, escaping, diff reconstruction, token-usage rollup.
