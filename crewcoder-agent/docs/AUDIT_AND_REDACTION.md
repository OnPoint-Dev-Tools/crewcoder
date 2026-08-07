# Audit Log and Dump Redaction

CrewCoder records security-relevant runtime activity in an append-only JSONL audit log at:

```txt
$CREWCODER_HOME/logs/audit.jsonl
```

## Captured events

The audit log captures:

- `tool_call` — tool execution start, including redacted args.
- `tool_result` — tool execution completion/error status.
- `approval` — approval prompts and resolved decisions.
- `write` — workspace file mutation notifications.

Read entries with:

```bash
crewcoder audit
crewcoder audit --since 2h
crewcoder audit --since 2026-01-01T00:00:00.000Z --json
```

## Secret redaction

`--dump-model-input` writes model payloads to `$CREWCODER_HOME/logs`, but secrets are redacted before disk writes. Audit entries use the same redactor.

Redaction covers:

- sensitive object keys such as `token`, `secret`, `password`, `apiKey`, `authorization`, and `privateKey`
- `.env*` file content payloads
- `.env`-style secret assignment lines
- AWS access key IDs
- bearer tokens
- private key PEM blocks

The in-memory provider request is not changed; only persisted debug/audit artifacts are scrubbed.
