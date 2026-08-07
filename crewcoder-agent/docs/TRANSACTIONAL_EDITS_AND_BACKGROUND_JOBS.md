# Transactional edits and background jobs

## Multi-file transactional edits

`edit_transaction` applies exact replacements to multiple workspace files in one tool call.

- Every path and target string is read and validated before the first write.
- A path may appear in multiple replacement groups; every group is matched against the file's original content.
- Replacement ranges in the same file must not overlap. Any overlap or missing target rejects the entire transaction before a write.
- Each changed file is written once using a same-directory temporary file and rename.
- If a write fails, files already written are restored from their original content.
- The result includes a human-readable before/after preview plus structured `details.preview` and `details.paths`.
- Mutation logging and `file_changed` events occur only after the whole transaction commits.
- The normal pre-mutation session checkpoint covers the complete transaction.

## Background jobs

`background_job` supports three actions:

```json
{ "action": "start", "command": "npm run dev" }
{ "action": "status", "bgId": "bg_..." }
{ "action": "stop", "bgId": "bg_..." }
```

Starting returns immediately with a `bg_id`. Output is buffered up to 120 KB and can be read with `status`. Jobs are process-local and exist for the lifetime of the CrewCoder backend process.

Events:

- `background_job_start`
- `background_job_output`
- `background_job_status`
- `background_job_end`

Background jobs currently fail closed in sandboxed approval modes. A persistent job needs a sandbox lifecycle that remains enforced after the initiating tool call; silently escaping that boundary is not acceptable.
