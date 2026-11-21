import type { PaletteCommand } from "./palette-model.js";

/**
 * Palette and menu items carry what selecting them does in their id:
 * - a slash command (`/thinking on`) is submitted as if typed;
 * - `draft:<text>` puts `<text>` in the composer for the user to finish
 *   (commands that need an argument, such as `/remember <fact>`).
 */
export const DRAFT_PREFIX = "draft:";

const command = (id: string, description: string, group: string): PaletteCommand => ({ id, label: id, description, group });
const draft = (name: string, description: string, group: string): PaletteCommand =>
  ({ id: `${DRAFT_PREFIX}${name} `, label: name, description, group });

/**
 * The `/` palette: every command OpenTUI implements. Aliases (`/resume`,
 * `/mode`, `/worker`, `/followup`) work when typed but are not listed twice.
 */
export const SLASH_COMMANDS: readonly PaletteCommand[] = [
  command("/new", "Start a fresh session", "Session"),
  command("/sessions", "Browse and resume previous sessions", "Session"),
  command("/branch", "Fork this conversation into a new session", "Session"),
  command("/rewind", "Restore workspace files to a checkpoint", "Session"),
  command("/compact", "Compact the saved session now", "Session"),
  command("/compact preview", "Edit the proposed compaction summary, then apply", "Session"),
  command("/compact auto", "Automatic compaction on, off, or status", "Session"),
  command("/export", "Export the session to HTML (default <session>.html)", "Session"),
  command("/goal", "Start or check a durable goal", "Session"),
  command("/reload", "Reload CrewCoder config, providers, and workers", "Session"),
  command("/clear", "Clear the conversation from the screen", "Session"),
  command("/stop", "Stop the active run", "Session"),
  command("/provider", "Pick a configured provider", "Settings"),
  command("/model", "Pick a model for the active provider", "Settings"),
  command("/effort", "Pick reasoning effort for this model", "Settings"),
  command("/modes", "Pick a mode or saved worker", "Settings"),
  command("/workers", "Pick a mode or saved worker (alias of /modes)", "Settings"),
  command("/prompts", "Pick a custom system prompt", "Settings"),
  command("/tool-mode", "Tool mode for new sessions", "Settings"),
  command("/profile", "Standalone or CrewCode-integrated behavior", "Settings"),
  command("/theme", "Pick a color theme (previews as you move)", "Settings"),
  command("/thinking", "Provider reasoning on, off, or status", "Settings"),
  command("/identity", "Worker identity in prompts on, off, or status", "Settings"),
  command("/full-access", "Approval bypass for this session on or off", "Settings"),
  command("/checkpoints", "Automatic checkpoints on, off, or status", "Settings"),
  command("/memory", "Project memory on, off, status, or list", "Settings"),
  draft("/remember", "Save a project fact (needs /memory on)", "Settings"),
  command("/set-budget", "Token budget for this session", "Settings"),
  draft("/add-dir", "Grant an external directory to this session", "Settings"),
  command("/remove-dir", "Revoke an external directory grant", "Settings"),
  command("/commands", "Insert a saved prompt command", "Content"),
  command("/skills", "Attach a skill to your next message", "Content"),
  command("/extensions", "List CrewCoder extensions", "Content"),
  command("/plugins", "List CrewCode app plugin templates", "Content"),
  command("/diff", "Review this session's file changes in Hunk", "Review & Tasks"),
  command("/review-summary", "Git branch, changed files, and issue refs", "Review & Tasks"),
  command("/why", "Explain the agent's last decision", "Review & Tasks"),
  command("/task", "Tasks for this instance: on, off, status, list, add", "Review & Tasks"),
  command("/approve", "Approve the pending tool call", "Review & Tasks"),
  command("/deny", "Deny the pending tool call", "Review & Tasks"),
  command("/approve-plan", "Approve the current CrewCoder-mode plan", "Review & Tasks"),
  draft("/follow-up", "Queue a message for the active run", "Review & Tasks"),
  command("/handoff", "Hand off this session to a worker", "Workers"),
  command("/teams", "List worker teams from crewcoder.json", "Workers"),
  draft("/crew", "Run workers in order, live: /crew <worker1,worker2> <task>", "Workers"),
  draft("/team", "Run a declared team, live: /team <team> <task>", "Workers"),
  command("/sidebar", "Show or hide the right sidebar (Ctrl+B)", "General"),
  command("/file-changes", "Modified files in the sidebar: on, off, or status", "General"),
  command("/find", "Search the transcript: /find [text] (Ctrl+F)", "General"),
  command("/repaint", "Redraw the whole screen if it looks garbled (alias /redraw)", "General"),
  command("/quit", "Exit CrewCoder (same as Ctrl+C)", "General"),
  command("/help", "Show this command list", "General")
];

/** Commands listed only under the `crewcode` integration profile (as in the legacy UI). */
const CREWCODE_ONLY = new Set(["/plugins"]);

/** The palette for an integration profile. */
export function paletteCommands(profile: "standalone" | "crewcode"): PaletteCommand[] {
  return SLASH_COMMANDS.filter((item) => profile === "crewcode" || !CREWCODE_ONLY.has(item.id));
}

/** Config-backed switches: config key, backend default, and wording. */
export const CONFIG_TOGGLES = {
  "/thinking": { key: "thinkingEnabled", defaultOn: true, label: "Provider thinking" },
  "/identity": { key: "workerIdentityEnabled", defaultOn: false, label: "Worker identity" },
  "/checkpoints": { key: "checkpointsEnabled", defaultOn: false, label: "Automatic checkpoints" },
  "/compact auto": { key: "autoCompact", defaultOn: true, label: "Automatic compaction" }
} as const;

export type ConfigToggle = keyof typeof CONFIG_TOGGLES;

/** Whether a config-backed switch is on, using the backend's normalization. */
export function configToggleOn(name: ConfigToggle, config: Record<string, unknown>): boolean {
  const toggle = CONFIG_TOGGLES[name];
  const value = config[toggle.key];
  return toggle.defaultOn ? value !== false : value === true;
}

/** on / off / status, with the current state marked when known. */
export function toggleMenu(name: string, current?: boolean, extra: PaletteCommand[] = []): PaletteCommand[] {
  return [
    { id: `${name} on`, label: "on", current: current === true },
    { id: `${name} off`, label: "off", current: current === false },
    { id: `${name} status`, label: "status", description: "Show the current setting" },
    ...extra
  ];
}

export const TASK_MENU_EXTRAS: readonly PaletteCommand[] = [
  { id: "/task list", label: "list", description: "List tasks for this project" },
  { id: `${DRAFT_PREFIX}/task add `, label: "add…", description: "Add a task" }
];

export const MEMORY_MENU_EXTRAS: readonly PaletteCommand[] = [
  { id: "/memory list", label: "list", description: "List remembered facts" }
];

export const BUDGET_MENU: readonly PaletteCommand[] = [
  { id: "/set-budget status", label: "status", description: "Show this session's budget" },
  { id: `${DRAFT_PREFIX}/set-budget `, label: "set…", description: "Set a budget, e.g. 200k or 1.5m" },
  { id: "/set-budget off", label: "off", description: "Clear the budget (unbounded)" }
];

export const GOAL_MENU: readonly PaletteCommand[] = [
  { id: `${DRAFT_PREFIX}/goal `, label: "start…", description: "Type an objective; flags: --max-turns N --check-model M --timeout-minutes N" },
  { id: "/goal status", label: "status", description: "The latest goal" },
  { id: "/goal list", label: "list", description: "Goals in this workspace" },
  { id: "/goal logs", label: "logs", description: "Recent goal events" }
];
