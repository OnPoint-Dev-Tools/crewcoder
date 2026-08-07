# Integration Profiles

CrewCoder can run as a standalone coding agent or enable compatibility with the CrewCode desktop app and plugin ecosystem.

## Profiles

### `standalone` (default)

The standard coding-agent experience. It keeps:

- general coding and CrewCoder extension modes;
- providers, models, sessions, goals, tasks, memory, checkpoints, and compaction;
- workers, crews, teams, delegation, and handoffs;
- file, shell, Git, LSP, and generic CrewCoder extension tools;
- CrewCoder extension renderers and Live UI.

It hides and rejects CrewCode-specific functionality:

- CrewCode plugin architect mode;
- `/plugins` in the TUI;
- `crewcoder plugin ...` CLI commands;
- `createPlugin`, `validatePlugin`, and plugin-template tools;
- CrewCode plugin skills, constraints, embedded plugin documentation, CLI doc search results, and doctor output.

### `crewcode`

Adds CrewCode desktop plugin development, plugin tools, manifests, validation, templates, constraints, and plugin-mode documentation.

## Configuration precedence

The effective profile is resolved in this order:

1. `integrationProfile` in the current repository's `./crewcoder.json`;
2. `integrationProfile` in the user's `~/.crewcoder/config.json`;
3. `standalone` when neither is configured.

A repository override does not modify or remove other `crewcoder.json` fields such as worker teams.

## CLI

Show the effective profile:

```bash
crewcoder profile show
```

Set the user default:

```bash
crewcoder profile use standalone
crewcoder profile use crewcode
```

Set only the current project:

```bash
crewcoder profile use standalone --project
crewcoder profile use crewcode --project
```

Project-scoped commands update `./crewcoder.json`.

## TUI

Open the profile picker:

```text
/profile
```

Set the current project's profile directly:

```text
/profile standalone
/profile crewcode
```

The TUI uses project-scoped profile changes. Switching to standalone while plugin mode is selected returns the session to general mode. CrewCode-only commands and modes disappear from pickers and the command palette. Direct attempts show an explanation and the command needed to enable compatibility.

Use `/reload` after changing profile files outside the TUI.

## CrewCode project detection

When the TUI opens a standalone repository with a high-confidence root marker, it offers to enable CrewCode integration for that project. Current markers are:

- root-level `crewcode.plugin.json`;
- a root `package.json` containing a `crewcode` object.

Detection never switches profiles silently. Choosing **Enable CrewCode integration** writes the project profile. Choosing **Keep standalone** writes `crewcodeProfilePromptDismissed: true` to `crewcoder.json`, so the prompt is not shown again. Explicitly selecting a project profile clears that dismissal.

CLI inspection and dismissal are also available:

```bash
crewcoder profile detect --json
crewcoder profile dismiss
```

## Existing-install migration

Missing profile settings resolve to `standalone` for both fresh and existing installations; there is no silent grandfathering into CrewCode mode. This keeps upgrades deterministic and prevents compatibility features from appearing without consent.

Existing CrewCode projects with a recognized marker receive the one-time TUI opt-in prompt. Projects that need compatibility can also opt in explicitly:

```bash
crewcoder profile use crewcode --project
```

If an existing user wants CrewCode compatibility as their default across repositories, they can set:

```bash
crewcoder profile use crewcode
```

Repository settings still take precedence over that user default.
