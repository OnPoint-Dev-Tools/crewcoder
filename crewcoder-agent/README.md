# CrewCoder

**CrewCoder is an extensible, security-conscious coding-agent platform designed for interactive development, multi-worker orchestration, durable sessions, and remote execution. Can also be used for the CrewCode ecosystem.**

## State directory

CrewCoder owns its own state directory:

```txt
/.crewcoder
```

Override it with:

```bash
export CREWCODER_HOME="/custom/path"
```

If `/.crewcoder` cannot be created, CrewCoder falls back to `~/.crewcoder`.

Layout:

```txt
/.crewcoder/
  config.json
  fleet-token
  sessions/
  goals/
  extensions/
  cache/
  logs/
```

## Default worker

On first use, CrewCoder creates the global `Crew` worker under `~/.crewcoder/workers/Crew/` (or the configured CrewCoder home). Its starter metadata identifies the owner as `CrewCoder User` (`@CrewCoderUser`), and its `IDENTITY.md` provides a practical general-purpose coding-partner role and working style. Both files are user-editable; existing workers are not overwritten.

## Three separate systems

```txt
1. Built-in providers: codex, claude, opencode
2. CrewCoder extensions: /.crewcoder/extensions, crewcoder.extension.json
3. CrewCode app plugins: crewcode.plugin.json, generated from /CrewCode/examples/plugins when available
```

## Modes

Modes are explicit; legacy persisted `auto` values are read as `general` but cannot be selected for new runs.

```txt
general      # default coding mode
plugin       # CrewCode app plugin architect (crewcode.plugin.json)
extension    # CrewCoder extension architect (crewcoder.extension.json)
```

See `docs/EXTENSION_MODE.md`.

## Terminal UI

Launch the interactive terminal UI from any workspace with no arguments. `cc` is an equivalent short alias:

```bash
crewcoder
cc
```

The TUI package must also be installed or linked so `crewcoder-tui` is available on `PATH`. Agent commands remain explicit:

```bash
crewcoder run "fix this bug"
crewcoder providers
```

## Providers

```bash
crewcoder providers
crewcoder run --provider opencode "fix this bug"
crewcoder run --provider claude "refactor this module"
crewcoder run --provider codex "write tests for this CLI"
crewcoder run --provider claude --model claude-sonnet-5 "review this change"    # local Claude Code login
crewcoder run --provider anthropic --model claude-sonnet-5 "review this change" # direct API key
crewcoder run --provider openrouter --model openai/gpt-5.4 "fix this bug"
crewcoder config set defaultProvider opencode
```

CrewCoder resolves model context windows from provider metadata first, then from a strict-match, 24-hour disk cache of OpenRouter's public model catalog. Unknown or offline models remain token-only. See `docs/MODEL_CONTEXT_WINDOWS.md`.

The built-in Codex provider uses official app-server threads persisted under CrewCoder's home, so resumed turns send only new input across process and machine restarts. The direct WebSocket/SSE transport remains a guarded fallback. See `docs/CODEX_TRANSPORT.md`.

Provider adapters use checked process, HTTP/SSE, WebSocket, continuation, fallback, and replay profiles. Built-ins include Claude Code Agent SDK, Grok CLI (ACP stdio), OpenAI, Anthropic, OpenRouter, xAI, DeepSeek, Mistral, Codex, and OpenCode; extensions may select vetted generic transports without receiving CrewCoder-owned OAuth credentials. Models/providers can advertise parallel tool-call support, while only tools explicitly marked parallel-safe execute concurrently; sequential tools remain ordering barriers. See `docs/PROVIDERS.md`, `docs/PARALLEL_TOOL_CALLS.md`, `docs/contributor/PROVIDER_TRANSPORTS.md`, and `docs/ACP_CLIENT_PROVIDER.md`.

## Durable goals

CrewCoder owns a detached, provider-independent goal supervisor. Codex is the model provider; `/goal` is not forwarded to the Codex Responses endpoint.

```bash
crewcoder goal start "Complete the migration and stop when contract tests pass" --provider codex --approval review
crewcoder goal status
crewcoder goal approve
crewcoder goal pause
crewcoder goal resume
crewcoder goal clear
```

Goals survive closing the terminal and continue across ordinary final model turns. Configure maker–verifier separation and limits with `crewcoder config set goals.checkModel <model>`, `goals.maxTurns`, and `goals.timeoutMinutes`. The checker uses the same provider as the maker but a separate tool-free model call, and its verdict is authoritative. Approval-required tools persist an `awaiting_approval` state until `goal approve` or `goal deny`. See `docs/DURABLE_GOALS.md`.

## Worker crews

```bash
crewcoder workers create reviewer --description "Reviews implementation quality"
crewcoder workers create builder --description "Builds focused changes"
crewcoder crew run --workers reviewer,builder "Implement feature X"
crewcoder crew handoff worker:reviewer <session-id> "Review the implementation"
```

See `docs/WORKER_CREWS.md`.

## CrewCoder extensions

CrewCoder extensions are capability-based packages, not categories. Initialize one package, then declare any combination of contribution points in `crewcoder.extension.json`.

```bash
crewcoder extension init my-extension
crewcoder extension list
crewcoder extension inspect my-extension
crewcoder extension validate /.crewcoder/extensions/my-extension
```

Extensions live under:

```txt
/.crewcoder/extensions
```

Core contract:

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "0.1.0",
  "crewcoder": { "apiVersion": "0.1" },
  "activation": { "events": [], "keywords": [], "modes": [], "commands": [], "filePatterns": [] },
  "contributes": {
    "providers": [],
    "tools": [],
    "skills": [],
    "promptPacks": [],
    "commands": [],
    "workflows": [],
    "contextProviders": [],
    "validators": [],
    "approvalPolicies": [],
    "hooks": [],
    "ui": []
  }
}
```

Active runtime contributions include providers, skills, prompt packs, prompt commands, workflows, hooks (including compaction and error hooks), approval policies, file triggers, trusted tools, declarative UI, and experimental sandboxed Live UI. Executable contributions remain gated by config, trust tier, and capability checks.

Install and discover packages with `extension search|install|update|uninstall`; inspect hooks and Live UI gates with `extension hooks` and `extension live-ui`. See `docs/EXTENSIONS.md`, `docs/EXTENSION_INSTALL.md`, `docs/EXTENSION_REGISTRY.md`, `docs/EXTENSION_HOOKS.md`, `docs/WORKFLOWS.md`, and `docs/LIVE_UI_COMPONENTS.md`.

## CrewCode app plugins

```bash
crewcoder plugin list-templates
crewcoder plugin create my-panel --kind static-panel
crewcoder plugin create local-llm --kind openai-agent
crewcoder plugin create linear-tools --kind mcp
crewcoder plugin validate ./my-panel
```

CrewCoder prefers real templates from:

```txt
/CrewCode/examples/plugins
```

## TypeScript SDK

`@onpoint-dev-tools/crewcoder-sdk` `0.6.0` is the supported Node.js 22+ API for embedding CrewCoder and controlling authenticated fleet runners. It provides typed events/errors, durable or in-memory sessions, custom tools and model clients, approvals, follow-ups, extension UI responses, cancellation, persistent fleet history, event cursors, and reconnect.

```ts
import { createCrewCoderSession } from "@onpoint-dev-tools/crewcoder-sdk";

const session = createCrewCoderSession({ cwd: process.cwd(), approval: "review" });
session.subscribe((event) => {
  if (event.type === "assistant_delta") process.stdout.write(event.text);
});
await session.prompt("Explain the failing tests.");
session.dispose();
```

It includes an authenticated `CrewCoderFleetClient` for remote runners; a subprocess RPC client is not part of its contract. See `docs/SDK.md` for in-process and fleet client examples and `docs/contributor/SDK_RELEASE.md` for compatibility and release gates.

## Practical connection choices

CrewCoder supports different connection methods because terminal users, editors, SDK hosts, and automation systems have different lifecycle and interoperability requirements.

| Method | Best for | Transport | Remote lifecycle | Authentication |
|---|---|---|---|---|
| Local CLI/TUI | Working directly on the current machine | Local subprocess | One attached run/session | Local OS account |
| Remote Agents | CrewCoder TUI on your PC controlling another PC/VPS | SSH stdio | One attached CLI process per active TUI operation | SSH keys/user authentication |
| ACP | Third-party ACP-compatible editors | ACP over subprocess stdio, commonly through SSH | One editor-oriented agent connection | Process boundary or SSH |
| Fleet mode | SDKs, custom apps, dashboards, automation, and concurrent runs | HTTP + SSE/WebSocket | Persistent server managing multiple run records | Fleet bearer token plus SSH tunnel/private encryption/HTTPS |
| In-process SDK | Embedding CrewCoder inside a trusted Node.js host | Direct TypeScript calls | Host-owned `CrewCoderSession` objects | Host process boundary |

### Local CLI or TUI

Use CrewCoder directly where the workspace lives:

```bash
crewcoder
crewcoder run "fix the failing tests"
```

### Remote Agents: local TUI, remote workspace

Run the TUI on your PC while every CrewCoder CLI operation and tool executes on the remote machine:

```bash
crewcoder-tui \
  --remote user@vps \
  --remote-cwd /srv/projects/my-project
```

```txt
local CrewCoder TUI -> SSH -> remote CrewCoder CLI -> remote workspace
```

Use this for the fullest CrewCoder TUI experience against a personal VPS or another SSH-accessible POSIX machine. It uses SSH directly and does not require fleet HTTP or a fleet token. See `../crewcoder-tui/docs/REMOTE_AGENTS.md`.

### ACP: compatible editor integration

An ACP-capable editor can start CrewCoder as its standardized coding-agent backend:

```bash
ssh -T user@vps \
  'cd /srv/projects/my-project && ~/crewcoder-runner/crewcoder acp --approval review'
```

```txt
ACP editor -> ACP over SSH stdio -> CrewCoder ACP adapter -> remote agent
```

Use ACP when editor interoperability matters. ACP is a standardized editor-facing protocol; it is not CrewCoder's persistent multi-run service. See `docs/ACP_ADAPTER.md`.

### Fleet mode: applications and orchestration

Fleet mode keeps a CrewCoder server running and lets authenticated clients create runs, inspect status, replay events, stream live output, and send controls:

```txt
custom app / SDK -> HTTP + SSE/WebSocket -> CrewCoder fleet server -> remote workspace
```

Use fleet mode for custom applications, dashboards, automation, and multiple concurrent run records. Unlike ACP, clients do not launch one editor subprocess per connection. Unlike Remote Agents mode, fleet clients use CrewCoder's HTTP API rather than the full CLI contract.

In short:

- Use **Remote Agents** for the CrewCoder TUI from your PC.
- Use **ACP** for an ACP-compatible editor.
- Use **Fleet mode** for custom applications, SDK clients, and orchestration.
- Use the **in-process SDK** when CrewCoder runs inside your own trusted Node.js application.

## Fleet mode / remote runners

```bash
crewcoder serve --host 127.0.0.1 --port 8787
crewcoder deploy user@host
```

Build and deploy a standalone Linux x64 executable when the VPS has no Node.js/npm:

```bash
npm run build:standalone -w @onpoint-dev-tools/crewcoder-agent
crewcoder deploy user@host \
  --binary crewcoder-agent/dist-bin/crewcoder-linux-x64 \
  --execute
ssh -N -L 8787:127.0.0.1:8787 user@host
```

The standalone runner is intentionally bound to loopback and accessed through SSH. Fleet bearer authentication is mandatory; retrieve the generated token from the private deployment state directory. When using `crewcoder fleet token` remotely, set the same deployment `CREWCODER_HOME`. The binary embeds the agent CLI, not the separate TUI package.

See `docs/FLEET_MODE.md` for complete local and VPS workflows, local-TUI-over-SSH, token-safe curl requests, every control action, TypeScript and Python clients, WebSockets, token rotation, and troubleshooting. The dedicated TUI setup is in `../crewcoder-tui/docs/REMOTE_AGENTS.md`.

## CI runs

Use `--ci` for a headless run with automatic verification, one JSON summary on
stdout, progress on stderr, and structured exit codes:

```bash
crewcoder run --ci --budget 100k --approval never \
  "Implement the requested change and verify the repository"
```

Exit codes are `0` success, `1` other run failure, `2` verification failure,
`3` token budget exceeded, and `4` approval denied. See `docs/CI_RUNS.md` for the
versioned JSON schema and approval behavior.

First-party wrappers are included for GitHub Actions, GitLab CI, and local
pre-commit review:

```bash
crewcoder hook install --budget 25k
```

See `docs/CI_INTEGRATIONS.md`.

## Repository rules

CrewCoder automatically loads bounded, repository-owned Markdown rules from `.crewcoder/rules/**/*.md` when a new session starts. Optional `paths` frontmatter activates language- or file-specific guidance. Rules are initial background context, not executable hooks; use `/new` after editing them in the TUI. See `docs/REPOSITORY_RULES.md` and `docs/INSTRUCTION_LAYERS.md`.

## Shipped feature guides

- Repository instruction layers and path-aware rules: `docs/INSTRUCTION_LAYERS.md`, `docs/REPOSITORY_RULES.md`
- Durable sessions, exact model-turn replay, and search: `docs/SESSION_STORAGE.md`, `docs/REPRODUCIBLE_RUNS_AND_SEARCH.md`
- Checkpoints, rewind, compaction, export, and `/why`: `docs/SESSION_CHECKPOINTS.md`, `docs/AUTO_COMPACTION.md`, `docs/SESSION_EXPORT.md`, `docs/WHY_COMMAND.md`
- Token budgets, stall detection, verification, and CI: `docs/RUNTIME_GUARDRAILS.md`, `docs/CI_RUNS.md`, `docs/CI_INTEGRATIONS.md`
- Cost ledger and model comparison: `docs/COST_LEDGER.md`, `docs/contributor/MODEL_DIFF.md`
- Sandbox, approvals, audit/redaction, and external directories: `docs/SANDBOX_AND_TRUST.md`, `docs/INTERACTIVE_APPROVAL_CONTROL.md`, `docs/AUDIT_AND_REDACTION.md`, `docs/EXTERNAL_DIRECTORIES.md`
- Local coding tools, background jobs, transactional edits, Git primitives, and code intelligence: `docs/TOOL_OUTPUT_SAFETY.md`, `docs/TRANSACTIONAL_EDITS_AND_BACKGROUND_JOBS.md`, `docs/GIT_PRIMITIVE_TOOLS.md`, `docs/CODE_INTELLIGENCE_TOOLS.md`

## Agent loop

```txt
prompt -> explicit mode -> skills -> docs -> system prompt -> provider -> tool calls -> tools -> tool results -> next turn/final -> session saved
```

Sessions are saved under:

```txt
/.crewcoder/sessions
```

## Debugging model input

To inspect exactly what CrewCoder injects into the model, enable model input dumps:

```bash
crewcoder run --dump-model-input --provider opencode "test prompt"
CREWCODER_DUMP_MODEL_INPUT=1 crewcoder run "test prompt"
crewcoder session resume <session-id> --dump-model-input "continue"
```

Each model turn writes a JSON file under:

```txt
/.crewcoder/logs/model-input-<session-id>-turn-<n>.json
```

The dump includes provider/model metadata plus the exact `ModelInput`: system prompt, rendered messages with background context, available tool schemas, and session context.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev -- doctor
npm run dev -- providers
npm run dev -- run --heuristic --mode plugin "create a CrewCode plugin named repo-radar-test"
npm run dev -- run --heuristic --mode extension "create a CrewCoder extension"
```

TUI entry command:

```bash
crewcoder run --json-events --provider opencode --mode general "fix this bug"
```

Resume command:

```bash
crewcoder session resume <session-id> --json-events "continue"
```

Approval-gated run:

```bash
crewcoder run --approval review --json-events "update the files needed for this feature"
```

Explicit full-access run (bypasses approval prompts and dangerous-command blocking):

```bash
crewcoder run --approval full-access --json-events "run the requested maintenance task"
```

## Install note

This package intentionally does not include a committed `package-lock.json`.

If `npm install` hangs, remove any old generated lockfile and reinstall from the public npm registry:

```bash
rm -rf node_modules package-lock.json
npm install --registry=https://registry.npmjs.org/ --no-audit --no-fund
```
