/**
 * Modes are explicit. There is no `auto` mode and no keyword routing: whatever the
 * caller asks for is what runs. `general` is the default.
 */
export type AgentMode = "general" | "plugin" | "extension";
/**
 * Retained as a distinct name because the loop/prompt layers talk about the *resolved*
 * mode, but every `AgentMode` is now directly resolvable.
 */
export type ResolvedAgentMode = AgentMode;
export type PluginKind =
  | "static-panel"
  | "typescript-panel"
  | "repo-indexer"
  | "workspace-writer"
  | "mock-agent"
  | "http-agent"
  | "openai-agent"
  | "exec-agent"
  | "mcp"
  | "browser-action"
  | "git-lens"
  | "mission-widget";
export interface AgentRequest { prompt: string; requestedMode: AgentMode; cwd: string; externalDirectories?: string[]; images?: string[]; }
export interface AgentResponse { mode: ResolvedAgentMode; summary: string; activatedSkills: string[]; notes: string[]; }
