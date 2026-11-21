# CrewCoder TUI core

`@onpoint-dev-tools/crewcoder-tui-core` is the UI-independent runtime shared by
CrewCoder's terminal UIs:

- [`@onpoint-dev-tools/crewcoder-opentui`](../crewcoder-opentui/README.md): the OpenTUI/React UI that the `crewcoder` umbrella launches.
- [`@onpoint-dev-tools/crewcoder-tui`](../crewcoder-tui/README.md): the legacy custom-renderer UI.

It contains no rendering code and runs on Node.js 22 or newer.

## Modules

Import by subpath (there is no root export):

| Subpath | Purpose |
|---|---|
| `bridge/crewcoder-process` | `CrewCoderProcessBridge`: spawns `crewcoder run --json-events` / `session resume`, writes approval, follow-up, UI-response and compaction control messages, and runs the one-shot CLI helpers (sessions, providers, extension renderers). |
| `bridge/event-parser` | Zod-validated parser for the agent's JSON event stream. |
| `bridge/remote-connection` | SSH target validation and POSIX quoting for `--remote` mode. |
| `bridge/live-ui-protocol` | Live UI message and permission types. |
| `state/tui-store` | `TuiState`, transcript block types, and `createInitialState()`. |
| `state/event-reducer` | `applyCrewCoderEvent(state, event)`: the single event-to-state reducer. |
| `state/usage`, `state/effort-levels`, `state/image-attachment`, `state/git-status` | Usage summaries, effort levels per model, image sniffing/persistence, and Git status labels. |
| `theme/crewcoder-theme` | Theme loading shared by both UIs: built-ins (`dark`/Gotham, `light`, `slate`), `--theme`/`CREWCODER_THEME` lookup (`$CREWCODER_HOME/themes/<name>.json` or a path), the JSON schema (`extends`, `vars`, `colors`, `syntax`, `markdown`), `listThemeFiles` (every theme file in a set of directories, loaded or with the reason it is unusable), and readable errors. |
| `theme/logo` | CrewCoder logo text (big block wordmark, compact, mini) used by both UIs' home screens. Plain strings; each UI colors and draws them itself. |

```ts
import { CrewCoderProcessBridge } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import { applyCrewCoderEvent } from "@onpoint-dev-tools/crewcoder-tui-core/state/event-reducer";
import { createInitialState } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
```

## Agent resolution

The bridge runs, in order: the SSH command when `CREWCODER_REMOTE` is set, then
`CREWCODER_BIN`, then a sibling `crewcoder-agent/dist/cli.js` (monorepo checkout or the
same npm scope directory), and finally `crewcoder` on `PATH`.

## Contract

The reducer and bridge are the TUI side of
[`TUI_BACKEND_CONTRACT.md`](../crewcoder-agent/docs/contributor/TUI_BACKEND_CONTRACT.md).
Rendering guardrails that both UIs must honor (thinking blocks, user-message
`background`, `message_end` replay handling, live approvals) are documented in
[`crewcoder-tui/AGENTS.md`](../crewcoder-tui/AGENTS.md#event-rendering-guardrails).
Changes here affect both UIs: run the core, legacy TUI, and OpenTUI test suites.

```bash
npm test -w @onpoint-dev-tools/crewcoder-tui-core
npm test -w @onpoint-dev-tools/crewcoder-tui
mise exec node@26 -- npm test -w @onpoint-dev-tools/crewcoder-opentui
```
