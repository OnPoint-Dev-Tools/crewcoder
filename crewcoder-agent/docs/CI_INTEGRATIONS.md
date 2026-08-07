# CI integrations and Git hooks

CrewCoder ships three first-party wrappers around the `crewcoder run --ci`
contract:

- the root `action.yml` GitHub composite action;
- `.gitlab/crewcoder.gitlab-ci.yml`, a reusable GitLab job;
- `crewcoder hook install`, a managed pre-commit hook generator.

All three preserve the structured exit codes and JSON summary documented in
[CI_RUNS.md](./CI_RUNS.md).

## GitHub composite action

The repository-root action builds CrewCoder from the tagged action checkout, then
runs it in `github.workspace`. This source build is intentional while
`@onpoint-dev-tools/crewcoder-agent` remains private and unpublished.

```yaml
name: CrewCoder

on:
  pull_request:

jobs:
  crewcoder:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - id: crewcoder
        uses: your-org/crewcoder@v1
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
        with:
          prompt: Review and improve this pull request, then verify the repository.
          provider: opencode
          budget: 100k
          approval: sandboxed
```

Replace `your-org/crewcoder@v1` with the canonical repository/tag after the
repository is hosted. Within this repository, `uses: ./` exercises the same root
action.

Inputs:

| Input | Required | Default |
| --- | --- | --- |
| `prompt` | yes | — |
| `provider` | no | CrewCoder config |
| `model` | no | CrewCoder config |
| `effort` | no | CrewCoder/provider config |
| `budget` | no | unlimited |
| `approval` | no | `never` |
| `crewcoder-command` | no | build the tagged source checkout |

The `summary` action output contains the compact JSON document. A non-zero
CrewCoder result fails the action step with the same exit code. Provider
credentials must be supplied through the workflow environment; the action does
not persist or print them.

`crewcoder-command` is useful on a self-hosted runner that already has a pinned
CrewCoder binary. When set, the source build is skipped.

## GitLab job

The reusable template is `.gitlab/crewcoder.gitlab-ci.yml`. For this repository:

```yaml
include:
  - local: /.gitlab/crewcoder.gitlab-ci.yml

variables:
  CREWCODER_PROMPT: Review this merge request and verify the repository.
  CREWCODER_PROVIDER: opencode
  CREWCODER_BUDGET: 100k
  CREWCODER_APPROVAL: sandboxed
```

An external GitLab project can use `include:project` after CrewCoder has a
canonical hosted project/ref.

The GitLab runner must provide `crewcoder` on `PATH`. Until the npm package or a
runner image is published, either use a self-hosted runner with CrewCoder
installed or set:

```yaml
variables:
  CREWCODER_BIN: /path/to/crewcoder
```

`CREWCODER_INSTALL_COMMAND` is also supported for controlled runners. It is
executed through `sh -c`, so only set it in trusted, reviewed pipeline
configuration. The job uploads `crewcoder-summary.json` for seven days even when
CrewCoder exits non-zero.

## Pre-commit hook

Install a managed hook inside a Git repository:

```bash
crewcoder hook install --budget 25k
```

The hook:

- exits immediately when there are no staged changes;
- asks CrewCoder to inspect `git diff --cached`;
- runs through `crewcoder run --ci`, so repository verification is automatic;
- uses `--approval always` in the non-interactive hook, which denies mutation
  attempts and returns exit code `4`;
- requires the final review marker `CREWCODER_REVIEW_RESULT: PASS` or `FAIL`,
  blocks on `FAIL`, and fails closed if the marker is missing;
- blocks the commit when CrewCoder returns any non-zero structured exit code.

The review text and JSON summary are printed for the developer. Advisory comments
may still accompany `PASS`; actionable findings must produce `FAIL`.

Options:

```bash
crewcoder hook install --command /opt/crewcoder/bin/crewcoder
crewcoder hook install --budget 50k
crewcoder hook install --force
```

Re-running updates only CrewCoder's managed marker block and preserves content
outside it. An unrelated existing hook is refused. `--force` moves that hook to a
timestamped backup before installing CrewCoder's hook.

CrewCoder also refuses to write an effective `core.hooksPath` outside the current
repository or its Git directory. This prevents a repository command from
overwriting a shared/global hook. Configure a repository-local `core.hooksPath`
first when Git has a global shared hook path.

For an intentional one-off bypass:

```bash
CREWCODER_PRE_COMMIT_SKIP=1 git commit
```

Pre-commit model calls add latency and provider cost to every staged commit.
Use a modest `--budget`, or keep this integration in CI if that feedback loop is
too expensive locally.
