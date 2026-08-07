# Durable goals

CrewCoder implements `/goal` as a provider-independent orchestration feature. It is not forwarded to Codex as a slash command. Codex, Claude, OpenCode, and extension providers only produce model turns; CrewCoder owns goal persistence, continuation, tools, approvals, and process supervision.

## Lifecycle

```txt
queued -> running -> completed
                  -> awaiting_approval -> running
                  -> paused -> queued (resume)
                  -> failed
                  -> cancelled (clear)
```

A goal runs in a detached CrewCoder worker and survives closing the TUI or terminal that started it. Goal records live under:

```txt
~/.crewcoder/goals/<goal-id>/goal.json
~/.crewcoder/goals/<goal-id>/events.jsonl
~/.crewcoder/goals/<goal-id>/worker.log
~/.crewcoder/goals/<goal-id>/worker.err.log
```

`CREWCODER_HOME` changes the root as usual. Record writes are atomic, and `worker.lock` prevents two supervisors from running the same goal concurrently.

## CLI

```bash
crewcoder goal start "Migrate the project and stop when contract tests pass" \
  --provider codex --model gpt-5.6-luna --approval review
crewcoder goal status [goal-id]
crewcoder goal list
crewcoder goal pause [goal-id]
crewcoder goal resume [goal-id]
crewcoder goal clear [goal-id]
crewcoder goal approve [goal-id]
crewcoder goal deny [goal-id]
crewcoder goal logs [goal-id]
```

Every lifecycle command accepts `--json` where applicable for TUI and automation consumers.

Only one active or paused goal is allowed per workspace. Clear the current goal before starting a replacement.

## Goal configuration

CrewCoder uses `~/.crewcoder/config.json` rather than TOML. The equivalent of a `[goals]` section is:

```json
{
  "goals": {
    "maxTurns": 200,
    "checkModel": "gpt-5.6-luna",
    "timeoutMinutes": 480
  }
}
```

Configure it through the CLI:

```bash
crewcoder config set goals.maxTurns 200
crewcoder config set goals.checkModel gpt-5.6-luna
crewcoder config set goals.timeoutMinutes 480
```

`checkModel` always runs on the same provider as the goal worker. Model ids are provider-scoped, so select a checker that the chosen provider exposes. It is optional for backward compatibility; when omitted, `complete_goal` retains the legacy completion decision.

Each goal snapshots these settings at creation. Per-goal overrides are available:

```bash
crewcoder goal start "..." --max-turns 50 --check-model gpt-5.6-luna --timeout-minutes 120
crewcoder goal start "..." --no-check-model
```

`--no-check-model` explicitly disables verification for one goal even when a global checker is configured.

`maxTurns` counts detached supervisor cycles (a normal terminal agent response plus its tool-call loop), not every internal provider/tool turn. `timeoutMinutes` is wall-clock time from initial goal creation and includes approval waits and later resumes.

## Maker–verifier completion contract

Goal workers receive two host-owned tools in addition to CrewCoder's normal built-in and trusted extension tools:

- `complete_goal({ summary, evidence })`
- `pause_goal({ reason })`

An ordinary final assistant response does not complete a goal. If the model ends a normal turn without calling either tool, the detached supervisor persists a checkpoint and starts another cycle in the same durable session.

When `checkModel` is configured, CrewCoder makes a separate tool-free model call after every successful supervisor cycle. The checker receives the objective, recent assistant/tool-result evidence, changed files, cycle summary, and any `complete_goal` claim. It must return strict JSON with `continue` or `complete`. Its verdict is authoritative: it can reject the maker's completion claim or complete a goal whose transcript already proves the stopping condition.

The checker cannot mutate files or execute commands. `complete_goal` requires concrete evidence such as test commands, generated artifacts, or observed behavior, and the checker grades that evidence independently. Users should define deterministic validation commands in the goal whenever possible; maker–verifier separation reduces self-grading but does not turn model-reported evidence into an external proof system.

Verifier provider errors or malformed verdicts pause the goal rather than falling back to maker self-grading.

## Approvals and safety

Detached goals do not bypass CrewCoder safety:

1. A tool call requiring review emits `approval_required`.
2. The goal record changes to `awaiting_approval` and persists the exact tool, arguments, and reason.
3. The detached worker remains alive but blocked.
4. `goal approve` or `goal deny` writes a durable decision.
5. The worker consumes that decision and resumes or pauses after denial.

Provider errors, verifier failures, `maxTurns`, `timeoutMinutes`, token-budget exhaustion, explicit iteration caps, and stall detection pause the goal with an exact reason. They are recoverable with `goal resume` after fixing the blocker. Unexpected supervisor failures use `failed`.

Token budgets remain opt-in. A goal started without `--budget` is not silently given a default turn or token cap; existing stall detection still protects provable tool loops. Use a budget for unattended cost control:

```bash
crewcoder goal start "..." --budget 500k
```

## TUI

```txt
/goal <objective>
/goal status
/goal list
/goal pause
/goal resume
/goal clear
/goal approve
/goal deny
/goal logs
```

The TUI launches the detached worker through the CLI JSON contract and immediately returns to idle. `/goal status` renders a dedicated goal card with provider/model, cycle, session, blocker, completion evidence, and approval controls.

## Provider boundary

The Codex provider continues to call the Codex Responses endpoint normally. No goal state or slash-command text is added to `codex-provider.ts`. This keeps durable goals available to every provider and preserves CrewCoder ownership of sessions, tools, extensions, approvals, budgets, and audit logs.
