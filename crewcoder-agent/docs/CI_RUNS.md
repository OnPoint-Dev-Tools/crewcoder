# CI runs

`crewcoder run --ci` provides a stable, headless contract for pipelines:

```bash
crewcoder run --ci --budget 100k --approval never \
  "Implement the requested change and leave the repository verified"
```

CI mode:

- runs the normal post-agent verification gate automatically, including package
  `typecheck`/`test` scripts and trusted extension validators;
- writes exactly one compact JSON summary to stdout;
- sends tool progress and diagnostics to stderr;
- exits with a structured code based on the primary run outcome.

`--ci` cannot be combined with `--json-events` because both formats own stdout.
It also cannot be combined with `--replay`; reproducible replay reports the stored
turn result rather than running the CI verification contract.

## Exit codes

| Code | Status | Meaning |
| ---: | --- | --- |
| `0` | `success` | The agent completed and every verification check passed. |
| `1` | `failed` | Setup, provider, stall, or explicit iteration-cap failure. |
| `2` | `verification_failed` | A typecheck, test, or trusted validator failed. |
| `3` | `budget_exceeded` | The durable token budget stopped the run. |
| `4` | `approval_denied` | A required tool approval was denied. |

Terminal stop reasons take precedence over post-run verification. In practice,
approval denial and budget exhaustion stop agent work before a verification
failure can redefine the outcome.

Approval modes remain explicit. For example, `--approval review` in headless CI
denies a required review gate immediately because there is no interactive control
channel; that produces exit code `4`. Use `--approval sandboxed` or
`--approval full-access` only when that trust level is appropriate for the runner.

## JSON schema

The stdout document has `schemaVersion: 1` and this stable top-level shape:

```json
{
  "schemaVersion": 1,
  "status": "success",
  "success": true,
  "exitCode": 0,
  "sessionId": "session_...",
  "mode": "general",
  "provider": "codex",
  "model": "gpt-5",
  "summary": "CrewCoder completed in general mode.",
  "changedFiles": ["src/example.ts"],
  "usage": {
    "turns": 3,
    "totalTokens": 12000
  },
  "verification": {
    "ok": true,
    "checks": []
  },
  "failure": null
}
```

Failures preserve the same fields. Errors that occur before a session starts use
`null` for session, mode, provider, model, usage, and verification, with details in
`failure.message`.

Pipeline consumers should branch on the process exit code and may use `status` as
a readable equivalent. `changedFiles`, verification output, usage, and the durable
`sessionId` are available for later CI annotations and artifact uploads.

See [CI_INTEGRATIONS.md](./CI_INTEGRATIONS.md) for the first-party GitHub action,
GitLab job, and managed pre-commit hook generator.
