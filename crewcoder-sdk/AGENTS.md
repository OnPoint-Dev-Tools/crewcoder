# CrewCoder SDK Development Rules

`@onpoint-dev-tools/crewcoder-sdk` is CrewCoder's supported Node.js/TypeScript embedding API. It is published to npm alongside CrewCoder.

## Boundary

- Keep the SDK narrower and more stable than `crewcoder-agent/src`.
- Integrate with the agent only through exports from `@onpoint-dev-tools/crewcoder-agent`; never import relative agent source files.
- Add runtime capabilities through `crewcoder-agent/src/sdk-runtime.ts` rather than reimplementing provider, session, approval, or event behavior.
- Keep `CrewCoderAdmin` local and Node-only. Configuration uses the agent's validated config contract; project profile writes must preserve unrelated `crewcoder.json` fields.
- Session administration must validate IDs before filesystem access. Deletion must reject traversal and symlink targets and must never remove workspace files.
- Rewind is scoped to the admin cwd, requires explicit confirmation, and must persist restore audit state. Memory remains project-local and opt-in.
- Describe worker crews and teams as sequential unless the runtime actually changes. Handoffs must create child sessions and preserve source history without mutating the source session.
- Extension acquisition never implies trust. ACP subprocesses use argument-array spawning with `shell: false`, deny permissions by default, and must be terminated on initialization failure or disposal.
- Keep the in-process `CrewCoderSession` and remote `CrewCoderFleetClient` as distinct contracts. Do not conflate either with ACP or JSON-events subprocess integration.
- Fleet clients must never place bearer tokens in URLs; HTTP/SSE use authorization headers and browser WebSockets use the dedicated authentication subprotocol.
- Fleet protocol 1.0 uses monotonic `fleetEventId` cursors. Reconnect from the last delivered event without deliberately replaying duplicates. Persist run history on the server; recover in-flight runs after restart as failed/interrupted rather than pretending execution continued.
- Preserve `thinking_delta`, approvals, durable session semantics, and provider failure reporting.

## API rules

- Use top-level imports and erasable TypeScript syntax.
- Do not use `any`.
- Keep `CrewCoderSession` controls valid only for the active run and return `false` when a control cannot be accepted.
- Persistent sessions are the default. Memory-only sessions skip session JSONL writes but are not a filesystem/network sandbox.
- `CrewCoderSessionOptions.externalDirectories` is a session-scoped grant passed through `sdk-runtime.ts`; never turn it into process-global filesystem authority. Relative paths remain rooted at `cwd`.
- Reject overlapping `prompt()` calls; use `followUp()` for live queued input.
- SDK-owned failures use stable `CrewCoderError` codes and typed fleet request/protocol subclasses. Host model, tool, callback, and listener errors may propagate unchanged.
- New public exports require tests, an update to `crewcoder-agent/docs/SDK.md`, changelog review, and an intentional `npm run api:update` declaration-baseline update.
- Agent and SDK package versions must match exactly. Both publish publicly; checks, builds, API snapshots, and package dry runs must never publish.

## Verification

Run from the monorepo root:

```sh
CREWCODER_HOME=/tmp/.crewcoder npm run typecheck -w @onpoint-dev-tools/crewcoder-sdk
env -u OPENCODE_API_KEY CREWCODER_HOME=/tmp/.crewcoder npm test -w @onpoint-dev-tools/crewcoder-sdk
npm run build -w @onpoint-dev-tools/crewcoder-sdk
npm run release:check:sdk
```
