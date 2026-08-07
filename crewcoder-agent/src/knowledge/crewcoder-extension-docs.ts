import type { EmbeddedDoc } from "./crewcode-docs.js";

/**
 * Embedded knowledge about **CrewCoder extensions** (`crewcoder.extension.json`).
 *
 * Deliberately separate from `crewcode-docs.ts`, which describes **CrewCode app
 * plugins** (`crewcode.plugin.json`). The two systems share no manifest, no install
 * location, and no trust model; merging these doc sets is how the agent starts
 * emitting plugin permissions inside an extension manifest.
 *
 * `summary` is the cheap index line composed into the system prompt on every run.
 * `content` is the full buildable reference and is loaded ONLY when the model calls
 * the `docs` tool, so depth here costs nothing until it is actually needed. Keep
 * `content` grounded in `src/extensions/types.ts`, `src/extensions/api.ts`, and
 * `docs/EXTENSION_*.md` — it must stay re-derivable, not invented.
 */
export const embeddedCrewCoderExtensionDocs: EmbeddedDoc[] = [
  {
    id: "extensions",
    title: "CrewCoder extensions overview",
    summary:
      "Capability-based packages that extend CrewCoder itself, installed at <crewcoder-home>/extensions/<extension-id>/crewcoder.extension.json. One extension may declare any combination of contribution points.",
    tags: ["extension", "crewcoder.extension.json", "capability", "extensions dir", "crewcoder home", "getting started", "build an extension"],
    content: `# Building a CrewCoder extension

A CrewCoder extension extends **CrewCoder itself** (the coding agent). It is NOT a
CrewCode desktop app plugin. Different manifest, different install root, different
trust model.

## Minimum viable extension

Two files:

\`\`\`txt
my-extension/
├── crewcoder.extension.json    # required
└── index.ts                    # optional, only if you declare "main"
\`\`\`

\`crewcoder.extension.json\`:

\`\`\`json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "0.1.0",
  "description": "Adds a release checklist skill.",
  "crewcoder": { "apiVersion": "0.1" },
  "contributes": {
    "skills": [
      {
        "id": "release-checklist",
        "title": "Release checklist",
        "description": "Steps to take before tagging a release.",
        "triggers": ["release", "tag a version", "ship it"],
        "prompt": "Before tagging a release: run the full suite, update CHANGELOG.md, verify the version in package.json, and confirm the build is green."
      }
    ]
  }
}
\`\`\`

That is a complete, working extension. It needs no code and no trust — skills are
prompt-only.

## Build it end to end

\`\`\`bash
# 1. scaffold
crewcoder extension init my-extension

# 2. edit crewcoder.extension.json

# 3. install from a local path
crewcoder extension install ./my-extension

# 4. confirm it loaded
crewcoder extension list

# 5. ONLY if it contributes executable things (tools/hooks/modules):
crewcoder extension trust my-extension --tier trusted
crewcoder config set allowExtensionTools true
\`\`\`

Install places the package at \`<home>/extensions/<manifest.id>\`. The directory name
must equal \`manifest.id\` — trust, enable, and lookup all key off that id.

## Pick your contribution point

| You want to... | Use |
|---|---|
| Add reusable instructions the agent follows | \`skills\` |
| Add a named reusable prompt the user invokes | \`commands\` |
| Add a real executable tool | \`tools\` |
| Run code before/after every tool call | \`hooks\` |
| Force approval or block dangerous calls | \`approvalPolicies\` |
| Run a fixed multi-step routine | \`workflows\` |
| Add a model provider | \`providers\` |
| React to changed files | \`fileTriggers\` |

## Trust reality check

Nothing executable runs until you explicitly trust the extension. \`skills\`,
\`promptPacks\`, and \`commands\` work at the default \`prompt-only\` tier. Everything
else needs \`crewcoder extension trust\` plus a config flag. See the trust doc.`
  },
  {
    id: "extension-manifest",
    title: "CrewCoder extension manifest reference",
    summary:
      "Required: id, name, version, crewcoder.apiVersion 0.1. Optional: main (TS/JS entry), permissions.network.allowedHosts, activation (events/keywords/modes/commands/filePatterns), contributes.",
    tags: ["extension manifest", "apiversion", "manifest id", "activation", "permissions", "allowedhosts", "main entry", "manifest reference"],
    content: `# crewcoder.extension.json reference

## Full manifest

\`\`\`json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "0.1.0",
  "description": "What this extension adds.",
  "crewcoder": { "apiVersion": "0.1" },
  "main": "index.ts",
  "permissions": {
    "network": { "allowedHosts": ["api.example.com", "*.trusted.dev"] }
  },
  "activation": {
    "events": [],
    "keywords": ["release", "deploy"],
    "modes": [],
    "commands": [],
    "filePatterns": ["**/*.ts"]
  },
  "contributes": {
    "providers": [],
    "skills": [],
    "promptPacks": [],
    "tools": [],
    "commands": [],
    "workflows": [],
    "contextProviders": [],
    "validators": [],
    "approvalPolicies": [],
    "fileTriggers": [],
    "hooks": [],
    "ui": [],
    "liveUi": []
  }
}
\`\`\`

## Field rules

| Field | Required | Notes |
|---|---|---|
| \`id\` | yes | Must equal the install directory name |
| \`name\` | yes | Display name |
| \`version\` | yes | Semver string |
| \`crewcoder.apiVersion\` | yes | Currently exactly \`"0.1"\` |
| \`description\` | no | Shown in \`extension list\` and registry search |
| \`main\` | no | TS/JS module, default-exports \`(api: CrewCoderExtAPI) => void\` |
| \`permissions.network.allowedHosts\` | no | Outbound egress is DENIED unless declared. Exact host, \`*.example.com\`, or \`*\` |
| \`activation\` | no | Cheap relevance gate. Never loads code by itself |
| \`contributes\` | no | Any combination of contribution points |

## Activation

\`activation\` is a hint for discovery and prompt composition, not a security boundary:

\`\`\`json
"activation": {
  "keywords": ["release", "changelog"],
  "filePatterns": ["**/package.json"],
  "commands": ["release.check"]
}
\`\`\`

## Unknown contribution points are legal

The TypeScript contract allows unknown keys under \`contributes\` so the architecture
can grow without forcing authors into categories. An unknown point is accepted and
inert, not an error.

## Validate

\`\`\`bash
crewcoder extension install ./my-extension   # validates in a temp dir first
crewcoder extension list
\`\`\`

Install stages into a temp directory, validates the manifest there, and only then
places the package. A bad manifest never lands in your extensions directory.`
  },
  {
    id: "extension-skills",
    title: "Building skills and prompt packs",
    summary:
      "skills activate when a trigger substring appears in the prompt and inject their prompt body. promptPacks activate when the pack/prompt id or title is referenced. Both work at the prompt-only tier with no trust.",
    tags: ["skill", "skills", "promptpack", "promptpacks", "trigger", "activation", "prompt injection", "build a skill"],
    content: `# Skills and prompt packs

The cheapest useful extension. **No trust required** — both work at the default
\`prompt-only\` tier.

## Skills

A skill injects instructions into the system prompt when a trigger matches.

\`\`\`json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "0.1.0",
  "crewcoder": { "apiVersion": "0.1" },
  "contributes": {
    "skills": [
      {
        "id": "postgres-migrations",
        "title": "Postgres migrations",
        "description": "House rules for writing database migrations.",
        "triggers": ["migration", "alter table", "schema change"],
        "prompt": "Migrations must be reversible. Always write an explicit down migration. Never DROP COLUMN in the same release that stops writing to it - split across two deploys. Add indexes CONCURRENTLY."
      }
    ]
  }
}
\`\`\`

### How activation works

- Matching is **case-insensitive substring** matching against the user prompt.
- If any trigger matches, the skill's \`prompt\` body is injected into the system prompt.
- All enabled skills are listed as available metadata even when not activated.
- Activated ids are reported on \`AgentLoopResult.activatedExtensions\`.

Implementation: \`src/extensions/extension-activation.ts\`.

### Trigger design

Triggers are substrings, so keep them specific. \`"test"\` matches "latest",
"greatest", and "contest". Prefer multi-word triggers like \`"run the tests"\`.

## Prompt packs

A prompt pack holds named reusable prompts. A prompt activates when its pack id,
prompt id, or title is referenced in the user prompt.

\`\`\`json
"promptPacks": [
  {
    "id": "review",
    "title": "Review prompts",
    "prompts": [
      {
        "id": "security-pass",
        "title": "Security pass",
        "content": "Review this diff for injection, authz bypass, and secret leakage. Report severity per finding."
      }
    ]
  }
]
\`\`\`

Or load from a file relative to the extension directory:

\`\`\`json
"promptPacks": [
  { "id": "review", "title": "Review prompts", "file": "prompts/review.md" }
]
\`\`\`

## Verify

\`\`\`bash
crewcoder extension install ./my-extension
crewcoder run "write a migration to add a users table"
# the skill body should appear in the composed system prompt
\`\`\``
  },
  {
    id: "extension-tools",
    title: "Building extension tools",
    summary:
      "Manifest tools run a local command with no shell; module tools use crew.defineTool(). Names are namespaced extension_<extension-id>_<tool-id>. Requires allowExtensionTools=true plus a trusted extension id.",
    tags: ["extension tool", "tools", "namespaced", "no shell", "definetool", "build a tool", "custom tool"],
    content: `# Building extension tools

Two ways to add a tool. Both require \`allowExtensionTools=true\` **and** the extension
in \`trustedExtensions\`.

## 1. Manifest tool (runs a local command)

\`\`\`json
{
  "id": "repo-tools",
  "name": "Repo Tools",
  "version": "0.1.0",
  "crewcoder": { "apiVersion": "0.1" },
  "contributes": {
    "tools": [
      {
        "id": "changed-files",
        "title": "Changed files",
        "description": "List files changed against the default branch.",
        "command": "git",
        "args": ["diff", "--name-only", "origin/main...HEAD"],
        "category": "git"
      }
    ]
  }
}
\`\`\`

The model calls this as \`extension_repo-tools_changed-files\`.

**Commands execute without a shell.** \`"command": "git diff | head"\` does not work —
there is no shell to interpret the pipe. Pass argv exactly:

\`\`\`json
"command": "git", "args": ["diff", "--name-only"]
\`\`\`

This is deliberate: no shell means no shell injection through model-supplied args.

## 2. Module tool (\`crew.defineTool\`)

Needs \`main\` plus \`allowExtensionModules=true\` and the \`trusted\` tier. Module tools
cannot be sandboxed as subprocesses, so \`sandboxed\` is not enough.

\`\`\`ts
import type { CrewCoderExtAPI } from "@onpoint-dev-tools/crewcoder-agent";

export default function (crew: CrewCoderExtAPI) {
  crew.defineTool({
    name: "word_count",
    description: "Count words in a workspace file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative path" } },
      required: ["path"],
      additionalProperties: false
    },
    async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
      const fs = await import("node:fs/promises");
      const text = await fs.readFile(\`\${ctx.cwd}/\${String(args.path)}\`, "utf8");
      return { content: [{ type: "text", text: \`\${text.split(/\\s+/).filter(Boolean).length} words\` }] };
    }
  });
}
\`\`\`

### execute signature

\`\`\`ts
execute(
  toolCallId: string,
  params: TArgs,
  signal: AbortSignal | undefined,
  onUpdate: ((update: { content: TextPart[]; details?: Record<string, unknown> }) => void) | undefined,
  ctx: CrewCoderExtContext & { toolContext: ToolContext }
): Promise<ToolResult>
\`\`\`

Optional fields: \`label\`, \`icon\`, \`category\`, \`renderer\`, \`isMutation\`,
\`prepareArguments(args)\`.

Set \`isMutation: true\` if the tool changes files — it then routes through the normal
approval gates.

## Enable

\`\`\`bash
crewcoder extension install ./repo-tools
crewcoder extension trust repo-tools --tier trusted
crewcoder config set allowExtensionTools true
crewcoder config set allowExtensionModules true   # module tools only
\`\`\``
  },
  {
    id: "extension-hooks",
    title: "Building extension hooks",
    summary:
      "Hooks fire on context, beforeToolCall, afterToolCall, onError, and compaction. beforeToolCall can allow/block/modify. An omitted matches filter matches EVERY tool call. Needs allowExtensionHooks plus the trusted tier.",
    tags: ["hook", "hooks", "beforetoolcall", "aftertoolcall", "onerror", "compaction", "matches", "block", "modify", "intercept"],
    content: `# Building extension hooks

Hooks intercept the agent loop. They require \`allowExtensionHooks=true\` **and** the
full \`trusted\` tier (\`sandboxed\` is not enough).

## Events

| Event | When | Can it change anything? |
|---|---|---|
| \`context\` | Before the turn | Returns extra context text |
| \`beforeToolCall\` | Before a tool runs | \`allow\` / \`block\` / \`modify\` args |
| \`afterToolCall\` | After a tool runs | Advisory context only |
| \`onError\` | Only when \`result.isError\`, before \`afterToolCall\` | Advisory context only |
| \`compaction\` | On a prepared compaction proposal | \`summary\` replace or \`append\` |

## Manifest hook

\`\`\`json
{
  "id": "guardrails",
  "name": "Guardrails",
  "version": "0.1.0",
  "crewcoder": { "apiVersion": "0.1" },
  "contributes": {
    "hooks": [
      {
        "id": "block-prod-writes",
        "title": "Block production config writes",
        "event": "beforeToolCall",
        "matches": {
          "tools": ["write", "edit"],
          "paths": ["config/production/**"]
        },
        "command": "node",
        "args": ["hooks/block-prod.mjs", "{{payloadJson}}"],
        "timeoutMs": 5000
      }
    ]
  }
}
\`\`\`

\`hooks/block-prod.mjs\` — receives the payload on stdin and as \`{{payloadJson}}\`,
returns a JSON decision on stdout:

\`\`\`js
let raw = "";
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", () => {
  const payload = JSON.parse(raw || "{}");
  const path = String(payload?.toolCall?.arguments?.path ?? "");
  if (path.includes("config/production/")) {
    process.stdout.write(JSON.stringify({
      action: "block",
      reason: "Production config is changed through the deploy pipeline, not the agent."
    }));
  } else {
    process.stdout.write(JSON.stringify({ action: "allow" }));
  }
});
\`\`\`

## The matches filter (read this)

\`matches\` gates which tool calls the hook sees:

\`\`\`json
"matches": {
  "tools": ["bash", "write"],
  "paths": ["src/**", "*.env"],
  "commands": ["rm ", "/curl|wget/"]
}
\`\`\`

- \`tools\`: substring, \`*\` glob, or \`/regex/\`
- \`paths\`: glob-matched against path-like args
- \`commands\`: substring, glob, or \`/regex/\` against bash command text

**An omitted or empty \`matches\` matches EVERY tool call.** That is the opposite of
\`approvalPolicies\`, where no matchers means it never matches. The asymmetry is
intentional; do not "fix" it.

## Module hook

\`\`\`ts
export default function (crew: CrewCoderExtAPI) {
  crew.handleEvent("before_tool_call", async (event) => {
    const command = String(event.toolCall.arguments.command ?? "");
    if (event.toolCall.name === "bash" && command.includes("rm -rf")) {
      return { action: "block", reason: "Recursive delete blocked by policy." };
    }
  });

  crew.handleEvent("context", async () => ({
    context: "This repo deploys on merge to main. Never push directly."
  }));
}
\`\`\`

Module event names use snake_case (\`before_tool_call\`), manifest \`event\` uses
camelCase (\`beforeToolCall\`).

## Compaction hooks

Run on a prepared-but-uninstalled summary, chain (each sees the prior hook's summary),
and run BEFORE the human preview so \`/compact preview\` shows the final text. A failed
or silent compaction hook leaves the summary untouched — compaction must never break
because a hook misbehaved.

## Inspect

\`\`\`bash
crewcoder extension hooks
\`\`\``
  },
  {
    id: "extension-approval-policies",
    title: "Building approval policies and file triggers",
    summary:
      "approvalPolicies force review or block matching tool/path/command calls even when the approval mode would allow them; a policy with NO matchers never matches. fileTriggers run commands after tool mutations report changed files.",
    tags: ["approvalpolicy", "approvalpolicies", "filetrigger", "filetriggers", "approval", "review", "block", "matcher", "file_changed", "policy"],
    content: `# Approval policies and file triggers

Both need \`allowExtensionHooks=true\` plus a trusted extension id.

## Approval policies

Force review or block specific calls, even when the built-in approval mode would let
them through.

\`\`\`json
{
  "id": "safety-net",
  "name": "Safety Net",
  "version": "0.1.0",
  "crewcoder": { "apiVersion": "0.1" },
  "contributes": {
    "approvalPolicies": [
      {
        "id": "review-migrations",
        "title": "Review database migrations",
        "action": "review",
        "reason": "Migrations are reviewed by a human before they run.",
        "paths": ["migrations/**", "db/migrate/**"]
      },
      {
        "id": "block-force-push",
        "title": "Block force push",
        "action": "block",
        "reason": "Force push to shared branches is not allowed.",
        "tools": ["bash"],
        "commands": ["/push\\\\s+.*--force/", "push --force-with-lease"]
      }
    ]
  }
}
\`\`\`

| Field | Meaning |
|---|---|
| \`action\` | \`allow\`, \`review\` (force approval), or \`block\` (prevent execution) |
| \`reason\` | Shown in the approval/blocked message |
| \`tools\` | Tool name patterns |
| \`paths\` | Glob against path-like args (\`path\`, \`file\`, \`directory\`, \`target\`) |
| \`commands\` | Substring or \`/regex/\` against bash command text |

**A policy with no matchers never matches.** Opposite of hooks. Always give a policy
at least one matcher or it does nothing.

Policies and hooks share \`src/extensions/tool-call-matcher.ts\`, so pattern semantics
cannot drift between them.

## File triggers

Run a local command after agent tool mutations report changed files. This is
**post-tool only**, not a background file watcher.

\`\`\`json
"fileTriggers": [
  {
    "id": "format-on-write",
    "title": "Format changed TypeScript",
    "patterns": ["**/*.ts", "**/*.tsx"],
    "command": "npx",
    "args": ["prettier", "--write", "{{path}}"],
    "timeoutMs": 15000
  }
]
\`\`\`

Template variables available in \`args\` and \`env\`:

\`\`\`txt
{{path}}         changed file path
{{toolName}}     tool that caused the change
{{cwd}}          working directory
{{sessionId}}    active session id
{{json}}         full payload as JSON
{{payloadJson}}  alias of {{json}}
\`\`\`

The payload also arrives on stdin and in
\`CREWCODER_EXTENSION_FILE_TRIGGER_PAYLOAD\`.

## Enable

\`\`\`bash
crewcoder extension trust safety-net --tier trusted
crewcoder config set allowExtensionHooks true
\`\`\``
  },
  {
    id: "extension-workflows",
    title: "Building workflows",
    summary:
      "Deterministic linear tool/prompt sequences run with crewcoder workflow list|show|run. Guards are steps.<id>.ok|failed, failure policy is stop|continue, templating is {{steps.<id>.output}}. No loops or arithmetic.",
    tags: ["workflow", "workflows", "steps", "onfailure", "guard", "templating", "workflow run", "workflow show", "build a workflow"],
    content: `# Building workflows

A workflow is a deterministic, linear sequence of tool calls and model turns declared
in the manifest. The point is **reviewability**: \`crewcoder workflow show <id>\`
renders the exact plan before anything runs.

## Complete example

\`\`\`json
{
  "id": "release-tools",
  "name": "Release Tools",
  "version": "0.1.0",
  "crewcoder": { "apiVersion": "0.1" },
  "contributes": {
    "workflows": [
      {
        "id": "release-check",
        "title": "Release check",
        "description": "Run the suite, then explain any failure.",
        "steps": [
          {
            "id": "test",
            "kind": "tool",
            "title": "Run tests",
            "tool": "bash",
            "args": { "command": "npm test" },
            "onFailure": "continue"
          },
          {
            "id": "explain",
            "kind": "prompt",
            "title": "Diagnose failures",
            "when": "steps.test.failed",
            "prompt": "These tests failed:\\n{{steps.test.output}}\\nFind the root cause.",
            "allowTools": ["read", "grep", "lsp_diagnostics"]
          }
        ]
      }
    ]
  }
}
\`\`\`

## Step fields

| Field | Applies to | Meaning |
|---|---|---|
| \`kind\` | all | \`tool\` (fixed args, no model discretion) or \`prompt\` (one model turn) |
| \`id\` | all | Referenced by \`when\` and \`{{steps.<id>.output}}\`. Defaults to the 1-based index |
| \`title\` | all | Label shown in \`workflow show\` |
| \`tool\` / \`args\` | \`tool\` | Built-in tool name and its arguments |
| \`prompt\` | \`prompt\` | Prompt text |
| \`allowTools\` | \`prompt\` | Restrict the model to these tools for this step |
| \`when\` | all | \`steps.<id>.ok\` or \`steps.<id>.failed\`. Omitted means always run |
| \`onFailure\` | all | \`stop\` (default) or \`continue\` |

## Guards

Exactly two forms: \`steps.<id>.ok\` and \`steps.<id>.failed\`. A step that was itself
skipped satisfies neither, so guard chains do not silently cascade. Anything malformed
is a manifest validation error, not a silent no-op.

## Templating

\`{{steps.<id>.output}}\` interpolates a previous step's text output. Works in \`prompt\`
text and in any string inside \`args\`, including nested objects and arrays. Unknown ids
resolve to empty.

## Failure semantics

A \`tool\` step counts a non-zero \`details.exitCode\` as failure, not just a thrown
error. Without that, a \`bash\`-wrapped \`npm test\` step always looks successful and every
\`when\`/\`onFailure\` guard becomes meaningless.

## Trust split

- Prompt-only workflows run at **any** tier — the agent's own approval gates still apply.
- Any workflow containing a \`tool\` step needs \`sandboxed\` or \`trusted\`, because a tool
  step executes with fixed args and no model judgement.

## Run it

\`\`\`bash
crewcoder workflow list
crewcoder workflow show release-check    # review the plan first
crewcoder workflow run release-check
\`\`\`

## Deliberately not a language

Linear steps, one guard form, one failure policy. No loops, no arithmetic, no
variables. If something needs those, it should be a tool.`
  },
  {
    id: "extension-commands",
    title: "Building extension commands",
    summary:
      "Commands are reusable prompt commands surfaced through crewcoder command list/show and TUI /commands as ext.<extension-id>.<command-id>. Module commands use crew.defineCommand with a ctx.ui channel.",
    tags: ["command", "commands", "definecommand", "ext.", "slash command", "command run", "build a command"],
    content: `# Building extension commands

Commands are reusable named prompts (or code handlers) the user invokes directly.

## Manifest command (prompt)

\`\`\`json
{
  "id": "review-pack",
  "name": "Review Pack",
  "version": "0.1.0",
  "crewcoder": { "apiVersion": "0.1" },
  "contributes": {
    "commands": [
      {
        "id": "security",
        "title": "Security review",
        "description": "Review the working tree for security issues.",
        "prompt": "Review the current diff for injection, authz bypass, unsafe deserialization, and secret leakage. Report each finding with a severity."
      }
    ]
  }
}
\`\`\`

Invoke as \`ext.review-pack.security\`:

\`\`\`bash
crewcoder command list
crewcoder command show ext.review-pack.security
crewcoder command run ext.review-pack.security
\`\`\`

In the TUI: \`/commands\` picker, or type \`/ext.review-pack.security\` directly.

Manifest prompt commands work at the **prompt-only** tier — no trust needed.

## Module command (\`crew.defineCommand\`)

Needs \`main\`, \`allowExtensionModules=true\`, and the \`trusted\` tier.

\`\`\`ts
import type { CrewCoderExtAPI } from "@onpoint-dev-tools/crewcoder-agent";

export default function (crew: CrewCoderExtAPI) {
  crew.defineCommand("branch-report", {
    description: "Summarize the current branch state.",
    async handler(args, ctx) {
      const branch = await ctx.git.currentBranch();
      const files = await ctx.git.changedFiles();

      if (!files.length) {
        ctx.ui.notify("Working tree is clean.", "success");
        return;
      }

      const ok = await ctx.ui.confirm(
        \`\${files.length} changed files on \${branch ?? "detached HEAD"}\`,
        "Create a checkpoint?"
      );
      if (ok) {
        await ctx.git.createCheckpoint(\`manual checkpoint on \${branch}\`);
        ctx.ui.notify("Checkpoint created.", "success");
      }
    }
  });
}
\`\`\`

## ctx.ui surface

\`\`\`ts
ctx.ui.notify(message, "info" | "success" | "warning" | "error")
ctx.ui.confirm(title, message?)                       -> Promise<boolean>
ctx.ui.input(title, { placeholder?, defaultValue? })  -> Promise<string | undefined>
ctx.ui.select(title, options)                         -> Promise<T | undefined>
ctx.ui.component(title, component, { message?, actions? })
\`\`\`

In non-interactive \`command run\` print mode, \`notify\` messages are printed and
blocking prompts use safe defaults, so a command never hangs a scripted run.

## ctx.git helpers

\`\`\`ts
ctx.git.status()            ctx.git.currentBranch()
ctx.git.changedFiles()      ctx.git.createCheckpoint(reason)
ctx.git.issueReferences()   ctx.git.reviewSummary()
\`\`\``
  },
  {
    id: "extension-modules",
    title: "Building CrewCoderExtAPI modules",
    summary:
      "main default-exports (api: CrewCoderExtAPI) => void. Surface: defineTool, defineCommand, handleEvent (session_start, context, before_tool_call, after_tool_call, agent_event), writeSessionEntry, getSessionEntries.",
    tags: ["crewcoderextapi", "module", "main", "handleevent", "agent_event", "writesessionentry", "getsessionentries", "session persistence"],
    content: `# CrewCoderExtAPI modules

A module extension declares \`main\` and default-exports a factory. Requires
\`allowExtensionModules=true\` and the \`trusted\` tier.

\`\`\`json
{
  "id": "observer",
  "name": "Observer",
  "version": "0.1.0",
  "crewcoder": { "apiVersion": "0.1" },
  "main": "index.ts"
}
\`\`\`

\`\`\`ts
import type { CrewCoderExtAPI } from "@onpoint-dev-tools/crewcoder-agent";

export default function (crew: CrewCoderExtAPI) {
  // ...
}
\`\`\`

## API surface

\`\`\`ts
type CrewCoderExtAPI = {
  handleEvent(event, handler): void;
  handleEvent("agent_event", options, handler): void;
  defineTool(definition): void;
  defineCommand(name, definition): void;
  writeSessionEntry(customType, data?): void;
  getSessionEntries(): CrewCoderExtSessionEntry[];
  getDefinedTools(): CrewCoderExtToolDefinition[];
  getDefinedCommands(): CrewCoderExtRegisteredCommand[];
};
\`\`\`

## Events

| Event | Payload |
|---|---|
| \`session_start\` | \`{ reason: "startup" \\| "reload"; cwd; sessionId? }\` |
| \`context\` | \`{ cwd; sessionId; prompt; mode }\` |
| \`before_tool_call\` | \`{ toolCall; context }\` |
| \`after_tool_call\` | \`{ toolCall; result; context }\` |
| \`agent_event\` | any emitted \`AgentEvent\` |

### Return values

\`\`\`ts
void
{ context?: string }
{ block?: boolean; reason?: string; context?: string }
{ action?: "allow" | "block" | "modify"; reason?: string; args?: Record<string, unknown>; context?: string }
\`\`\`

## agent_event

Observation hook for automation and telemetry. Return values are ignored.

\`\`\`ts
crew.handleEvent("agent_event", async (event, ctx) => {
  if (event.type === "tool_execution_end") {
    crew.writeSessionEntry("tool-observed", { toolName: event.toolName, isError: event.isError });
  }
});
\`\`\`

Filter to avoid noisy handlers:

\`\`\`ts
crew.handleEvent("agent_event", { types: ["tool_execution_end", "session_saved"] }, async (event) => {
  crew.writeSessionEntry("observed-event", { type: event.type });
});
\`\`\`

## Session persistence

\`crew.writeSessionEntry(customType, data?)\` records a durable, extension-scoped entry.
Entries persist to \`SessionRecord.extensionEntries\` and are replayed on resume, so an
extension can read its own history with \`crew.getSessionEntries()\` (returns only that
extension's entries). Replay is idempotent — deduped by extension id + timestamp +
type — so resuming twice in one process does not duplicate history.

## Enable

\`\`\`bash
crewcoder extension trust observer --tier trusted
crewcoder config set allowExtensionModules true
crewcoder config set allowExtensionTools true   # only for crew.defineTool
\`\`\``
  },
  {
    id: "extension-providers",
    title: "Contributing model providers",
    summary:
      "providers are merged into the provider registry so users can select them like built-ins. Vetted extension runtimes: process, model-command, anthropic-messages, openai-chat-completions, openai-responses, websocket. Credential/session-owning Codex and Claude Agent SDK runtimes are built-in only. command and args are required on every provider.",
    tags: ["provider", "providers", "model provider", "provider adapter", "registry", "add a provider", "runtime"],
    content: `# Contributing a model provider

Built-in providers (including \`codex\`, \`openai\`, \`anthropic\`, and \`opencode\`) live in \`src/providers\` and are
first-class adapters, **not** extensions. Users add *additional* providers through
extensions.

Declared providers are merged into the provider registry and become selectable like
built-ins.

## Runtimes

\`\`\`txt
process                  spawn a local CLI
model-command            spawn a local CLI with model flags
anthropic-messages       HTTP, Anthropic /v1/messages shape   (endpoint required)
openai-chat-completions  HTTP, OpenAI Chat Completions shape  (endpoint required)
openai-responses         HTTP, OpenAI Responses shape          (endpoint required)
websocket                WebSocket transport                  (endpoint required)
\`\`\`

Anything else is a manifest validation error.

## HTTP provider

**\`command\` and \`args\` are required on every provider, including HTTP ones.** The
built-in HTTP adapters use \`"command": "http", "args": []\` — copy that. Omitting them
fails validation with "invalid provider contribution".

\`\`\`json
{
  "id": "acme-provider",
  "name": "Acme Provider",
  "version": "0.1.0",
  "crewcoder": { "apiVersion": "0.1" },
  "permissions": {
    "network": { "allowedHosts": ["gateway.acme.internal"] }
  },
  "contributes": {
    "providers": [
      {
        "id": "acme",
        "title": "Acme Gateway",
        "runtime": "anthropic-messages",
        "command": "http",
        "args": [],
        "endpoint": "https://gateway.acme.internal/v1/messages",
        "apiKeyEnv": "ACME_API_KEY",
        "models": ["acme-large", "acme-fast"],
        "defaultModel": "acme-large",
        "description": "Acme internal gateway. Set ACME_API_KEY."
      }
    ]
  }
}
\`\`\`

## Local CLI provider

\`\`\`json
"providers": [
  {
    "id": "aider",
    "title": "Aider",
    "runtime": "process",
    "command": "aider",
    "args": ["--no-stream"],
    "models": ["gpt-4o"]
  }
]
\`\`\`

## Field notes

| Field | Required | Notes |
|---|---|---|
| \`id\`, \`title\` | yes | Registry identity |
| \`runtime\` | yes | One of the six vetted extension runtimes above |
| \`command\`, \`args\` | yes | \`"http"\` / \`[]\` for HTTP runtimes |
| \`endpoint\` | for all HTTP/WebSocket runtimes | Full URL; host must be declared in network permissions |
| \`apiKeyEnv\` | no | Env var name. Never inline a key |
| \`models\`, \`defaultModel\` | no | Selectable model ids |

Network egress is denied unless the host appears in
\`permissions.network.allowedHosts\`.

## Verify

\`\`\`bash
crewcoder extension install ./acme-provider
crewcoder providers                       # acme should be listed
crewcoder run --provider acme "hello"
\`\`\`

## Streaming contract

If your provider surfaces reasoning, it must reach the TUI through the thinking path:

\`\`\`txt
ModelStreamCallbacks.onThinkingDelta -> AgentEvent thinking_delta -> TUI thinking block
\`\`\`

Provider failures are terminal and must never render as assistant text. A
billing/auth/network failure that renders as a successful reply is a bug.`
  },
  {
    id: "extension-trust",
    title: "Extension trust tiers and capability flags",
    summary:
      "Tiers: prompt-only (default; skills/promptPacks/commands), sandboxed (command tools run in the OS sandbox), trusted (full host access). Install never grants trust. Executable capabilities also need config flags.",
    tags: ["trust", "tier", "prompt-only", "sandboxed", "trusted", "allowextensiontools", "allowextensionmodules", "allowextensionhooks", "untrust", "security"],
    content: `# Trust tiers and capability flags

## The three tiers

| Tier | Host access | In-process modules | Prompt contributions |
|---|---|---|---|
| \`trusted\` | full | yes | yes |
| \`sandboxed\` | command tools run in the OS sandbox | no | yes |
| \`prompt-only\` (default) | none | no | yes (skills / promptPacks / commands) |

\`\`\`bash
crewcoder extension trust <id>                  # trusted (default)
crewcoder extension trust <id> --tier sandboxed
crewcoder extension untrust <id>                # back to prompt-only
crewcoder extension tier <id>                   # show effective tier
\`\`\`

Storage stays backward compatible: \`config.trustedExtensions\` is the \`trusted\` list,
\`config.sandboxedExtensions\` is the \`sandboxed\` list, anything else enabled is
\`prompt-only\`.

## Install never grants trust

\`crewcoder extension install\` validates and places the package, then prints a
capability summary. Everything executable stays **inert** until you explicitly trust
it. That summary is the only thing standing between install and running third-party
code — read it.

## Tier is necessary but not sufficient

Trust alone does nothing. Each executable capability also needs a config flag:

| Capability | Tier | Config flag |
|---|---|---|
| \`tools\` (manifest command) | \`sandboxed\` or \`trusted\` | \`allowExtensionTools\` |
| \`tools\` (\`crew.defineTool\`) | \`trusted\` only | \`allowExtensionTools\` + \`allowExtensionModules\` |
| \`main\` module | \`trusted\` | \`allowExtensionModules\` |
| \`hooks\` | \`trusted\` only | \`allowExtensionHooks\` |
| \`approvalPolicies\` | \`trusted\` | \`allowExtensionHooks\` |
| \`fileTriggers\` | \`trusted\` | \`allowExtensionHooks\` |
| \`workflows\` with a \`tool\` step | \`sandboxed\` or \`trusted\` | — |
| \`workflows\`, prompt-only | any | — |
| \`skills\`, \`promptPacks\`, \`commands\` | any | — |

\`\`\`bash
crewcoder config set allowExtensionTools true
crewcoder config set allowExtensionHooks true
crewcoder config set allowExtensionModules true
\`\`\`

In-process module tools require the \`trusted\` tier because they cannot be sandboxed
as subprocesses.

## Network egress

Denied unless declared:

\`\`\`json
"permissions": { "network": { "allowedHosts": ["api.example.com", "*.trusted.dev"] } }
\`\`\`

Patterns: exact host, \`*.example.com\` (subdomains, not the apex), or \`*\`. Enforced for
sandboxed-tier extension command tools and the sandboxed \`bash\` tier.`
  },
  {
    id: "extension-install",
    title: "Installing, updating, and distributing extensions",
    summary:
      "install <owner/repo|url|path> stages into a temp dir, validates, then places at <home>/extensions/<manifest.id>. update reinstalls from the recorded resolved spec, not the registry. Registry search resolves bare names only.",
    tags: ["install", "update", "uninstall", "registry", "extension search", "distribution", "publish", "staging", "resolved spec"],
    content: `# Installing, updating, and distributing

## Install

\`\`\`bash
crewcoder extension install ./my-extension                        # local path
crewcoder extension install acme/nextjs-workflows                 # owner/repo
crewcoder extension install https://example.com/pack.tar.gz       # url
crewcoder extension install acme/pack@v1.2.0#packages/lint        # ref + subdir
crewcoder extension install nextjs-workflows                      # bare name -> registry
crewcoder extension install acme/pack --trust sandboxed
\`\`\`

Pipeline: stage into a temp dir → validate the manifest there → place at
\`<home>/extensions/<manifest.id>\`. A bad manifest never lands in your extensions
directory. The directory name must equal \`manifest.id\` because trust, enable, and
lookup all key off it.

## Update and remove

\`\`\`bash
crewcoder extension update <id>
crewcoder extension uninstall <id>
crewcoder extension list
\`\`\`

\`update\` reinstalls from the **recorded resolved spec**, not the registry, so a later
index edit cannot hijack an update.

## Discovery

\`\`\`bash
crewcoder extension search nextjs workflows
crewcoder extension registry add https://example.com/registry.json
\`\`\`

The first-party registry is searched by default, plus anything in
\`config.extensionRegistries\`.

**Only a bare name resolves through a registry.** Anything containing \`/\`, \`\\\\\`, \`:\`,
a leading \`.\` or \`~\`, or passed via \`--from\`, never touches a registry — an explicit
spec can never be redirected. User registries sort before the built-in, so a private
index can shadow a first-party id. A registry hit grants nothing: install still
validates and stays prompt-only.

Remote indexes cache for 6h under \`<home>/cache/registries\`. A failed refetch serves
the stale cache and says so; a broken registry never breaks search across the others.

## Publishing

Ship a repo whose root (or a subdirectory referenced with \`#path\`) contains
\`crewcoder.extension.json\`. To list it in a registry, add an entry to a JSON index
served at a \`/v1/\` path — \`RegistryIndex.version\` is a hard gate, so a v2 format must
live at \`/v2/\` while \`/v1/\` keeps serving old clients.

## Scaffold

\`\`\`bash
crewcoder extension init my-extension
\`\`\`

\`crewcoder extension create\` is a kept alias. The old \`--kind\` flag is deprecated and
ignored — extensions are capability-based, not categorized.`
  },
  {
    id: "extension-ui",
    title: "Extension UI, renderers, and live UI",
    summary:
      "Trusted declarative tool renderers match tool metadata and render markdown templates in the TUI. ctx.ui.* routes to the interactive host. liveUi is an experimental contract only; CrewCoder does not load live UI code.",
    tags: ["ui", "renderer", "renderers", "liveui", "experimental", "ctx.ui", "notify", "template", "custom rendering"],
    content: `# Extension UI

## Declarative tool renderers

Render matching tool results with your own markdown template instead of raw output.

\`\`\`json
{
  "id": "pretty-tools",
  "name": "Pretty Tools",
  "version": "0.1.0",
  "crewcoder": { "apiVersion": "0.1" },
  "contributes": {
    "ui": [
      {
        "id": "changed-files-renderer",
        "title": "Changed files renderer",
        "kind": "renderer",
        "target": "tool",
        "match": { "extensionId": "repo-tools", "toolId": "changed-files" },
        "template": "**Changed files**\\n\\n{{output}}"
      }
    ]
  }
}
\`\`\`

\`match\` fields (\`extensionId\`, \`toolId\`, \`renderer\`, \`toolName\`) are compared for
equality against tool metadata. Requires the trusted tier.

## Interactive UI from code

\`ctx.ui.*\` routes to the interactive host (TUI or JSON-events driver) through
\`extension_ui_*\` events and the \`ui_response\` control message.

\`\`\`ts
crew.defineCommand("pick-target", {
  async handler(_args, ctx) {
    const env = await ctx.ui.select("Deploy target", [
      { label: "Staging", value: "staging", description: "Safe" },
      { label: "Production", value: "production", description: "Requires approval" }
    ]);
    if (!env) return;

    await ctx.ui.component("Deploy plan", {
      kind: "details",
      items: [
        { label: "Target", value: env },
        { label: "Branch", value: (await ctx.git.currentBranch()) ?? "detached" }
      ]
    }, { actions: [{ id: "go", label: "Deploy" }] });
  }
});
\`\`\`

Component kinds: \`markdown\`, \`details\`, \`table\`, \`actionList\`.

The TUI renders \`notify\` inline and opens a focused popup
(\`ExtensionUiOverlay\`) for blocking prompts and declarative components.

## liveUi is contract-only

\`contributes.liveUi\` is an **experimental contract**. CrewCoder does not load live UI
code yet, and must not until a dedicated trusted/sandboxed runtime exists. Entries
require \`experimental: true\`, an \`entry\` module, a \`target.surface\`, a \`match\`
block, and an explicit \`permissions\` request; missing capabilities are denied by
default.

Do not write an extension that depends on live UI working today.`
  },
  {
    id: "extension-validators",
    title: "Validators and context providers",
    summary:
      "validators are executable checks run by crewcoder run --verify alongside package typecheck/test scripts. contextProviders are a declared contribution point for injecting workspace context.",
    tags: ["validator", "validators", "verify", "contextprovider", "contextproviders", "verification"],
    content: `# Validators and context providers

## Validators

Executable checks that run as part of \`crewcoder run --verify\`, alongside the
package's own typecheck/test scripts. They emit \`verification_start\` /
\`verification_end\` events.

\`\`\`json
{
  "id": "house-checks",
  "name": "House Checks",
  "version": "0.1.0",
  "crewcoder": { "apiVersion": "0.1" },
  "contributes": {
    "validators": [
      {
        "id": "no-todo-in-src",
        "title": "No TODO markers in src",
        "description": "Fails when a TODO lands in shipped source.",
        "command": "bash",
        "args": ["-c", "! grep -rn 'TODO' src --include='*.ts'"]
      }
    ]
  }
}
\`\`\`

Only **executable trusted** validators run. A non-zero exit is a verification failure,
which maps to CI exit code \`2\`.

\`\`\`bash
crewcoder run --verify "refactor the parser"
crewcoder run --ci "refactor the parser"      # --ci enables verification automatically
\`\`\`

## Context providers

\`contextProviders\` is a declared contribution point for injecting workspace context
into a run. Prefer a \`context\` **hook** or a module \`context\` handler today — those
are the active, wired paths:

\`\`\`ts
crew.handleEvent("context", async (event) => ({
  context: \`Active branch policy: \${event.cwd} deploys from main only.\`
}));
\`\`\`

Check \`crewcoder extension list\` output for what your installed CrewCoder build
actually loads before depending on a contribution point.`
  }
];

export function queryCrewCoderExtensionDocs(query: string): EmbeddedDoc[] {
  const lower = query.toLowerCase();
  return embeddedCrewCoderExtensionDocs.filter((doc) =>
    doc.title.toLowerCase().includes(lower) ||
    doc.summary.toLowerCase().includes(lower) ||
    doc.tags.some((tag) => lower.includes(tag) || tag.includes(lower))
  );
}

export function findCrewCoderExtensionDoc(id: string): EmbeddedDoc | undefined {
  const lower = id.trim().toLowerCase();
  return embeddedCrewCoderExtensionDocs.find((doc) => doc.id.toLowerCase() === lower);
}
