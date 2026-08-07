<div align="center">

<img src="assets/crewcoder-logo.png" alt="CrewCoder" width="420" />

**Extensible, security-conscious coding-agent platform**

[![SDK checks](https://github.com/OnPoint-Dev-Tools/crewcoder/actions/workflows/sdk-check.yml/badge.svg)](https://github.com/OnPoint-Dev-Tools/crewcoder/actions/workflows/sdk-check.yml)
[![npm (sdk)](https://img.shields.io/npm/v/@onpoint-dev-tools/crewcoder-sdk?label=sdk)](https://www.npmjs.com/package/@onpoint-dev-tools/crewcoder-sdk)
[![npm (client)](https://img.shields.io/npm/v/@onpoint-dev-tools/crewcoder-client?label=client)](https://www.npmjs.com/package/@onpoint-dev-tools/crewcoder-client)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

</div>

# CrewCoder Monorepo

This directory is an npm-workspaces monorepo for the CrewCoder Packages, a private root package owns shared tooling, workspace scripts, and a single lockfile, while each package keeps its runtime dependencies and build entrypoints.

## CrewCoder

**CrewCoder is an extensible, security-conscious coding-agent platform designed for interactive development, multi-worker orchestration, durable sessions, detached goals, and remote execution. Can also be used for the CrewCode ecosystem.**

- `crewcoder-agent` — `@onpoint-dev-tools/crewcoder-agent`
- `crewcoder-sdk` — `@onpoint-dev-tools/crewcoder-sdk` (private supported in-process and authenticated fleet API)
- `crewcoder-tui` — `@onpoint-dev-tools/crewcoder-tui`

## CLI launch

After linking or installing the CLI packages, `crewcoder` and its short alias `cc` invoke the same command. With no arguments, either opens the CrewCoder TUI.

## Common commands

```sh
npm install
npm run build
npm run typecheck
npm run test
npm run check
```

Run one workspace directly:

```sh
npm run dev -w @onpoint-dev-tools/crewcoder-agent
npm run typecheck -w @onpoint-dev-tools/crewcoder-sdk
npm run dev -w @onpoint-dev-tools/crewcoder-tui
```

## TypeScript SDK

`@onpoint-dev-tools/crewcoder-sdk` `0.6.0` is the supported Node.js 22+ API for custom interfaces, automated workflows, custom tools, programmatic agent tests, and authenticated remote fleet clients. It supports typed events/errors, durable or in-memory sessions, approvals, follow-ups, cancellation, persistent fleet history, event cursors, reconnect, HTTP/SSE controls, and safe WebSocket connection metadata. The package stays private until CrewCoder's public release.

See `crewcoder-agent/docs/SDK.md` for SDK examples, `crewcoder-agent/docs/FLEET_MODE.md` for the VPS workflow, and `crewcoder-agent/docs/contributor/SDK_RELEASE.md` for compatibility and release gates.

## Detached durable goals

```sh
crewcoder goal start "Complete the migration and stop when contract tests pass" --provider codex
crewcoder goal status
crewcoder goal approve
```

The TUI exposes the same workflow through `/goal`. Goals survive closing the TUI and pause safely for approvals or recoverable blockers. See `crewcoder-agent/docs/DURABLE_GOALS.md`.

## Standalone VPS runner

Build a Linux x64 executable that does not require Node.js on the VPS:

```sh
npm run build:standalone -w @onpoint-dev-tools/crewcoder-agent
crewcoder deploy user@vps --binary crewcoder-agent/dist-bin/crewcoder-linux-x64 --execute
ssh -N -L 8787:127.0.0.1:8787 user@vps
```

Standalone deployment is loopback-only and intended for SSH terminal, ACP-over-SSH, local-TUI-over-SSH, or tunneled fleet access. Fleet API authentication is mandatory and uses an automatically generated private bearer token.

Run the TUI on your PC while the agent and workspace stay on the VPS:

```sh
crewcoder-tui \
  --remote user@vps \
  --remote-cwd /srv/projects/my-project
```

See `crewcoder-tui/docs/REMOTE_AGENTS.md` for the remote TUI workflow. The fleet guide includes deployment, token-safe curl, SDK, WebSocket, Python, rotation, and troubleshooting examples at `crewcoder-agent/docs/FLEET_MODE.md`.

## CI integrations

The repository root is a GitHub composite action for `crewcoder run --ci`.
GitLab users can include `.gitlab/crewcoder.gitlab-ci.yml`, and local repositories
can install a managed review hook with:

```sh
crewcoder hook install --budget 25k
```

The agent package is currently private, so the GitHub action builds from its
tagged source checkout and GitLab requires a runner-provided CrewCoder binary.
See `crewcoder-agent/docs/CI_INTEGRATIONS.md`.

## Debugging

CREWCODER_TUI_SYSTEM_LOGS=1 npm run dev -w @onpoint-dev-tools/crewcoder-tui
CREWCODER_DUMP_MODEL_INPUT=1 npm run dev -w @onpoint-dev-tools/crewcoder-tui
