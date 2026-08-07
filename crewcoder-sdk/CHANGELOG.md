# Changelog

All notable changes to `@onpoint-dev-tools/crewcoder-sdk` are documented here. The project follows Semantic Versioning once the package reaches `1.0.0`.

## 0.6.0 - Unreleased

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
