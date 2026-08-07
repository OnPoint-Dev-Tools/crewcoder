# Prompt/response IDs, session search, and reproducible runs

## Stable prompt/response IDs

Every provider-produced assistant message is persisted with:

- `promptHash`: SHA-256 of the canonical exact `ModelInput`
- `responseHash`: SHA-256 of response role/content/stop reason/error, excluding timestamps
- `id`: short combined identifier in the form `pr_<20 hex characters>`

Object keys are canonicalized before hashing, so equivalent payloads produce stable hashes. The exact model input for every provider turn is stored in `SessionRecord.modelTurns[]` alongside the hashes and response ID.

## Searchable history

```bash
crewcoder search "error TS2322"
crewcoder search pr_ab12cd34 --json
```

Search scans all durable sessions, including user, assistant, and tool-result text. Assistant IDs and full prompt/response hashes are searchable. Results include session ID, timestamp, cwd, role, message index, hash metadata, and a bounded snippet.

## Reproducible runs

```bash
crewcoder run --replay=<session-id> --at=<turn>
```

`turn` is the original 1-indexed provider turn. Replay sends the stored `ModelInput` object directly to the provider without rebuilding the system prompt, repository context, transcript, tool schemas, or session metadata. It creates a new child session linked through `parentSessionId` and reports whether the new response hash matches the original.

Provider and model default to those stored on the source session. They may be overridden explicitly to test the same input against another backend.

Sessions created before model-turn capture was introduced remain readable and searchable, but cannot be replayed because their exact provider payload was not persisted.
