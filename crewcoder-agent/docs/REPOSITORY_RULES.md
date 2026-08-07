# Repository Rules (`.crewcoder/rules`)

CrewCoder supports repository-owned, path-aware instruction files under:

```txt
<repo-root>/.crewcoder/rules/**/*.md
```

This layer is useful for conventions that are broader than one file but more specific than a single `AGENTS.md`, especially language-specific style, testing, security, and architecture guidance.

## Basic rules

A Markdown file without frontmatter always applies:

```md
# Development workflow

Read the real error before editing code.
Run the repository's targeted checks after behavior changes.
```

Store it as:

```txt
.crewcoder/rules/common/development-workflow.md
```

## Path-scoped rules

Add YAML-style `paths` frontmatter to activate a rule only when the repository contains a matching file:

```md
---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/package.json"
---
# TypeScript rules

Use `unknown` for untrusted input and narrow it safely.
Run the package-local typecheck after changing exported APIs.
```

Supported path syntax:

```txt
*    any characters except `/`
**   any directories/characters
?    one non-`/` character
```

`**/*.ts` matches both `index.ts` and `src/index.ts`. Absolute patterns and patterns containing `..` are ignored.

## Activation model

CrewCoder scans a bounded repository file inventory when a new agent session starts:

```txt
rule has no paths        -> active
rule has paths           -> active when any repository file matches any path
no active rule files     -> no rules context injected
```

Rules are loaded from the detected Git repository root, falling back to the requested cwd. Starting CrewCoder in a subdirectory therefore still finds root-level rules.

Active rules are added to the initial user message's `background` context. Durable session continuation carries that original context; rules are not silently re-read midway through an existing session.

## Ordering and precedence

Rules load deterministically:

1. always-on rules, sorted by relative filename;
2. path-scoped rules, sorted by relative filename.

Path-scoped rules are more specific and override general rules when they conflict. Direct system and user instructions remain higher priority.

Use numeric filename prefixes when ordering among rules of the same specificity matters:

```txt
.crewcoder/rules/common/10-development.md
.crewcoder/rules/common/20-security.md
```

## Safety and limits

The loader is deliberately bounded:

| Boundary | Limit |
| --- | ---: |
| Rule files considered | 100 |
| One rule file | 12,000 bytes |
| Repository files scanned for path matching | 5,000 |
| Injected rules context | 24,000 characters |

Symlinks are ignored. Workspace scanning skips generated/sensitive-heavy directories including `.git`, `.crewcoder`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.turbo`, `target`, and `vendor`.

A rule file named `hooks.md` is still only instruction text. It does **not** execute formatters, linters, shell commands, or hooks. Use CrewCoder extension hooks and validators for reviewed executable automation; see `EXTENSION_HOOKS.md` and `RUNTIME_GUARDRAILS.md`.

## Relationship to other instruction layers

| Layer | Best use |
| --- | --- |
| `AGENTS.md` | Repository architecture and project law that should be visible to every contributor/tool |
| `.crewcoder/rules` | Modular, path-aware repository conventions |
| `IDENTITY.md` | Stable worker identity and specialty |
| System prompt profile | Selectable behavior for one run/session |
| `.crewcoder/memory` | Durable project facts learned across sessions |
| `/commands` | Reusable editable user prompts |

Do not duplicate the same rule across every layer. Keep architectural invariants in `AGENTS.md`; use `.crewcoder/rules` when modular files or path scoping materially improves maintainability.

## CrewCoder repository example

This repository carries a curated personal ruleset adapted from Claude's broader library:

```txt
.crewcoder/rules/
├── common/
│   ├── 10-development-workflow.md
│   ├── 20-verification.md
│   ├── 30-security.md
│   └── 40-documentation-and-review.md
└── typescript/
    ├── 10-coding-style.md
    └── 20-testing.md
```

The four `common` files have no frontmatter and apply to every new CrewCoder session in this repository. The TypeScript files declare `paths` for TypeScript, JavaScript, package, and tsconfig files, so they activate because this monorepo contains matching files.

The curated set intentionally excludes mandates that are not true for this project, including fixed coverage percentages, mandatory TDD for every edit, mandatory external web research, Claude-specific model/agent names, and prose that claims to configure executable hooks.

To inspect or edit the active rules:

```bash
find .crewcoder/rules -type f -name '*.md' -print
$EDITOR .crewcoder/rules/common/10-development-workflow.md
```

Start a new session after changing rules:

```txt
/new
```

CLI runs naturally load the latest rules because each `crewcoder run` starts a new session. Resuming an existing durable session preserves its original background context rather than silently changing instructions midway through the conversation.

## Migrating Claude rules

A Claude rules collection can be adapted, but do not blindly copy a large global library into every repository.

Recommended migration:

```bash
mkdir -p .crewcoder/rules/common .crewcoder/rules/typescript
cp ~/.claude/rules/common/coding-style.md .crewcoder/rules/common/
cp ~/.claude/rules/common/testing.md .crewcoder/rules/common/
cp ~/.claude/rules/typescript/coding-style.md .crewcoder/rules/typescript/
cp ~/.claude/rules/typescript/testing.md .crewcoder/rules/typescript/
```

Then review the copied text:

- keep only rules relevant to this repository;
- preserve `paths` frontmatter on language-specific files;
- remove references to unavailable skills;
- rewrite Claude-specific hook instructions as guidance or CrewCoder extension hooks;
- avoid generic mandates such as fixed coverage percentages unless the project actually enforces them;
- commit the selected rules so collaborators can review changes.

The audited `/home/aura/.claude/rules` collection contains 66 Markdown files and roughly 105 KB across common and 11 language directories. Its layered/path-scoped structure is valuable; injecting the entire collection would be noisy and waste context. Selective repository migration is the intended approach.

## Implementation

```txt
src/core/rules-store.ts       discovery, frontmatter parsing, matching, limits
src/core/agent-loop.ts        initial background-context integration
src/tests/rules-store.test.ts loader behavior and safety limits
src/tests/agent-loop.test.ts  provider-facing integration
```
