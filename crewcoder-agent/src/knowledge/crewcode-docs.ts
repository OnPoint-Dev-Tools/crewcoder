export interface EmbeddedDoc {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  /**
   * Full buildable reference. Loaded ONLY when the model calls the `docs` tool, so
   * depth here is free until it is actually requested; the system prompt carries just
   * `title` + `summary`.
   *
   * Ground this in `/CrewCode/examples/plugins` and CrewCode's `docs/plugins.md` so it
   * stays re-derivable rather than invented. Optional so a doc can be index-only.
   */
  content?: string;
}

export const embeddedCrewCodeDocs: EmbeddedDoc[] = [
  {
    id: "plugins",
    title: "CrewCode plugins overview",
    summary:
      "Local-first plugin platform using crewcode.plugin.json, static assets, explicit permissions, contribution points, isolated iframes, and crewcode-plugin-api. Loaded from ~/.crewcode/plugins.",
    tags: ["plugin", "manifest", "permissions", "contributes", "iframe", "provider", "mcp", "getting started", "build a plugin"],
    content: `# Building a CrewCode plugin

A CrewCode plugin extends the **CrewCode desktop app**. It is NOT a CrewCoder
extension. Different manifest, different install root, different runtime.

Plugins load from \`~/.crewcode/plugins\`.

## Minimum viable plugin

\`\`\`txt
my-panel/
├── crewcode.plugin.json
├── panel.html
├── plugin.js
└── crewcode-plugin-api.js   # vendored helper
\`\`\`

\`crewcode.plugin.json\`:

\`\`\`json
{
  "id": "my-panel",
  "name": "My Panel",
  "version": "0.1.0",
  "description": "Starter panel.",
  "crewcode": { "apiVersion": "0.1" },
  "permissions": ["workspace:read"],
  "contributes": {
    "tabs": [
      { "id": "main", "title": "My Panel", "icon": "grid", "entry": "panel.html", "singleton": true }
    ],
    "sidebarPanels": [
      { "id": "sidebar", "title": "My Panel", "icon": "sidebar", "entry": "panel.html" }
    ]
  }
}
\`\`\`

\`panel.html\` — plain static HTML. Load the API helper before your script:

\`\`\`html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>My Panel</title></head>
<body>
  <button id="refresh">refresh files</button>
  <pre id="output">waiting for context…</pre>
  <script src="crewcode-plugin-api.js"></script>
  <script src="plugin.js"></script>
</body>
</html>
\`\`\`

\`plugin.js\`:

\`\`\`js
const out = document.getElementById('output')

window.crewcode.onContext(ctx => {
  out.textContent = JSON.stringify({
    source: ctx.openContext?.source,
    workspace: ctx.workspace?.name,
    root: ctx.workspace?.root
  }, null, 2)
})

async function loadSnapshot() {
  try {
    const result = await window.crewcode.workspace.listFiles()
    const files = result.files || []
    out.textContent = files.slice(0, 80).join('\\n') || 'no files found'
  } catch (err) {
    out.textContent = \`plugin request failed: \${err.message}\`
  }
}

document.getElementById('refresh').addEventListener('click', loadSnapshot)
void loadSnapshot()
\`\`\`

## Build it

\`\`\`bash
crewcoder plugin list-templates
crewcoder plugin create my-panel --kind static-panel
crewcoder plugin validate ./my-panel
crewcoder plugin test ./my-panel --workspace ~/code/some-repo
\`\`\`

Then copy the folder into \`~/.crewcode/plugins\` and reload CrewCode.

## Hard v0 rules

- \`crewcode.apiVersion\` is \`"0.1"\`
- Plugin UI is **static assets** loaded through the CrewCode plugin protocol
- Plugin UI runs in a **sandboxed iframe** and never receives \`window.electronAPI\`
- \`network:fetch\` and \`secrets:get\` are **denied from iframes**
- Panel \`entry\` must be a relative path inside the plugin folder
- Remote SSH workspaces are denied in plugin API v0`
  },
  {
    id: "plugin-manifest",
    title: "CrewCode plugin manifest and contribution points",
    summary:
      "Contribution points: tabs, sidebarPanels, statusItems, editorActions, chatActions, chatHeaderItems, commands, mcpServers, agentProviders, gitLenses, missionWidgets, terminalWatchers, browserActions.",
    tags: ["manifest", "contributes", "tabs", "sidebarpanels", "statusitems", "editoractions", "chatactions", "gitlenses", "missionwidgets", "terminalwatchers", "browseractions", "contribution point"],
    content: `# crewcode.plugin.json reference

## Shape

\`\`\`json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "What it does.",
  "crewcode": { "apiVersion": "0.1" },
  "permissions": ["workspace:read", "workspace:write"],
  "contributes": { }
}
\`\`\`

## Contribution points

| Point | Purpose |
|---|---|
| \`tabs\` | Full workspace tab panel |
| \`sidebarPanels\` | Sidebar panel |
| \`statusItems\` | Status bar entry, can open a sidebar panel |
| \`editorActions\` | Action in the code editor |
| \`chatActions\` | Action on a chat message |
| \`chatHeaderItems\` | Item in the chat header |
| \`commands\` | Named command in the palette |
| \`mcpServers\` | Declare a local MCP server |
| \`agentProviders\` | Declare an agent provider runtime |
| \`gitLenses\` | Git/diff review lens |
| \`missionWidgets\` | Mission dashboard widget |
| \`terminalWatchers\` | React to terminal pane output |
| \`browserActions\` | Action on the built-in browser tab |

## Panel-bearing entries

\`tabs\`, \`sidebarPanels\`, and most action points take an \`entry\`:

\`\`\`json
"tabs": [
  { "id": "main", "title": "My Panel", "icon": "grid", "entry": "panel.html", "singleton": true }
],
"sidebarPanels": [
  { "id": "sidebar", "title": "My Panel", "icon": "sidebar", "entry": "panel.html" }
],
"statusItems": [
  { "id": "status", "title": "My Plugin", "text": "ready", "icon": "plug", "sidebarPanel": "sidebar" }
],
"commands": [
  { "id": "refresh", "title": "My Plugin: Refresh", "icon": "refresh" }
]
\`\`\`

\`entry\` **must be a relative path inside the plugin folder**. Absolute paths and
parent traversal are rejected.

\`singleton: true\` means one instance of the tab at a time.

## Open context

Panels receive \`ctx.openContext\`, which is intentionally minimal and fully optional:

\`\`\`ts
ctx.openContext.source   // "editor-action" | "git-lens" | "browser-action" | ...
ctx.openContext.filePath
ctx.openContext.browserUrl
ctx.openContext.terminalPaneId
ctx.openContext.chatMessageId
\`\`\`

Browser actions receive the live BrowserTab URL, terminal watchers receive the clicked
pane id, chat actions receive the latest message/turn id when available. Treat every
field as optional.

## Validate

\`\`\`bash
crewcoder plugin validate ./my-plugin
\`\`\``
  },
  {
    id: "plugin-permissions",
    title: "CrewCode plugin permissions and the browser API",
    summary:
      "workspace:read gates listFiles/readFile, workspace:write gates writeFile. agent:provider, mcp:server, terminal:spawn, network:fetch gate contributions. network:fetch and secrets:get are always denied from iframes.",
    tags: ["permissions", "workspace:read", "workspace:write", "network:fetch", "secrets", "terminal:spawn", "agent:provider", "mcp:server", "crewcode-plugin-api", "browser api", "oncontext", "security", "sandbox"],
    content: `# Permissions and the browser API

## Permission table

Iframe capability methods:

| Permission | Methods |
|---|---|
| \`workspace:read\` | \`workspace:listFiles\`, \`workspace:readFile\` |
| \`workspace:write\` | \`workspace:writeFile\` |

Contribution-gate permissions:

| Permission | Gates |
|---|---|
| \`agent:provider\` | Registering agent providers |
| \`mcp:server\` | Registering local MCP server commands |
| \`terminal:spawn\` | Required by \`exec\` and \`stdio-jsonrpc\` provider runtimes |
| \`network:fetch\` | Required by \`http\`, \`sse-http\`, \`openai-compatible\`, \`websocket\` provider runtimes |

Declared but not yet exposed as general iframe capabilities: \`git:read\`,
\`git:write\`, \`terminal:read\`, \`agent:prompt\`, \`browser:read\`, \`secrets:read\`.

## Explicitly reserved (denied from iframes)

- \`network:fetch\` — denied from plugin iframes **even when the permission is
  declared**. Provider runtimes are the current safe network path.
- \`secrets:get\` — denied from plugin iframes even when \`secrets:read\` is declared.
  Use CLI auth, local endpoints, or provider \`apiKeyEnv\`.

Declare the **minimum** set. A statically valid manifest that omits a permission the
code actually needs is the most common runtime failure — \`crewcoder plugin test\`
exists specifically to catch that mismatch.

## Browser API

Plugin UI is sandboxed and does not receive \`window.electronAPI\`. Use the plugin
browser API:

\`\`\`ts
import { crewcode } from 'crewcode-plugin-api'

crewcode.onContext(ctx => {
  console.log(ctx.workspace?.name)
  console.log(ctx.openContext.source)
})

const { files } = await crewcode.workspace.listFiles()
const file = await crewcode.workspace.readFile('src/App.tsx')
await crewcode.workspace.writeFile('notes/plugin.txt', 'hello')
\`\`\`

In no-build plugins the same surface is on \`window.crewcode\` after loading the
vendored \`crewcode-plugin-api.js\`.

\`packages/crewcode-plugin-api\` is the official v0 API source. No-build templates
vendor its canonical \`browser/crewcode-plugin-api.js\`; bundled TypeScript templates
vendor the typed source until the package is published.

## Always handle failure

Capability calls reject when the permission is missing. Never let that surface as a
blank panel:

\`\`\`js
try {
  const { files } = await window.crewcode.workspace.listFiles()
} catch (err) {
  out.textContent = \`plugin request failed: \${err.message}\`
}
\`\`\``
  },
  {
    id: "plugin-providers",
    title: "Building agent provider plugins",
    summary:
      "agentProviders declare a runtime (mock, exec, http, sse-http, openai-compatible, stdio-jsonrpc, websocket) plus endpoint/command, apiKeyEnv, responsePath, and models. CrewCode owns the bridge lifecycle.",
    tags: ["agent provider", "agentproviders", "provider", "openai-compatible", "exec", "http", "sse-http", "stdio-jsonrpc", "websocket", "mock", "runtime", "responsepath", "apikeyenv"],
    content: `# Building an agent provider plugin

Provider contributions are **manifest declarations**. CrewCode owns the bridge
lifecycle; your plugin does not spawn or manage the connection.

## Runtimes

\`mock\`, \`exec\`, \`http\`, \`sse-http\`, \`openai-compatible\`, \`stdio-jsonrpc\`, \`websocket\`

| Runtime family | Extra permission |
|---|---|
| \`exec\`, \`stdio-jsonrpc\` | \`terminal:spawn\` |
| \`http\`, \`sse-http\`, \`openai-compatible\`, \`websocket\` | \`network:fetch\` |

All of them additionally need \`agent:provider\`.

## OpenAI-compatible gateway

\`\`\`json
{
  "id": "openai-compatible-provider",
  "name": "OpenAI Compatible Provider",
  "version": "0.1.0",
  "description": "Template for gateways exposing the OpenAI chat completions shape.",
  "crewcode": { "apiVersion": "0.1" },
  "permissions": ["agent:provider", "network:fetch"],
  "contributes": {
    "tabs": [
      { "id": "main", "title": "OpenAI Compatible", "icon": "bot", "entry": "panel.html", "singleton": true }
    ],
    "agentProviders": [
      {
        "id": "local-openai-compatible",
        "title": "OpenAI Compatible Agent",
        "runtime": "openai-compatible",
        "description": "POSTs to /v1/chat/completions and reads choices[0].message.content.",
        "endpoint": "http://localhost:4000/v1",
        "apiKeyEnv": "OPENAI_COMPATIBLE_API_KEY",
        "timeoutMs": 90000,
        "maxOutputBytes": 524288,
        "responsePath": "choices.0.message.content",
        "models": ["local-default"]
      }
    ]
  }
}
\`\`\`

## Field notes

| Field | Meaning |
|---|---|
| \`runtime\` | Transport family |
| \`endpoint\` | Base URL for network runtimes |
| \`command\` / \`args\` | Executable for \`exec\` / \`stdio-jsonrpc\` |
| \`apiKeyEnv\` | Env var name holding the key. Never inline the key |
| \`responsePath\` | Dotted path to the reply text in the response body |
| \`timeoutMs\` | Per-request timeout |
| \`maxOutputBytes\` | Response cap |
| \`models\` | Selectable model ids |

**Never hardcode an API key in the manifest.** \`apiKeyEnv\` names an environment
variable; \`secrets:get\` is denied from iframes precisely so keys do not flow through
plugin code.

## Request payload

Providers receive:

\`\`\`json
{
  "prompt": "user prompt text",
  "cwd": "/active/workspace/path",
  "model": "company-default",
  "provider": "plugin-id:provider-id"
}
\`\`\``
  },
  {
    id: "plugin-mcp",
    title: "Building MCP server plugins",
    summary:
      "mcpServers contributions are manifest declarations of a local stdio MCP server command; CrewCode owns spawning and routing. Requires the mcp:server permission.",
    tags: ["mcp", "mcpservers", "mcp:server", "tool server", "stdio", "model context protocol"],
    content: `# Building an MCP server plugin

\`mcpServers\` entries are **declarations**. CrewCode owns spawning and routing.

\`\`\`json
{
  "id": "mcp-server-template",
  "name": "MCP Server Template",
  "version": "0.1.0",
  "description": "Starter for declaring a local MCP server from a CrewCode plugin.",
  "crewcode": { "apiVersion": "0.1" },
  "permissions": ["mcp:server", "workspace:read"],
  "contributes": {
    "tabs": [
      { "id": "main", "title": "MCP Template", "icon": "terminal", "entry": "panel.html", "singleton": true }
    ],
    "mcpServers": [
      {
        "id": "local-context",
        "title": "Local Context MCP",
        "command": "node",
        "args": ["server.mjs"],
        "category": "context",
        "description": "Example stdio MCP server. Replace server.mjs with your tools."
      }
    ]
  }
}
\`\`\`

## Field notes

| Field | Meaning |
|---|---|
| \`id\` | Server id within the plugin |
| \`title\` | Display name |
| \`command\` / \`args\` | Executable that speaks MCP over stdio |
| \`category\` | Grouping hint, e.g. \`context\` |
| \`description\` | Shown in server listings |

\`args\` paths resolve inside the plugin folder, so \`server.mjs\` ships with the plugin.

Requires \`mcp:server\`. If your server binary needs to be spawned as a terminal
process in your setup, you also need \`terminal:spawn\`.

Your \`server.mjs\` is an ordinary MCP stdio server — the plugin manifest only tells
CrewCode how to start it.`
  },
  {
    id: "plugin-templates",
    title: "CrewCode plugin templates",
    summary:
      "Starting points: static-panel, typescript-panel, repo-indexer, workspace-writer, mock-agent, http-agent, openai-agent, exec-agent, mcp, browser-action, git-lens, mission-widget.",
    tags: ["templates", "static-panel", "typescript-panel", "agent-provider", "mcp", "git-lens", "scaffold", "plugin create", "list-templates"],
    content: `# Plugin templates

\`\`\`bash
crewcoder plugin list-templates
crewcoder plugin create my-panel --kind static-panel
\`\`\`

## Kinds and their source templates

| \`--kind\` | Template |
|---|---|
| \`static-panel\` | \`static-panel-template\` |
| \`typescript-panel\` | \`typescript-panel-template\` |
| \`repo-indexer\` | \`repo-radar\` |
| \`workspace-writer\` | \`handoff-pack\` |
| \`mock-agent\` | \`mock-agent-provider\` |
| \`http-agent\` | \`company-agent-http-adapter\` |
| \`openai-agent\` | \`openai-compatible-provider\` |
| \`exec-agent\` | \`github-copilot-cli-provider\` |
| \`mcp\` | \`mcp-server-template\` |
| \`browser-action\` | \`browser-docs-grabber\` |
| \`git-lens\` | \`git-risk-lens\` |
| \`mission-widget\` | \`mission-ci-widget\` |

## Important limitation

Templates are copied from the CrewCode repo's \`examples/plugins\` directory, located
via \`discoverCrewCodeRepo()\`. **If the CrewCode repo is not found on disk, template
copying returns nothing** and creation falls back to a generated skeleton.

\`crewcoder plugin list-templates\` reports \`available\` vs \`fallback\` per kind — check
it before assuming a template will be used. When templates are unavailable, build from
the manifest references in these docs instead.

## Choosing

- Static HTML/CSS/JS panel → \`static-panel\`
- Bundled TypeScript/React panel → \`typescript-panel\`
- Read-only workspace analysis → \`repo-indexer\`
- Writes files back → \`workspace-writer\`
- Model gateway → \`openai-agent\` / \`http-agent\` / \`exec-agent\`
- Tool server → \`mcp\``
  },
  {
    id: "plugin-testing",
    title: "Validating and testing plugins",
    summary:
      "plugin validate does static manifest checks; plugin test executes the plugin in a sandboxed worker against API v0 and catches permission mismatches. The sandbox is a stub DOM, not a browser.",
    tags: ["validate", "test", "plugin test", "plugin validate", "permission mismatch", "sandbox", "limitations", "stub dom"],
    content: `# Validating and testing plugins

Two complementary commands.

## Static validation

\`\`\`bash
crewcoder plugin validate ./my-plugin
\`\`\`

Checks the manifest: \`crewcode.apiVersion\`, known contribution points, provider
runtimes, relative \`entry\` paths.

## Runtime testing

\`\`\`bash
crewcoder plugin test ./my-plugin --workspace ~/code/some-repo
\`\`\`

Executes the plugin in a sandboxed \`worker_threads\` host against plugin API v0. It
catches what only exists at runtime — above all a **permission mismatch**, where a
statically valid manifest omits a permission the code actually calls.

The worker runs with \`env: {}\` (untrusted code must not read your keys out of
\`process.env\`), a memory cap, and a per-entry timeout.

## The sandbox is a stub DOM, not a browser

Errors from browser APIs the stub does not implement are reported as
\`unsupported-dom-api\` / \`framework-panel-unsupported\` **warnings**, never errors,
against a deliberately narrow allowlist. Missing \`navigator.clipboard\` or
\`MutationObserver\` is a warning; \`myTypoedHelper is not defined\` stays a hard error.

## What a pass does and does not prove

Every report carries a \`limitations\` array. A pass proves **protocol and contract
conformance**. It never proves the panel renders correctly — there is no real browser,
no layout, no pixels.

## Contract fidelity

The harness mirrors CrewCode's real host contract **including exact error strings**.
If a denial message here differs from the real app, that is a harness bug: a plugin
author who learns the wrong contract from the test tool ships a broken plugin.`
  },
  {
    id: "plugins-v0",
    title: "CrewCode plugin platform v0 constraints",
    summary:
      "Implementation snapshot: no window.electronAPI, postMessage bridge, workspace read/write capabilities, reserved network/secrets, remote SSH denied, static asset loading through the plugin protocol.",
    tags: ["v0", "sandbox", "workspace", "security", "limitations", "electronapi", "postmessage", "remote ssh", "constraints"],
    content: `# Plugin platform v0 constraints

These are law in plugin mode. A plugin that violates one does not load or silently
fails at runtime.

\`\`\`txt
- crewcode.apiVersion is "0.1"
- Plugin UI is static assets loaded through the CrewCode plugin protocol
- Plugin UI runs in a sandboxed iframe
- Plugin UI never receives window.electronAPI
- workspace:listFiles and workspace:readFile require workspace:read
- workspace:writeFile requires workspace:write
- network:fetch is denied from plugin iframes
- secrets:get is denied from plugin iframes
- MCP server contributions are manifest declarations; CrewCode owns lifecycle
- Agent provider contributions are manifest declarations; CrewCode owns bridge lifecycle
- Panel entries must be relative paths inside the plugin folder
- Remote SSH workspaces are denied for plugin API v0
\`\`\`

## Why the iframe rules exist

The panel is untrusted third-party code running inside a desktop app with filesystem
and shell reach. The sandbox is the boundary. \`window.electronAPI\` would hand a panel
the whole host surface, so it is never injected — all host access goes through the
narrow, permission-checked \`crewcode-plugin-api\` bridge over \`postMessage\`.

\`network:fetch\` and \`secrets:get\` stay denied from iframes even when declared,
because a panel that can reach the network *and* read secrets is an exfiltration
primitive. Provider runtimes are the reviewed network path; \`apiKeyEnv\` is the
reviewed credential path.

## Architecture

\`\`\`txt
panel (sandboxed iframe)
  -> crewcode-plugin-api
  -> postMessage
  -> main process capability handler (permission check)
  -> workspace / provider / mcp
\`\`\``
  },
  {
    id: "plugin-examples",
    title: "CrewCode plugin examples",
    summary:
      "Bundled examples: repo-radar, codebase-graph-lite, handoff-pack, git-risk-lens, browser-docs-grabber, terminal-watchdog-lite, mission-ci-widget, mcp-server-template, and provider adapters.",
    tags: ["examples", "repo-indexer", "repo-radar", "risk-lens", "browser", "mission", "terminal", "handoff-pack", "codebase-graph-lite"],
    content: `# Bundled plugin examples

Real plugins under \`examples/plugins/\` in the CrewCode repo. Read these before
inventing a structure.

| Example | Demonstrates |
|---|---|
| \`static-panel-template\` | No-build HTML/CSS/JS starter panel |
| \`typescript-panel-template\` | TypeScript/React panel built to static assets |
| \`repo-radar\` | Read-only workspace scanner; heavy \`listFiles\`/\`readFile\` use |
| \`codebase-graph-lite\` | Tabs + sidebar + status items + editor/chat actions together |
| \`handoff-pack\` | \`workspace:write\` round trip |
| \`git-risk-lens\` | \`gitLenses\` review surface |
| \`browser-docs-grabber\` | \`browserActions\` against the live BrowserTab URL |
| \`terminal-watchdog-lite\` | \`terminalWatchers\` reacting to pane output |
| \`mission-ci-widget\` | \`missionWidgets\` dashboard entry |
| \`mcp-server-template\` | \`mcpServers\` stdio declaration |
| \`mock-agent-provider\` | \`mock\` provider runtime |
| \`company-agent-http-adapter\` | \`http\` provider runtime |
| \`openai-compatible-provider\` | \`openai-compatible\` runtime |
| \`github-copilot-cli-provider\` | \`exec\` runtime wrapping a CLI |

## Plugin categories in practice

Workspace panels, provider adapters, repo intelligence, terminal automation, browser
workflows, git policy, risk lenses, MCP connectors, theming, and mission widgets.

## Finding them

\`\`\`bash
crewcoder plugin list-templates    # shows resolved template paths and availability
\`\`\`

If the CrewCode repo is not on disk, these are unavailable locally — build from the
manifest references in the other plugin docs instead.`
  }
];

export function queryCrewCodeDocs(query: string): EmbeddedDoc[] {
  const lower = query.toLowerCase();
  return embeddedCrewCodeDocs.filter((doc) =>
    doc.title.toLowerCase().includes(lower) ||
    doc.summary.toLowerCase().includes(lower) ||
    doc.tags.some((tag) => lower.includes(tag) || tag.includes(lower))
  );
}

export function findCrewCodeDoc(id: string): EmbeddedDoc | undefined {
  const lower = id.trim().toLowerCase();
  return embeddedCrewCodeDocs.find((doc) => doc.id.toLowerCase() === lower);
}
