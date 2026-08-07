export const CREWCODE_V0_CONSTRAINTS = [
  "CrewCode plugins are local-first extensions loaded from ~/.crewcode/plugins.",
  "Every plugin requires crewcode.plugin.json.",
  "Current supported crewcode.apiVersion is 0.1.",
  "Plugin UI is loaded as static assets through the CrewCode plugin protocol.",
  "Plugin UI runs in a sandboxed iframe.",
  "Plugin UI never receives window.electronAPI.",
  "workspace:listFiles and workspace:readFile require workspace:read.",
  "workspace:writeFile requires workspace:write.",
  "network:fetch is denied from plugin iframes.",
  "secrets:get is denied from plugin iframes.",
  "MCP server contributions are manifest declarations; CrewCode owns lifecycle.",
  "Agent provider contributions are manifest declarations; CrewCode owns bridge lifecycle.",
  "Panel entries must be relative paths inside the plugin folder.",
  "Remote SSH workspaces are denied for plugin API v0."
];

export const SUPPORTED_CONTRIBUTION_POINTS = [
  "tabs",
  "sidebarPanels",
  "statusItems",
  "editorActions",
  "chatActions",
  "chatHeaderItems",
  "commands",
  "mcpServers",
  "agentProviders",
  "gitLenses",
  "missionWidgets",
  "terminalWatchers",
  "browserActions"
];

export const SUPPORTED_PROVIDER_RUNTIMES = [
  "mock",
  "exec",
  "http",
  "sse-http",
  "openai-compatible",
  "stdio-jsonrpc",
  "websocket"
];
