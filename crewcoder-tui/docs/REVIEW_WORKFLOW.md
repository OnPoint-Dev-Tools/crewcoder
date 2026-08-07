# Review Workflow UX

The TUI `/review-summary` command renders a dedicated review summary block instead of dumping CLI text into system logs.

## Current flow

```txt
/review-summary
  -> crewcoder git review-summary --json
  -> TuiEventBlock { type: "review_summary" }
  -> MainViewport review summary card
```

The block shows:

- current branch, or `(no branch)`
- clean/dirty status
- changed file count and up to the first 8 file paths
- issue reference count and up to the first 6 branch/commit/status references

## Reducer contract

`applyCrewCoderEvent` also accepts a future JSON event:

```json
{ "type": "review_summary", "summary": { "branch": "main", "clean": true, "changedFiles": [], "issueReferences": [] } }
```

This keeps the UI ready if the backend later streams review summaries as events instead of command results.

## Provider integration boundary

Issue provider integrations are type/config-only for now. No network calls, auth prompts, token storage, or provider-specific fetch behavior should be added until the provider boundary is explicit.
