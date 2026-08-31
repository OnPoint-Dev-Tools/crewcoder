# Changelog

All notable changes to `@onpoint-dev-tools/crewcoder-sdk` are documented here. The project follows Semantic Versioning once the package reaches `1.0.0`.

## 0.6.5 - 2026-08-30

### Changed

- Coupled SDK, client, and agent versions to `0.6.5` so the umbrella patch can publish.

## 0.6.4 - 2026-08-30

### Security

- Fail-closed virtual filesystem custody: provider-native file tools cannot bypass an ACP/SDK file host. Codex skips app-server on virtual workspaces; `acp-client`, `process`, and `model-command` are refused before spawn.

### Changed

- Route provider-native approvals and questions through the host interaction channel instead of treating a missing callback as a silent decline.

## 0.6.3 - 2026-08-28

### Added

- `crewcoder` agent mode for a deliberate clarify-then-plan workflow, including `crewcoder_clarify` and `crewcoder_propose_plan` tools and `/approve-plan`.
- `crewcoder` in the browser client's `CrewCoderAgentMode` union.
- Session-local crew task display numbers and todo snapshots used by the agent and TUI.

### Changed

- The TUI recognizes `crewcoder` alongside `general`, `plugin`, and `extension`.

## 0.6.1 - 2026-08-12

### Added

- Readable Markdown conversations through `crewcoder session show <id>` and `--out`.
- Namespaced ACP compaction lifecycle updates for capable clients.

### Changed

- Scope built-in plugin and extension authoring tools to their explicit agent modes.
- Collect every question from Claude Agent SDK `AskUserQuestion` calls while preserving existing answers.

### Fixed

- Isolate agent tests from the operator's real CrewCoder home.

## 0.6.0 - 2026-08-08

### Added

- Durable and in-memory `CrewCoderSession` execution.
- Typed agent, thinking, approval, extension UI, usage, and tool events.
- Custom tools, model clients, host-provided text file I/O, and session-scoped external directory grants.
- Follow-up, approval, UI response, abort, and disposal controls.
- Authenticated `CrewCoderFleetClient` for HTTP, SSE, and WebSocket runners.
- Durable fleet run listing, event IDs, cursor replay, bounded SSE reconnect, and run waiting.
- Typed SDK, fleet request, and fleet protocol errors.
- SDK/API/protocol version constants and public declaration compatibility checks.
- `CrewCoderAdmin` configuration, integration-profile, repository-memory, durable-session, and checkpoint-rewind administration.
- `CrewCoderOrchestrator` for sequential worker crews, declarative teams, and transcript-preserving handoffs.
- Detached goal and deny-by-default extension lifecycle administration.
- ACP-backed `CrewCoderProcess` for isolated subprocess sessions.

### Security

- Fleet credentials use authorization headers or WebSocket subprotocols and never URL query parameters.
- Package release metadata uses npm provenance and public access only after the explicit private-package gate is removed.

## 0.5.0 - 2026-07-29

- Initial private SDK contract established during CrewCoder development.
