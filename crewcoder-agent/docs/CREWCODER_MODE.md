# CrewCoder deliberate workflow mode

The `crewcoder` agent mode is an opt-in workflow for users who want to agree on
requirements and implementation details before the agent changes a project. It works
with any repository or local project; it is not limited to developing CrewCoder itself.

Select it for a run:

```bash
crewcoder run --mode crewcoder "add organization-level audit logs"
crewcoder config set defaultMode crewcoder
```

In the TUI, open `/modes` and select `crewcoder`. The selected mode is saved with the
session and restored when that session resumes. Clarification questions and the
proposed plan wrap to the terminal width so the full text stays readable. After a
plan is proposed, approve it with `/approve-plan` (this is not the same as
`/approve`, which is for pending tool calls).

CrewCoder mode uses the regular durable session store. The initial user message and
workflow state are written before the first provider request starts, so aborting an
in-progress first turn still leaves a session that can be resumed normally.

## Workflow contract

The mode follows the same ordered template on every task:

```txt
understand and inspect
  -> crewcoder_clarify
  -> user answers
  -> complete task-specific read-only investigation
  -> confirm requirements and concrete file proposals
  -> crewcoder_propose_plan
  -> /approve-plan
  -> implement
  -> verify and report
```

### 1. Understand and inspect

The agent first determines the requested deliverable: implementation, planning,
analysis, an update, an upgrade, or a downgrade. It searches and reads the relevant
implementation, callers, tests, configuration, and existing patterns so its questions
reflect the actual codebase. It reads planned edit targets fully; large files may
require multiple reads. For a new project, it inspects the directory and constraints
before choosing a structure.

Before plan approval, the agent must not edit files, install or remove dependencies,
change configuration, run migrations, start services, or perform another mutation.

### 2. Clarify

Every task must call `crewcoder_clarify` with at least one clarification or
confirmation question, even if the initial request looks complete. Free-text questions
do not unlock later phases. Questions are limited to decisions that affect the result
and may cover:

- the desired outcome and motivation;
- where the change belongs and what is out of scope;
- behavior, user experience, or API contracts;
- technical, compatibility, or migration constraints;
- acceptance criteria and required validation;
- delivery timing or sequencing when it matters.

The agent should discover repository facts itself, offer a recommended option when
tradeoffs are unclear, and batch a small set of related questions.

### 3. Confirm and plan

Clarification answers guide further investigation. The agent traces the relevant
behavior and integration points, inspects proposed edit targets and tests, and resolves
material unknowns before asking for approval. Another clarification round is appropriate
when a decision cannot be learned from the code.

The proposal restates the goal, scope, exclusions, decisions, and assumptions and includes:

- `investigation`: inspected files, current behavior, cause or integration points,
  existing patterns, and remaining assumptions;
- `fileChanges`: exact project-relative paths, `modify`/`create`/`delete` actions,
  the purpose of each change, and representative proposed code or diff snippets,
  including tests and documentation;
- `plan`: ordered implementation steps, integration details, and material risks;
- `acceptanceCriteria`: measurable checks and concrete validation commands.

Use `fileChanges: []` only when the deliverable requires no file changes, and explain
why in the plan. Snippets are proposals for review; they are not applied edits or a
promise that the final patch will be byte-for-byte identical. The plan must not defer
initial codebase investigation or architecture decisions until implementation.

The agent must call `crewcoder_propose_plan` and then stop. An implementation request
made before that tool runs does not count as approval. Revised requirements produce a
revised plan and another approval request. Approve with `/approve-plan` or a short
unambiguous approval such as `approve` or `lgtm`.

### 4. Implement and verify

After unambiguous approval, the agent executes the plan, preserving unrelated work and
using normal CrewCoder task tracking, mutation approvals, checkpoints, and sandbox
rules. Material scope expansion, removal of intentional behavior, a new external
dependency, or a conflict with an approved requirement requires another user decision.

The final report states what changed, which verification was observed, any deviations
from the approved plan, and what remains unresolved.

## Enforcement boundary

The workflow is a runtime gate, not a prompt-only request:

```txt
crewcoder_clarify
  -> user answers
  -> crewcoder_propose_plan
  -> user approves with /approve-plan (or a short unambiguous approval)
  -> mutating tools unlock
```

Edits, writes, mutating shell commands, background jobs, worker delegation, and
memory writes are blocked until that sequence completes. Read-only inspection
(`read`, `grep`, `listFiles`, `git status` / `git log` / `git diff`, and similar
discovery commands) stays available. Answering a clarification question is not plan
approval. Plan submission also requires an observed successful inspection and valid
findings/file-proposal fields. Failed reads and nonzero shell exits do not satisfy the
inspection gate. Built-in discovery and recognized provider-native read/search tools
can satisfy it; a directory inventory supports an empty-project task. Inspection
state and the full rendered proposal are persisted and restored on resume.

This is a minimum evidence gate, not a semantic proof that the agent understands the
code. The model is instructed to continue task-specific investigation beyond that
minimum until it can explain the intended implementation.

This does not replace `--approval`. After the plan is approved, individual tool calls
may still require review under the selected approval policy.

## When to use another mode

- Use `general` when the request is already clear and immediate implementation is more
  useful than a mandatory confirmation round.
- Use `plugin` for CrewCode app plugins and their `crewcode.plugin.json` contract.
- Use `extension` for CrewCoder extensions and `crewcoder.extension.json` constraints.

The `crewcoder` mode receives normal coding tools. It does not inherit plugin or
extension authoring docs, skills, or specialized creation tools.
