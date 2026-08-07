import { createSkill } from "../types.js";

export const crewcodeSkills = [
  createSkill("crewcode.plugin.manifest", "Generate and validate CrewCode plugin manifests.", ["manifest", "crewcode.plugin.json", "contributes", "apiVersion"]),
  createSkill("crewcode.plugin.permissions", "Select minimum safe plugin permissions.", ["permission", "workspace:read", "workspace:write", "terminal:spawn", "network:fetch", "secrets"]),
  createSkill("crewcode.plugin.browser-api", "Use crewcode-plugin-api safely.", ["crewcode-plugin-api", "listFiles", "readFile", "writeFile", "onContext"]),
  createSkill("crewcode.plugin.ui-panel", "Generate static or bundled panel UI plugins.", ["panel", "tab", "sidebarPanel", "statusItem", "iframe"]),
  createSkill("crewcode.plugin.provider", "Generate agent provider plugins.", ["agent provider", "exec", "http", "openai-compatible", "stdio-jsonrpc", "websocket"]),
  createSkill("crewcode.plugin.mcp", "Generate MCP server declaration plugins.", ["mcp", "tool server"]),
  createSkill("crewcode.plugin.git-lens", "Generate git lens and review plugins.", ["git lens", "gitLenses", "risk lens", "diff"]),
  createSkill("crewcode.plugin.browser-action", "Generate browser action plugins.", ["browser action", "browserActions"]),
  createSkill("crewcode.plugin.security", "Enforce sandbox, protocol, and permission safety.", ["security", "sandbox", "electronAPI", "network", "secrets"]),
  createSkill("crewcode.plugin.packaging", "Validate, install, and package local-first plugins.", ["package", "install", "dev", "validate"]),
  createSkill("crewcode.self.plugin-generation", "Generate a plugin that exposes CrewCoder itself as a CrewCode provider.", ["crewcoder", "self", "provider plugin"])
];
