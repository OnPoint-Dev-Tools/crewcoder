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
  -> confirm requirements
  -> crewcoder_propose_plan
  -> /approve-plan
  -> implement
  -> verify and report
```

### 1. Understand and inspect

The agent first determines the requested deliverable: implementation, planning,
analysis, an update, an upgrade, or a downgrade. It may read and search the project
and run read-only discovery commands so its questions reflect the actual codebase.

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

After clarification, the agent restates the goal, scope, exclusions, decisions,
assumptions, and measurable acceptance criteria. It then proposes an ordered plan with
the likely files or system areas, validation work, and material risks.

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
approval. The current phase is persisted on the session and restored on resume.

This does not replace `--approval`. After the plan is approved, individual tool calls
may still require review under the selected approval policy.

## When to use another mode

- Use `general` when the request is already clear and immediate implementation is more
  useful than a mandatory confirmation round.
- Use `plugin` for CrewCode app plugins and their `crewcode.plugin.json` contract.
- Use `extension` for CrewCoder extensions and `crewcoder.extension.json` constraints.

The `crewcoder` mode receives normal coding tools. It does not inherit plugin or
extension authoring docs, skills, or specialized creation tools.
