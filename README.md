<div align="center">

<img src="assets/crewcoder-logo.png" alt="CrewCoder" width="420" />

**Extensible, security-conscious coding-agent platform**

[![SDK checks](https://github.com/OnPoint-Dev-Tools/crewcoder/actions/workflows/sdk-check.yml/badge.svg)](https://github.com/OnPoint-Dev-Tools/crewcoder/actions/workflows/sdk-check.yml)
[![npm (sdk)](https://img.shields.io/npm/v/@onpoint-dev-tools/crewcoder-agent?label=agent)](https://www.npmjs.com/package/@onpoint-dev-tools/crewcoder-agent)
[![npm (sdk)](https://img.shields.io/npm/v/@onpoint-dev-tools/crewcoder-tui?label=tui)](https://www.npmjs.com/package/@onpoint-dev-tools/crewcoder-tui)
[![npm (sdk)](https://img.shields.io/npm/v/@onpoint-dev-tools/crewcoder-sdk?label=sdk)](https://www.npmjs.com/package/@onpoint-dev-tools/crewcoder-sdk)
[![npm (client)](https://img.shields.io/npm/v/@onpoint-dev-tools/crewcoder-client?label=client)](https://www.npmjs.com/package/@onpoint-dev-tools/crewcoder-client)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

</div>

# CrewCoder Monorepo

This directory is an npm-workspaces monorepo for the CrewCoder Packages. The root package owns shared tooling, workspace scripts, and a single lockfile, while each package keeps its runtime dependencies and build entrypoints. For more thorough Documentation go here [CrewCoder Docs](https://crewcode-docs.logixhub.icu/crewcoder-agent/overview/)

## CrewCoder

**CrewCoder is an extensible, security-conscious coding-agent platform designed for interactive development, multi-worker orchestration, durable sessions, detached goals, and remote execution. Can also be used for the CrewCode ecosystem.**

## Install CrewCoder

Requires Node.js 22 or newer. The `crewcoder` umbrella package includes both the CrewCoder agent and terminal UI.

### Try it with npx

```sh
npx crewcoder
```

`npx` downloads CrewCoder into npm's cache and launches the TUI without creating a persistent global installation.

### Install globally

```sh
npm install --global crewcoder
crewcoder
```

The global installation of Agent + TUI provides both command names:

```sh
crewcoder
cc
```

A command with no arguments opens the TUI. Arguments run the agent CLI:

```sh
crewcoder providers
crewcoder run "explain this repository"
```

The scoped packages remain available separately for development and custom packaging:

```sh
npm install --global @onpoint-dev-tools/crewcoder-agent
npm install --global @onpoint-dev-tools/crewcoder-tui
```

Installing only `@onpoint-dev-tools/crewcoder-agent` does not install the TUI. Most CLI users should install the `crewcoder` umbrella package. See the [installation guide](docs/INSTALLATION.md) for more details.

## Packages

| Package | npm name | Runs on | What it is | Install command |
|---|---|---|---|---|
| CrewCoder umbrella | `crewcoder` | Node.js 22+ terminal | Recommended CLI package containing both the agent and TUI. |
| [`crewcoder-agent`](https://github.com/OnPoint-Dev-Tools/crewcoder/tree/main/crewcoder-agent) | [`@onpoint-dev-tools/crewcoder-agent`](https://www.npmjs.com/package/@onpoint-dev-tools/crewcoder-agent) | Node.js 22+ / standalone binary | The agent harness: evented agent loop, providers, local tools, durable sessions, goals, crews, extensions, ACP and fleet servers, and the `crewcoder` / `cc` CLI. | `npm install --global @onpoint-dev-tools/crewcoder-agent` |
| [`crewcoder-tui`](https://github.com/OnPoint-Dev-Tools/crewcoder/tree/main/crewcoder-tui) | [`@onpoint-dev-tools/crewcoder-tui`](https://www.npmjs.com/package/@onpoint-dev-tools/crewcoder-tui) | Node.js 22+ terminal | Custom terminal UI (no Ink/React/blessed/curses) driven by the agent's JSON event stream, locally or over SSH. | `npm install --global @onpoint-dev-tools/crewcoder-tui` |
| [`crewcoder-sdk`](https://github.com/OnPoint-Dev-Tools/crewcoder/tree/main/crewcoder-sdk) | [`@onpoint-dev-tools/crewcoder-sdk`](https://www.npmjs.com/package/@onpoint-dev-tools/crewcoder-sdk) | Node.js 22+ host process | Supported TypeScript API for embedding CrewCoder in-process, plus an authenticated fleet client for remote runners. | `npm install --global @onpoint-dev-tools/crewcoder-sdk` |
| [`crewcoder-client`](https://github.com/OnPoint-Dev-Tools/crewcoder/tree/main/crewcoder-client) | [`@onpoint-dev-tools/crewcoder-client`](https://www.npmjs.com/package/@onpoint-dev-tools/crewcoder-client) | Browsers, Electron renderers, webviews | Browser-safe client for authenticated CrewCoder runners. Web-platform APIs only: no Node.js imports, no local files, no tool execution, no stored provider credentials. | `npm install --global @onpoint-dev-tools/crewcoder-client` |

Package READMEs:
[agent](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/README.md) ·
[tui](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-tui/README.md) ·
[sdk](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-sdk/README.md) ·
[client](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-client/README.md)

## The CrewCoder agent harness

`crewcoder-agent` is the harness every other package talks to. The TUI spawns it and reads its JSON events, the SDK embeds it in-process, and the client talks to it over the authenticated fleet HTTP/SSE API. Everything below lives in that package.

### Runtime core

- **Evented agent loop.** Every turn emits typed JSON events (assistant deltas, thinking deltas, tool calls, approvals, usage, errors) over stdout or SSE, so all frontends share one contract. See [TUI_BACKEND_CONTRACT.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/contributor/TUI_BACKEND_CONTRACT.md).
- **Durable sessions.** Sessions persist under the CrewCoder home and support resume, branch, prune, export, checkpoints and rewind, search, compaction, and `session why` provenance. See [SESSION_DURABILITY.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/SESSION_DURABILITY.md), [SESSION_CHECKPOINTS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/SESSION_CHECKPOINTS.md), [AUTO_COMPACTION.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/AUTO_COMPACTION.md).
- **State directory.** `/.crewcoder` (override with `CREWCODER_HOME`, falls back to `~/.crewcoder`) holds `config.json`, `fleet-token`, `sessions/`, `goals/`, `extensions/`, `workers/`, `cache/`, `logs/`.
- **Modes.** `general` (default coding), `plugin` (CrewCode app plugin architect), `extension` (CrewCoder extension architect). See [EXTENSION_MODE.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/EXTENSION_MODE.md).

### Providers

Built-in adapters cover Claude Code Agent SDK, Codex (official app-server threads with a guarded WebSocket/SSE fallback), OpenCode, Grok CLI over ACP stdio, OpenAI, Anthropic, OpenRouter, xAI, DeepSeek, and Mistral, using checked process, HTTP/SSE, WebSocket, continuation, fallback, and replay transport profiles. Thinking/reasoning streams are first-class and user-visible. Context windows resolve from provider metadata first, then a strict-match 24-hour OpenRouter catalog cache.
See [PROVIDERS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/PROVIDERS.md), [CODEX_TRANSPORT.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/CODEX_TRANSPORT.md), [CLAUDE_AGENT_SDK.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/CLAUDE_AGENT_SDK.md), [MODEL_CONTEXT_WINDOWS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/MODEL_CONTEXT_WINDOWS.md), [PARALLEL_TOOL_CALLS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/PARALLEL_TOOL_CALLS.md).

### Tools

Local tools include read/write/edit, transactional edits, grep, list-files, bash and background jobs, git primitives, LSP-backed code intelligence and symbol edits, docs lookup, memory (`remember`), worker delegation, and plugin/extension scaffolding and validation. Only tools marked parallel-safe run concurrently; sequential tools stay ordering barriers, and tool output is size-limited and redacted.
See [CODE_INTELLIGENCE_TOOLS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/CODE_INTELLIGENCE_TOOLS.md), [GIT_PRIMITIVE_TOOLS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/GIT_PRIMITIVE_TOOLS.md), [TRANSACTIONAL_EDITS_AND_BACKGROUND_JOBS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/TRANSACTIONAL_EDITS_AND_BACKGROUND_JOBS.md), [TOOL_OUTPUT_SAFETY.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/TOOL_OUTPUT_SAFETY.md).

### Orchestration

- **Worker crews and teams** — named workers with their own identity files, sequential crew runs, declarative teams in `crewcoder.json`, and session handoffs. See [WORKER_CREWS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/WORKER_CREWS.md).
- **Crew tasks** — durable project-wide task IDs with dependency edges, surfaced in the TUI sidebar. See [CREW_TASKS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/CREW_TASKS.md).
- **Detached durable goals** — a CrewCoder-owned supervisor with maker/verifier separation, not a provider feature. See [DURABLE_GOALS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/DURABLE_GOALS.md).

### Security and trust

Approval modes (`never`, `review`, `always`, `full-access`, `sandboxed`), sandbox and trust tiers, runtime guardrails, explicit external-directory grants, repository rules, audit logging and redaction, and a mandatory bearer token for the fleet API.
See [SANDBOX_AND_TRUST.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/SANDBOX_AND_TRUST.md), [RUNTIME_GUARDRAILS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/RUNTIME_GUARDRAILS.md), [INTERACTIVE_APPROVAL_CONTROL.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/INTERACTIVE_APPROVAL_CONTROL.md), [AUDIT_AND_REDACTION.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/AUDIT_AND_REDACTION.md), [EXTERNAL_DIRECTORIES.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/EXTERNAL_DIRECTORIES.md).

### Extensibility

Capability-based CrewCoder extensions declare contribution points in `crewcoder.extension.json` — providers, tools, skills, prompt packs, commands, workflows, context providers, validators, approval policies, hooks, and sandboxed Live UI — all gated by config, trust tier, and capability checks. Separately, CrewCoder can generate CrewCode app plugins (`crewcode.plugin.json`).
See [EXTENSIONS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/EXTENSIONS.md), [EXTENSION_HOOKS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/EXTENSION_HOOKS.md), [EXTENSION_REGISTRY.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/EXTENSION_REGISTRY.md), [LIVE_UI_COMPONENTS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/LIVE_UI_COMPONENTS.md), [WORKFLOWS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/WORKFLOWS.md).

**STILL WORKING ON EXTENSION REGISTRY**

### Ways to connect

| Method | Best for | Transport | Authentication |
|---|---|---|---|
| Local CLI/TUI | Working on the current machine | Local subprocess | Local OS account |
| Remote agents | Local TUI, remote workspace | SSH stdio | SSH keys |
| ACP | Third-party ACP-compatible editors | ACP over stdio, often through SSH | Process boundary or SSH |
| Fleet mode | SDKs, apps, dashboards, automation, concurrent runs | HTTP + SSE/WebSocket | Fleet bearer token plus tunnel/HTTPS |
| In-process SDK | Embedding in a trusted Node.js host | Direct TypeScript calls | Host process boundary |

See [FLEET_MODE.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/FLEET_MODE.md), [ACP_ADAPTER.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/ACP_ADAPTER.md), [SDK.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/SDK.md), and [REMOTE_AGENTS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-tui/docs/REMOTE_AGENTS.md).

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

## TypeScript SDK and browser client

`@onpoint-dev-tools/crewcoder-sdk` `0.6.0` is the supported Node.js 22+ API for custom interfaces, automated workflows, custom tools, programmatic agent tests, and authenticated remote fleet clients. It supports typed events/errors, durable or in-memory sessions, approvals, follow-ups, cancellation, persistent fleet history, event cursors, reconnect, HTTP/SSE controls, and safe WebSocket connection metadata.

```ts
import { createCrewCoderSession } from "@onpoint-dev-tools/crewcoder-sdk";

const session = createCrewCoderSession({ cwd: process.cwd(), provider: "codex", approval: "review" });
session.subscribe((event) => {
  if (event.type === "assistant_delta") process.stdout.write(event.text);
});
await session.prompt("Explain the failing tests.");
session.dispose();
```

Browsers, Electron renderers, and webviews should use `@onpoint-dev-tools/crewcoder-client` instead, which talks to an authenticated runner over HTTP/SSE with web-platform APIs only:

```ts
import { CrewCoderClient } from "@onpoint-dev-tools/crewcoder-client";

const client = new CrewCoderClient({ baseUrl: "https://runner.example.com", token });
const run = await client.createRun({ prompt: "Fix the failing tests", cwd: "/workspace/project" });
await client.streamEvents(run.runId, (event) => { /* render */ });
```

See [SDK.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/SDK.md) for SDK examples, [FLEET_MODE.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/FLEET_MODE.md) for the VPS workflow, and [SDK_RELEASE.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/contributor/SDK_RELEASE.md) for compatibility and release gates.

## Detached durable goals

```sh
crewcoder goal start "Complete the migration and stop when contract tests pass" --provider codex
crewcoder goal status
crewcoder goal approve
```

The TUI exposes the same workflow through `/goal`. Goals survive closing the TUI and pause safely for approvals or recoverable blockers. See [DURABLE_GOALS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/DURABLE_GOALS.md).

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

See [REMOTE_AGENTS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-tui/docs/REMOTE_AGENTS.md) for the remote TUI workflow. The fleet guide includes deployment, token-safe curl, SDK, WebSocket, Python, rotation, and troubleshooting examples at [FLEET_MODE.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/FLEET_MODE.md).

## CI integrations

The repository root is a GitHub composite action for `crewcoder run --ci`.
GitLab users can include `.gitlab/crewcoder.gitlab-ci.yml`, and local repositories
can install a managed review hook with:

```sh
crewcoder hook install --budget 25k
```

By default the GitHub action builds the agent from its tagged source checkout;
pass a preinstalled executable to skip the build. GitLab requires a
runner-provided CrewCoder binary.
See [CI_INTEGRATIONS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/crewcoder-agent/docs/CI_INTEGRATIONS.md).

## Debugging

```sh
CREWCODER_TUI_SYSTEM_LOGS=1 npm run dev -w @onpoint-dev-tools/crewcoder-tui
CREWCODER_DUMP_MODEL_INPUT=1 npm run dev -w @onpoint-dev-tools/crewcoder-tui
```

## Inspired By

- Pi
- Hermes

## Documentation

- Agent docs: [`crewcoder-agent/docs`](https://github.com/OnPoint-Dev-Tools/crewcoder/tree/main/crewcoder-agent/docs) — providers, tools, sessions, goals, crews, extensions, security, fleet, CI.
- Contributor docs: [`crewcoder-agent/docs/contributor`](https://github.com/OnPoint-Dev-Tools/crewcoder/tree/main/crewcoder-agent/docs/contributor) — provider transports, TUI backend contract, system prompt template, SDK release gates.
- TUI docs: [`crewcoder-tui/docs`](https://github.com/OnPoint-Dev-Tools/crewcoder/tree/main/crewcoder-tui/docs) — themes, settings, remote agents, task sidebar, approvals, image attachments.
- Roadmap: [ROADMAP.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/ROADMAP.md) · Development rules: [AGENTS.md](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/AGENTS.md)

## Links

- Repository: https://github.com/OnPoint-Dev-Tools/crewcoder
- Issues: https://github.com/OnPoint-Dev-Tools/crewcoder/issues
- License: [Apache-2.0](https://github.com/OnPoint-Dev-Tools/crewcoder/blob/main/LICENSE)
