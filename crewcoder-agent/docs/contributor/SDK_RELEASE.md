# SDK Release and Compatibility Policy

This document defines release readiness for `@onpoint-dev-tools/crewcoder-agent`, `@onpoint-dev-tools/crewcoder-client`, and `@onpoint-dev-tools/crewcoder-sdk`. All three packages are published to npm under `publishConfig.access: public`. Running release checks never publishes packages.

## Distribution model

The agent runtime, browser client, and SDK are released as matching versions:

```txt
@onpoint-dev-tools/crewcoder-sdk
  -> dependency: @onpoint-dev-tools/crewcoder-agent <same version>
  -> dependency: @onpoint-dev-tools/crewcoder-client <same version>
```

Publish and verify the agent and client first, then publish the SDK. Do not bundle a second copy of either runtime dependency into the SDK.

All three packages use Apache-2.0. The agent and SDK require Node.js 22 or newer.

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

- agent, client, and SDK typechecks;
- complete agent, client, and SDK tests;
- production TypeScript builds;
- client and SDK declaration comparisons against their checked-in API baselines;
- npm package dry runs with source/test/secret exclusion checks.

When intentionally changing public declarations:

```sh
npm run api:update -w @onpoint-dev-tools/crewcoder-sdk
git diff -- crewcoder-sdk/api
```

Review the declaration diff, apply the semantic-versioning policy, and update `crewcoder-sdk/CHANGELOG.md`. Never update the baseline merely to make CI pass.

## Release checklist

1. Confirm the repository URL and npm ownership for all three packages.
2. Decide and apply the same release version to the agent, client, SDK, lockfile, and package version constants.
3. Confirm the SDK dependency versions exactly match the agent and client versions.
4. Update the changelog and client/SDK API baselines.
5. Run `npm run release:check:sdk` in a clean checkout with Node.js 22.
6. Review `npm pack --dry-run` contents for all three packages.
7. Confirm no package has reintroduced `private: true`.
8. Run the protected npm release workflow with `publish=false` first.
9. Publish and verify the agent and client, then publish the SDK with npm provenance.
10. Tag the exact published commit only after all npm registry checks pass.

## npm trusted publisher setup

The GitHub workflow publishes with npm trusted publishing (OIDC), not `NPM_TOKEN`. Configure a trusted publisher separately in the npm settings for each package:

- **Organization or user:** `OnPoint-Dev-Tools`
- **Repository:** `crewcoder`
- **Workflow filename:** `sdk-release.yml`
- **Environment:** `npm-release`

Configure all three packages: agent, client, and SDK. The workflow grants `id-token: write`, runs in the matching protected GitHub environment, and explicitly installs npm 11.8.0 because trusted publishing requires a recent npm CLI. Do not add `NODE_AUTH_TOKEN` back to the publish steps: an ordinary token on a 2FA-protected npm account causes `EOTP` because GitHub Actions cannot interactively enter an authenticator code.

If npm returns `EOTP`, confirm the trusted publisher fields exactly match the values above and that the workflow no longer supplies `NODE_AUTH_TOKEN`. A provenance statement by itself does not prove that trusted publishing authenticated the npm publish operation.

## Release execution commands

Run these commands from the repository root after preparing and verifying the coupled agent, client, and SDK version metadata. Replace `0.6.1` with the version being released.

```sh
export RELEASE_VERSION=0.6.1

git diff --check
git status --short
git commit -am "chore: prepare CrewCoder ${RELEASE_VERSION} release"
git push origin main
```

Trigger and watch the verification-only workflow:

```sh
gh workflow run sdk-release.yml --ref main -f publish=false
sleep 3

VERIFY_RUN="$(gh run list \
  --workflow sdk-release.yml \
  --branch main \
  --event workflow_dispatch \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"

gh run watch "$VERIFY_RUN" --exit-status
```

Confirm that `VERIFY_RUN` is the workflow run just triggered before relying on its result, especially if another maintainer may be releasing concurrently:

```sh
gh run view "$VERIFY_RUN"
```

Only after verification succeeds, explicitly trigger publishing:

```sh
gh workflow run sdk-release.yml --ref main -f publish=true
sleep 3

PUBLISH_RUN="$(gh run list \
  --workflow sdk-release.yml \
  --branch main \
  --event workflow_dispatch \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"

gh run view "$PUBLISH_RUN"
gh run watch "$PUBLISH_RUN" --exit-status
```

If GitHub requires approval from the protected `npm-release` environment, open the workflow run and approve it there:

```sh
gh run view "$PUBLISH_RUN" --web
```

After publishing succeeds, verify all coupled packages on npm before tagging the commit:

```sh
npm view "@onpoint-dev-tools/crewcoder-agent@${RELEASE_VERSION}" version
npm view "@onpoint-dev-tools/crewcoder-client@${RELEASE_VERSION}" version
npm view "@onpoint-dev-tools/crewcoder-sdk@${RELEASE_VERSION}" version

git tag -a "v${RELEASE_VERSION}" -m "CrewCoder ${RELEASE_VERSION}"
git push origin "v${RELEASE_VERSION}"
```

Optionally create the GitHub release after the tag is pushed:

```sh
gh release create "v${RELEASE_VERSION}" \
  --title "CrewCoder ${RELEASE_VERSION}" \
  --generate-notes
```

Do not tag or create the GitHub release if npm verification fails. Investigate the workflow first; npm versions cannot be overwritten once published.

## Publishing safety

The release workflow is manual and protected by the `npm-release` environment. Its default mode is dry-run. Publishing requires all of the following:

- explicit workflow input disabling dry-run;
- no package carrying a `private` field;
- matching agent/client/SDK versions;
- an npm trusted publisher configured for each package;
- environment approval.

No development, test, build, pack, or API-check command publishes packages.
