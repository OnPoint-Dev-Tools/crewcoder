# CLI launch

There are two bare-launch routes:

- The `crewcoder` **umbrella** package (`npm i -g crewcoder`) opens the OpenTUI UI,
  `@onpoint-dev-tools/crewcoder-opentui`. It is an optional dependency that needs
  Node.js >=26.4; when it is not installed or Node.js is older, the umbrella opens this
  legacy UI instead (a required umbrella dependency) and prints a notice saying how to
  get OpenTUI. See the [installation guide](../../docs/INSTALLATION.md).
- The scoped **agent** package opens this legacy UI, as described below.

With the scoped agent and this package installed or linked, launching CrewCoder without arguments opens the legacy terminal UI:

```bash
crewcoder
```

The `crewcoder` executable belongs to `@onpoint-dev-tools/crewcoder-agent`. Its zero-argument route starts the `crewcoder-tui` executable. The TUI is independently packaged and must therefore be on `PATH`:

```bash
npm link -w @onpoint-dev-tools/crewcoder-agent
npm link -w @onpoint-dev-tools/crewcoder-tui
```

Agent operations remain argument-bearing commands, including calls made by the TUI bridge:

```bash
crewcoder run --json-events "Implement the task"
crewcoder session resume <session-id> --json-events
crewcoder providers --json
```

This distinction prevents the TUI backend from recursively launching another TUI instance.
