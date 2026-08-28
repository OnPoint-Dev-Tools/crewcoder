# On-demand skills

CrewCoder does not auto-inject user skill bodies into the system prompt. Agents
may open a skill when they decide they need it.

## Catalogs

Read-only roots, in discovery order with duplicates removed:

- `~/.agents/skills` — cross-agent user catalog
- `$CREWCODER_HOME/skills` (`~/.crewcoder/skills` unless `CREWCODER_HOME` or
  `CREWCODER_SKILLS_DIR` overrides it)
- `~/.claude/skills`
- `~/.codex/skills`

Project copies such as `<repo>/.agents/skills` already sit inside the workspace
root, so they do not need a special grant.

`crewcoder skill list` / `crewcoder skill show` and the TUI `/skills` command
surface the CrewCoder home catalog only. Attaching a skill that way is still
opt-in: the body is prepended to the next user message, not forced on every turn.

## What is allowed

- `read`, `grep`, and `listFiles` may open files inside those catalogs
- Nested ACP agents (`grok` and other `acp-client` runtimes) may `fs/read_text_file`
  those paths
- Existing catalogs are passed as extra `additionalDirectories` so a nested
  agent's sandbox treats them as permitted roots
- Elevated read-only permission requests whose paths sit inside a catalog are
  allowed without a user prompt

## What stays blocked

- `write`, `edit`, and ACP `fs/write_text_file` against skill catalogs
- Auto-enabling Claude's Skill tool (`skills: []` remains on the Claude Agent SDK
  provider)
- Treating a skill catalog as a session `--add-dir` grant
