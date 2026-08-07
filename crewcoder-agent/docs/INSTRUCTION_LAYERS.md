# Instruction Layers

CrewCoder has several places where instructions and durable context can live. They overlap on purpose, but they should not be used for the same job.

```txt
AGENTS.md
  Project architecture and law for this repo

.crewcoder/rules
  Modular, path-aware project rules

.crewcoder/memory
  Durable project facts learned across sessions

IDENTITY.md
  Who the active worker is

System prompt profile
  How CrewCoder should behave for a selected mode of work

/commands
  Reusable normal prompts inserted into the composer
```

## Quick Guide

| Layer                 | Lives in                                              | Injected into model?                   | Best for                                              |
| --------------------- | ----------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| `AGENTS.md`           | Repo/workspace                                        | Depends on runtime/project context     | Project law, architecture, commands, repo-wide rules  |
| `.crewcoder/rules`    | `<repo>/.crewcoder/rules/**/*.md`                     | Yes, as bounded initial background     | Modular/path-aware style, testing, security, patterns |
| `.crewcoder/memory`   | `<repo>/.crewcoder/memory/*.md`                       | Yes, as bounded initial background     | Durable facts learned across sessions                 |
| `IDENTITY.md`         | `~/.crewcoder/workers/<worker>/IDENTITY.md`           | Yes, through the worker identity block | Stable worker persona and specialty                   |
| System prompt profile | `~/.crewcoder/system-prompts/<name>/SYSTEM-PROMPT.md` | Yes, after CrewCoder's default prompt  | Selectable behavior profiles                          |
| `/commands`           | `~/.crewcoder/commands/`                              | No, not automatically                  | Reusable user-message templates                       |

## AGENTS.md

Use `AGENTS.md` for rules that belong to the project itself.

Good examples:

```md
Run `npm run typecheck -w @onpoint-dev-tools/crewcoder-agent` after backend changes.
Do not remove provider thinking streams without replacing the behavior and tests.
Update `crewcoder-agent/docs/*` when adding user-facing backend features.
```

Avoid putting personal style or temporary workflow preferences here. If the rule
should follow the repo no matter who works on it, it belongs in `AGENTS.md`.

## `.crewcoder/rules`

Use repository rules for modular conventions that benefit from path scoping. Files without frontmatter always apply; files with `paths` apply when the repository contains a matching file.

```md
---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---
# TypeScript

Avoid `any`; narrow untrusted input from `unknown`.
```

Always-on rules load before path-scoped rules, and scoped rules are more specific. Rules are text guidance only; a `hooks.md` rule never executes commands.

Loading lifecycle:

```txt
new CLI/TUI session
  -> detect Git repository root
  -> load and path-match .crewcoder/rules
  -> inject active rules into initial user-message background
  -> preserve that context for durable continuation
```

After editing a rule in the TUI, use `/new` to load the updated files. See `REPOSITORY_RULES.md` for limits, precedence, this repository's curated example, and Claude-rules migration.

## `.crewcoder/memory`

Use memory for concise durable facts discovered during work, such as an API base path or a stable project convention not yet documented elsewhere. Memory is not a substitute for reviewed project law: promote important architectural rules into `AGENTS.md` or `.crewcoder/rules`.

## IDENTITY.md

Use `IDENTITY.md` to define who a worker is.

Path:

```txt
~/.crewcoder/workers/<worker-name>/IDENTITY.md
```

Good examples:

```md
# Cortex

You are Cortex, CJ's coding partner.
You are direct, careful, and willing to push back when the design is weak.
You specialize in TypeScript, TUI UX, provider integration, and repo cleanup.
```

Keep `IDENTITY.md` stable and focused. It should describe the worker's identity,
not every workflow the worker might use. On first use, CrewCoder creates `Crew` with
a practical starter identity and owner placeholders `CrewCoder User` / `@CrewCoderUser`.
Customize those files in `~/.crewcoder/workers/Crew/`; CrewCoder does not overwrite an
existing worker.

Useful commands:

```sh
crewcoder workers list
crewcoder workers create Review-Crew --description "Strict code reviewer"
crewcoder workers use Review-Crew
crewcoder workers path Review-Crew
```

## System Prompt Profiles

Use system prompt profiles for selectable operating behavior. CrewCoder injects
its default system prompt first, then appends the selected custom profile only
for the current TUI session or one CLI run.

Path:

```txt
~/.crewcoder/system-prompts/<name>/SYSTEM-PROMPT.md
```

Good examples:

```md
# Strict Review

Prioritize correctness, security, regressions, and missing tests.
Lead with findings. Include file references.
Do not summarize first if there are bugs.
Say clearly when verification was not run.
```

```md
# Frontend Builder

Build the actual usable interface first.
Prefer existing design patterns.
Check mobile and desktop layout.
Avoid decorative UI that does not help the workflow.
```

Useful commands:

```sh
crewcoder system-prompt save strict-review --file ./SYSTEM-PROMPT.md
crewcoder system-prompt list
crewcoder run --system-prompt strict-review "review this diff"
```

## /commands

Use `/commands` for reusable normal prompts. These are not system prompts and do
not change the agent's identity. In the TUI, selecting a command inserts its
content into the composer so the user can edit it before sending.

Paths:

```txt
~/.crewcoder/commands/fix-tests.md
~/.crewcoder/commands/review/COMMAND.md
```

Good examples:

```md
Review the current diff for correctness, missing tests, and user-facing
regressions. Return findings first, then verification status.
```

```md
Find the real error before changing code. Check logs, failing commands, and
relevant files. Then propose and implement the smallest fix.
```

Useful commands:

```sh
crewcoder command save review-diff --file ./review-diff.md
crewcoder command list
crewcoder command show review-diff
```

Inside the TUI:

```txt
/commands
```

## Choosing The Right Layer

Use this rule of thumb:

```txt
Is it repo-wide architecture or law?
  -> AGENTS.md

Is it a modular or path-specific repo convention?
  -> .crewcoder/rules

Is it a durable fact learned during work?
  -> .crewcoder/memory

Is it about who the worker is?
  -> IDENTITY.md

Is it a selectable behavior profile?
  -> System prompt profile

Is it a reusable message the user may edit?
  -> /commands
```

Examples:

```txt
"Always run package-local typecheck after backend edits."
  -> AGENTS.md

"You are Cortex, CJ's coding partner."
  -> IDENTITY.md

"When reviewing code, lead with bugs and risks."
  -> System prompt profile

"Review this diff and return findings first."
  -> /commands
```