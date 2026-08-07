# CLI launch

With both workspace packages installed or linked, launching CrewCoder without arguments opens the terminal UI:

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
