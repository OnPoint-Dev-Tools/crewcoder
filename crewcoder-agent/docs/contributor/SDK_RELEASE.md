# SDK Release and Compatibility Policy

This document defines release readiness for `@onpoint-dev-tools/crewcoder-agent` and `@onpoint-dev-tools/crewcoder-sdk`. Both packages remain private until an explicit release decision removes their `private` package gates. Running release checks never publishes packages.

## Distribution model

The agent runtime and SDK are released as matching versions:

```txt
@onpoint-dev-tools/crewcoder-sdk
  -> dependency: @onpoint-dev-tools/crewcoder-agent <same version>
```

Publish the agent first, verify it is available from npm, then publish the SDK. Do not bundle a second copy of the agent runtime into the SDK.

Both packages use Apache-2.0 and require Node.js 22 or newer.

## Public API boundary

The supported SDK boundary is the root export of `@onpoint-dev-tools/crewcoder-sdk`. Files under `src/`, package-internal paths, generated `dist/` subpaths, and `@onpoint-dev-tools/crewcoder-agent` internals are not SDK API.

Stable public areas:

- `CrewCoderSession` and `createCrewCoderSession`
- session, prompt, event, tool, model, text-file, and result types
- `CrewCoderFleetClient`
- fleet request, summary, event, control, reconnect, wait, and health types
- typed SDK/fleet errors
- SDK, API, and fleet protocol version constants

The declaration baseline under `crewcoder-sdk/api/` is authoritative for accidental API-change detection.

## Semantic versioning

After `1.0.0`:

- **Patch:** bug fixes that preserve accepted inputs, outputs, event meanings, and error codes.
- **Minor:** additive methods, options, event variants, or fields. Consumers must ignore unknown event types and additional object fields.
- **Major:** removed or renamed exports, changed required parameters, narrowed accepted values, incompatible event/control semantics, or changed durable wire behavior.

Before `1.0.0`, every release must still document incompatible changes explicitly. Release review decides whether a change advances the package minor or major component.

## Deprecation policy

Public APIs are marked `@deprecated` in declarations and documented in the changelog before removal. After `1.0.0`, keep deprecated APIs for at least one minor release unless retaining them creates a security vulnerability. Security removals may be immediate and must be called out prominently.

## Error contract

SDK-owned validation, lifecycle, HTTP, and protocol failures use `CrewCoderError` subclasses with stable `code` values. Provider, custom model, custom tool, host callback, and event-listener errors may propagate from host-owned code and are not rewritten as SDK errors.

Fleet HTTP failures use `CrewCoderFleetRequestError`, including status, response body, and retryability. Invalid server payloads use `CrewCoderFleetProtocolError`. Abort uses `CrewCoderError` with code `ABORTED` where the SDK owns the wait/reconnect operation.

## Fleet durability contract

Fleet protocol `1.0` guarantees:

- monotonically increasing per-run event IDs;
- `id:` fields in SSE and `fleetEventId` in JSON events;
- replay after a cursor with `after=<eventId>` or `Last-Event-ID`;
- bounded SDK reconnect from the last delivered cursor without deliberate duplicate replay;
- durable run metadata and append-only event records when persistence is enabled;
- recovery of completed, failed, and aborted run history after restart;
- recovery of an in-flight run as `failed` with `interrupted: true` after server restart.

Ordinary fleet execution does not continue across process death. Use detached CrewCoder goals for work that must continue durably across process restarts and explicit approval waits.

Fleet state is stored under `<CREWCODER_HOME>/fleet-runs/` with private directory/file permissions. Run requests and events may contain prompts, tool arguments, paths, and model output; protect the CrewCoder home as sensitive data.

## Compatibility checks

From the repository root:

```sh
npm run release:check:sdk
```

The check runs:

- agent and SDK typechecks;
- complete agent and SDK tests;
- production TypeScript builds;
- SDK declaration comparison against `crewcoder-sdk/api/`;
- npm package dry runs with source/test/secret exclusion checks.

When intentionally changing public declarations:

```sh
npm run api:update -w @onpoint-dev-tools/crewcoder-sdk
git diff -- crewcoder-sdk/api
```

Review the declaration diff, apply the semantic-versioning policy, and update `crewcoder-sdk/CHANGELOG.md`. Never update the baseline merely to make CI pass.

## Release checklist

1. Confirm the repository URL and package ownership for both npm scopes.
2. Decide and apply the release version to the agent, SDK, lockfile, and `CREWCODER_SDK_VERSION`.
3. Confirm SDK dependency version exactly matches the agent version.
4. Update changelog and API baseline.
5. Run `npm run release:check:sdk` in a clean checkout with Node.js 22.
6. Review `npm pack --dry-run` contents for both packages.
7. Remove `private: true` only after explicit release approval.
8. Run the protected npm release workflow in dry-run mode first.
9. Publish agent, verify installation, then publish SDK with npm provenance.
10. Restore or retain release protections according to the next development cycle policy.

## Publishing safety

The release workflow is manual and protected by the `npm-release` environment. Its default mode is dry-run. Publishing requires all of the following:

- explicit workflow input disabling dry-run;
- package `private` fields already removed in a reviewed change;
- matching agent/SDK versions;
- an npm trusted publisher or scoped automation token;
- environment approval.

No development, test, build, pack, or API-check command publishes packages.
