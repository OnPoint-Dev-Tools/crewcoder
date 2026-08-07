# System Prompts

For the bigger picture, see [INSTRUCTION_LAYERS.md](./INSTRUCTION_LAYERS.md).

CrewCoder always builds its default system prompt first. New sessions use only
that default prompt until a custom system prompt is explicitly selected for the
current TUI session with `/prompts` or for a single CLI run with
`--system-prompt <name>`.

Custom prompts are stored in CrewCoder home:

```txt
~/.crewcoder/system-prompts/<prompt_name>/SYSTEM-PROMPT.md
```

When `CREWCODER_HOME` is set, the same structure is created under that directory.

## Commands

Save a prompt:

```sh
crewcoder system-prompt save strict-review --file ./SYSTEM-PROMPT.md
```

Use [SYSTEM_PROMPT_TEMPLATE.md](./contributor/SYSTEM_PROMPT_TEMPLATE.md) as a starting point
for user-authored profiles.

Run once with a specific prompt:

```sh
crewcoder run --system-prompt strict-review "review this code"
```

List, show, or locate prompts:

```sh
crewcoder system-prompt list
crewcoder system-prompt show strict-review
crewcoder system-prompt path strict-review
```

## Injection Order

The provider-facing prompt is composed in this order:

```txt
1. CrewCoder default system prompt, including mode, skills, docs, project, and session context
2. Custom system prompt selected for this TUI session or passed with --system-prompt
```

The selected prompt name is recorded on saved sessions as `systemPrompt` metadata.
It is not a global default for future sessions.

## Prompt Commands

Prompt commands are reusable normal prompts, not system prompts. They live under:

```txt
~/.crewcoder/commands/
```

CrewCoder supports both flat files and grouped folders:

```txt
~/.crewcoder/commands/fix-tests.md
~/.crewcoder/commands/review/COMMAND.md
```

In the TUI, `/commands` opens a picker and inserts the selected command content
into the composer so it can be edited before sending.
