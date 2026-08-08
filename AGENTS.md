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

## MonoRepo DIR

CODING AGENT

- /home/aura/my-cmd/CrewCoder-Mono/crewcoder/crewcoder-agent

TUI

- /home/aura/my-cmd/CrewCoder-Mono/crewcoder/crewcoder-tui

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
        ├── bridge/
        │   ├── crewcoder-process.ts
        │   └── event-parser.ts
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
        ├── state/
        │   ├── effort-levels.ts
        │   ├── event-reducer.ts
        │   ├── tui-store.ts
        │   └── usage.ts
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

- Provider thinking streams are user-visible behavior. Do not remove or simplify `onThinkingDelta`, `thinking_delta`, or TUI `thinking` blocks without replacing the behavior and tests.
- Codex/OpenAI reasoning summaries can arrive as live `response.reasoning_summary_text.delta`, final `response.reasoning_*_done`, response-level `output` reasoning items, or completed `response.output_item.done` reasoning items.
- OpenCode uses the Anthropic-compatible provider path and must request `stream: true` to surface thinking deltas.
- User-message `background` metadata is intentional. It carries repo/session context to the provider and should render in the TUI as background, not as typed user text.
- Durable `/goal` behavior belongs to CrewCoder's detached supervisor (`goal-store.ts` / `goal-runner.ts`), not provider adapters. When `goals.checkModel` is configured, its same-provider tool-free verifier verdict is authoritative; verifier failures must pause rather than fall back to maker self-grading. Goals wait durably for explicit approvals.
- Crew task sidebar labels are session-local presentation numbers that restart at `1` and remain stable across status sorting. Crew task tools and persisted dependency edges must continue using project-wide durable task IDs.
- CI transports (`action.yml`, the GitLab template, and `scripts/run-ci.sh`) must preserve `run --ci` stdout JSON and exit codes. `crewcoder hook install` may only update its managed marker block, must back up unrelated hooks before an explicit force replacement, and must refuse shared/global hook paths outside the repository.
- Validate provider stream changes with package-local checks using isolated env:
  `CREWCODER_HOME=/tmp/.crewcoder npm run typecheck -w @onpoint-dev-tools/crewcoder-agent`
  `env -u OPENCODE_API_KEY CREWCODER_HOME=/tmp/.crewcoder npm test -w @onpoint-dev-tools/crewcoder-agent`
