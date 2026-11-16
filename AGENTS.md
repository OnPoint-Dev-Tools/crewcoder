# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.
- Challenge me and push back and play devils advocate when i want to add implement something that has risks or for a new feature.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`crewcoder/*/src`, `crewcoder/*/test`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Follow Good React/Electron hook practices here [React Hooks](/crewcoder-agent/docs/REACT_HOOKS.md) — this is UI guidance only. For the CrewCoder extension hook contribution point (`beforeToolCall`/`afterToolCall`/`onError`/`compaction`), see [Extension Hooks](/crewcoder-agent/docs/EXTENSION_HOOKS.md).

## Project identity

In CrewCoder-tool Codex sessions, omit native `apply_patch` through a process-local
effective model catalog; edits must reach CrewCoder's supplied tools and executor.
Preserve all other model metadata, native mode and the read-only safety backstop.
See `crewcoder-agent/docs/TOOL_MODE.md` for verification, including native resume.

GOAL: We need to build crewcoder-agent, crewcoder-tui, in a way that we can easily create an sdk for the coding agent. My end goal is make CrewCoder self deployable with an sdk and cli so it can run agents in vps's and sandboxes.

I work on code along with you so there is going to be modified/untracked files unrelated to your changes. IGNORE IT, and continue your job.

This Monorepo package is **CrewCoder**, a standalone coding agent CLI.

**DISCLAIMER**:
crewcoder and crewcode are 2 different apps, CrewCoder harness has knowledge and plugin logic for crewcode, but everything else is for 'CrewCoder or crewcoder' dont get it confused, if you in doubt double check with me.

CrewCoder should become a best-in-class coding agent with:

```txt
- evented agent loop
- durable sessions
- built-in providers
- local coding tools
- CrewCoder extension architecture
- CrewCode app plugin generation
```

## Docs & AGENTS.md

Update corresponding Docs `crewcoder-agent/docs/*`, `crewcoder-tui/docs/*`, and `AGENTS.md` when major changes were made and or every time i add a feature. Create or update a docs .md file for it.

## CLI umbrella package

The public root `crewcoder` package is the one-command installer and launcher. Its `crewcoder` and `crew` bins open `@onpoint-dev-tools/crewcoder-opentui` with no arguments and forward argument-bearing invocations to `@onpoint-dev-tools/crewcoder-agent`. Never restore the `cc` alias because it shadows the standard Unix C compiler command. The agent is a required dependency; `crewcoder-opentui` is an **optionalDependency** because it needs Node.js >=26.4 and OpenTUI native binaries, and headless VPS/sandbox installs must succeed without it. Do not make it required. For a bare call, `lib/launcher.js` refuses with guidance (legacy UI and agent commands) when there is no interactive terminal, the TUI is not installed, or Node.js is below the TUI's `engines.node` floor; it adds `--disable-warning=ExperimentalWarning` only for the TUI child. Publish the umbrella only after the exact pinned versions exist on npm.

`@onpoint-dev-tools/crewcoder-tui` is the legacy custom-renderer UI. It is published separately for users who prefer it and must not be an umbrella dependency. Both UIs share `@onpoint-dev-tools/crewcoder-tui-core` (bridge, event parser, reducer, state); keep UI-independent code there instead of duplicating it. See `crewcoder-opentui/README.md` for the OpenTUI preview's ported and missing features.

The scoped agent package still provides `crewcoder`, `crew`, and `crewcoder-agent`; its own bare invocation launches the legacy `crewcoder-tui` from `PATH`. The scoped TUI packages provide `crewcoder-tui` and `crewcoder-opentui` for independent installs.

## MonoRepo DIR

CODING AGENT

- /home/aura/my-cmd/CrewCoder-Mono/crewcoder/crewcoder-agent

TUI (OpenTUI, launched by the umbrella; Node.js >=26.4)

- /home/aura/my-cmd/CrewCoder-Mono/crewcoder/crewcoder-opentui

Legacy TUI

- /home/aura/my-cmd/CrewCoder-Mono/crewcoder/crewcoder-tui

Shared TUI runtime (bridge, reducer, state)

- /home/aura/my-cmd/CrewCoder-Mono/crewcoder/crewcoder-tui-core

SDK

- /home/aura/my-cmd/CrewCoder-Mono/crewcoder/crewcoder-sdk

Browser Client

- /home/aura/my-cmd/CrewCoder-Mono/crewcoder/crewcoder-client

## Project structure

```txt
crewcoder/
├── .crewcode/              # CrewCode workspace metadata
├── .git/                   # Version control
├── .gitignore
├── .vscode/
├── AGENTS.md
├── README.md
├── developer.md
├── package.json
├── package-lock.json
├── tsconfig.base.json
├── tsconfig.json
├── node_modules/           # Monorepo dependencies
├── crewcoder-agent/
│   ├── AGENTS.md
│   ├── README.md
│   ├── package.json
│   ├── tsconfig.json
│   ├── .npmrc
│   ├── scripts/
│   │   └── ensure-bin-executable.cjs
│   ├── docs/
│   │   └── contributor/
│   │       ├── ROADMAP.md
│   │       └── TUI_BACKEND_CONTRACT.md
│   └── src/
│       ├── cli.ts
│       ├── core/
│       │   ├── agent.ts
│       │   ├── agent-loop.ts
│       │   ├── agent-loop-continue.ts
│       │   ├── approval.ts
│       │   ├── backend-debug-logger.ts
│       │   ├── browser-opener.ts
│       │   ├── config.ts
│       │   ├── crewcode-repo.ts
│       │   ├── crewcoder-home.ts
│       │   ├── events.ts
│       │   ├── json-event-stream.ts
│       │   ├── messages.ts
│       │   ├── model-client.ts
│       │   ├── mode-router.ts
│       │   ├── repo-inspector.ts
│       │   ├── session-branch.ts
│       │   ├── session-compaction.ts
│       │   ├── session-loader.ts
│       │   ├── session-store.ts
│       │   ├── system-prompt.ts
│       │   ├── tool-schema.ts
│       │   ├── tool-types.ts
│       │   ├── types.ts
│       │   └── usage.ts
│       ├── extensions/
│       │   ├── extension-loader.ts
│       │   ├── extension-registry.ts
│       │   └── types.ts
│       ├── generators/
│       │   ├── extension-generator.ts
│       │   ├── plugin-generator.ts
│       │   └── template-registry.ts
│       ├── knowledge/
│       │   ├── constraints.ts
│       │   └── crewcode-docs.ts
│       ├── modes/
│       │   ├── general-coding-mode.ts
│       │   ├── plugin-architect-mode.ts
│       │   └── index.ts
│       ├── plugins/
│       │   └── crewcoder-provider/
│       │       └── crewcode.plugin.json
│       ├── providers/
│       │   ├── auth-store.ts
│       │   ├── builtins.ts
│       │   ├── codex-provider.ts
│       │   ├── http-provider.ts
│       │   ├── model-registry.ts
│       │   ├── model-resolution.ts
│       │   ├── oauth-codex.ts
│       │   ├── openai-responses-provider.ts
│       │   ├── output-parser.ts
│       │   ├── process-provider.ts
│       │   ├── provider-model-client.ts
│       │   ├── provider-registry.ts
│       │   ├── types.ts
│       │   └── websocket-provider.ts
│       ├── skills/
│       │   ├── crewcode/
│       │   │   └── index.ts
│       │   ├── general/
│       │   │   └── index.ts
│       │   └── types.ts
│       ├── tests/
│       │   ├── agent-loop.test.ts
│       │   ├── auth-store.test.ts
│       │   ├── browser-opener.test.ts
│       │   ├── codex-provider.test.ts
│       │   ├── crewcoder-home.test.ts
│       │   ├── extension-loader.test.ts
│       │   ├── http-provider.test.ts
│       │   ├── mode-router.test.ts
│       │   ├── openai-responses-provider.test.ts
│       │   ├── output-parser.test.ts
│       │   ├── process-provider.test.ts
│       │   ├── provider-registry.test.ts
│       │   ├── template-registry.test.ts
│       │   ├── usage.test.ts
│       │   ├── validate-plugin.test.ts
│       │   └── websocket-provider.test.ts
│       └── tools/
│           ├── bash.ts
│           ├── create-extension-tool.ts
│           ├── create-plugin-tool.ts
│           ├── edit.ts
│           ├── grep.ts
│           ├── index.ts
│           ├── list-files.ts
│           ├── list-templates-tool.ts
│           ├── path-utils.ts
│           ├── read.ts
│           ├── validate-plugin-tool.ts
│           ├── validate-plugin.ts
│           └── write.ts
└── crewcoder-tui/
    ├── AGENTS.md
    ├── README.md
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── cli.ts
        ├── bridge/            # live-ui-*.ts; agent bridge lives in crewcoder-tui-core
        ├── components/
        │   ├── App.ts
        │   ├── CommandPalette.ts
        │   ├── Composer.ts
        │   ├── EffortOverlay.ts
        │   ├── Header.ts
        │   ├── MainViewport.ts
        │   ├── PickerOverlay.ts
        │   ├── SessionsOverlay.ts
        │   ├── Spinner.ts
        │   ├── StatusBar.ts
        │   ├── logo-banner.ts
        │   ├── markdown-renderer.ts
        │   ├── modal-view.ts
        │   └── path-suggestions.ts
        ├── tests/
        │   ├── app-home.test.ts
        │   ├── app-input.test.ts
        │   ├── composer.test.ts
        │   ├── event-reducer.test.ts
        │   ├── input.test.ts
        │   ├── logo-banner.test.ts
        │   ├── main-viewport.test.ts
        │   ├── picker-overlay.test.ts
        │   ├── provider-defaults.test.ts
        │   └── spinner.test.ts
        ├── theme/
        │   ├── logo.ts
        │   └── theme.ts
        └── tui/
            ├── ansi.ts
            ├── clipboard.ts
            ├── component.ts
            ├── input.ts
            ├── layout.ts
            ├── overlay.ts
            ├── renderer.ts
            └── tui.ts
```

## Current hard-won notes

- Tool mode defaults to `native`: standalone Codex/Claude execution plus CrewCoder specialized and trusted extension tools. API-only providers and custom clients without a declared provider use the full CrewCoder toolset. Preserve saved preference across API fallback/resume. Virtual filesystems, replacement tool registries, explicit host custody and specialized agent modes force CrewCoder tools; additive host tools alone do not. Detached goals retain CrewCoder execution for durable approvals. `crewcoder tool-mode [native|crewcoder|status]` reads/writes the same `config.json` field as `/tool-mode` and `config set toolMode`; preserve saved session preferences. Never apply the standalone preference around host approvals. See `crewcoder-agent/docs/TOOL_MODE.md`.

- ACP hosts advertise `_meta["crewcoder/questions"].version: 1` to receive `_crewcoder/request_question` with original option values, free-text/Other, secret flags, and exact provider permission details. Questions must never become automatic permission approvals. Cancel pending cards on session/provider cancellation. Explicit Never remains non-interactive; use Review when escalation should ask. See `crewcoder-agent/docs/ACP_ADAPTER.md`.

- Reuse provider-specific computer-use integrations where available; the universal computer-use layer is deferred. Claude's built-in CLI computer use is documented as macOS-only and interactive-only, so CrewCoder's non-interactive Agent SDK transport cannot currently reuse it. Claude Desktop Windows support does not establish SDK support; never relax strict MCP isolation as a workaround. See `crewcoder-agent/docs/CODEX_CLI_PROVIDER.md`.

- Codex Full access uses `on-request` with `danger-full-access` so MCP computer-use consent can surface, while command/file approval stays automatic. Reply to MCP elicitations with explicit action/content and cancel without an interactive host; never silently ignore a server request. Keep Never/Sandboxed and hosted-tools-only lockdown intact. See `crewcoder-agent/docs/CODEX_CLI_PROVIDER.md`.

- Worker identity is off by default and opt-in through `workerIdentityEnabled` and `identity on|off|status`. Preserve `activeWorker` selection while disabled; keep default/custom/host system prompts and propagate identity suppression to delegated runs. Host opt-in must never override the user's opt-out.
- `codex-cli` is the sole registered Codex provider and fresh-install default; do not restore the managed `codex` provider or its bundled dependency/login flow. Claude model discovery and execution must share the executable resolver: explicit override, installed Claude Code on PATH, then the SDK bundle. An older SDK bundle must not hide models exposed by the user's installed CLI.
- Provider thinking streams are user-visible behavior. Do not remove or simplify `onThinkingDelta`, `thinking_delta`, or TUI `thinking` blocks without replacing the behavior and tests.
- Codex/OpenAI reasoning summaries can arrive as live `response.reasoning_summary_text.delta`, final `response.reasoning_*_done`, response-level `output` reasoning items, or completed `response.output_item.done` reasoning items.
- OpenCode uses the Anthropic-compatible provider path and must request `stream: true` to surface thinking deltas.
- User-message `background` metadata is intentional. It carries repo/session context to the provider and should render in the TUI as background, not as typed user text.
- Durable `/goal` behavior belongs to CrewCoder's detached supervisor (`goal-store.ts` / `goal-runner.ts`), not provider adapters. When `goals.checkModel` is configured, its same-provider tool-free verifier verdict is authoritative; verifier failures must pause rather than fall back to maker self-grading. Goals wait durably for explicit approvals.
- Crew task sidebar labels are session-local presentation numbers that restart at `1` and remain stable across status sorting. Crew task tools and persisted dependency edges must continue using project-wide durable task IDs.
- CI transports (`action.yml`, the GitLab template, and `scripts/run-ci.sh`) must preserve `run --ci` stdout JSON and exit codes. `crewcoder hook install` may only update its managed marker block, must back up unrelated hooks before an explicit force replacement, and must refuse shared/global hook paths outside the repository.
- Coordinated releases use `npm run release -- <major.minor.patch>` to bump the umbrella, agent, browser client, and SDK together while preserving the independent `crewcoder-tui`, `crewcoder-tui-core`, and `crewcoder-opentui` versions (publish order: agent, tui-core, both TUIs, client, SDK, umbrella). Keep `scripts/release.cjs` synchronized with those manifests, exact internal dependency pins, runtime version constants, generated version API baselines, the root lockfile, and the protected npm publishing workflow. Automatic API baseline refreshes may only change the client and SDK `api/version.d.ts` files.
- Validate provider stream changes with package-local checks using isolated env:
  `CREWCODER_HOME=/tmp/.crewcoder npm run typecheck -w @onpoint-dev-tools/crewcoder-agent`
  `env -u OPENCODE_API_KEY CREWCODER_HOME=/tmp/.crewcoder npm test -w @onpoint-dev-tools/crewcoder-agent`
