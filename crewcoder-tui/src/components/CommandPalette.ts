import type { Component, KeyEvent, RenderContext } from "../tui/component.js";
import type { ModalRow } from "./modal-view.js";
import { modalChromeHeight, modalRowAt, renderModalView } from "./modal-view.js";

export type CommandPaletteItem = {
  id: string;
  category: "Session" | "Settings" | "Content & Extensions" | "Review & Tasks" | "View" | "General" | "Modes" | "Workers" | "Extensions" | "Sessions";
  label: string;
  description: string;
  /** Extra searchable text which is not rendered. */
  keywords?: string[];
  action:
    | { type: "command"; command: string }
    | { type: "session"; sessionId: string }
    | { type: "extension"; extensionId: string };
};

export type CommandOption = {
  command: string;
  description: string;
};

type CommandCategory = {
  title: string;
  commands: CommandOption[];
};

/** Slash commands grouped in their display order. */
export const commandCategories: CommandCategory[] = [
  { title: "Session", commands: [
    ["/new", "Start a fresh CrewCoder session"], ["/sessions", "Browse previous CrewCoder sessions"],
    ["/resume", "Browse previous CrewCoder sessions (alias of /sessions)"],
    ["/branch", "Fork this conversation into a new session"], ["/rewind", "Restore workspace files to a checkpoint: /rewind latest|<id>"],
    ["/compact", "Compact the saved session after a run; auto: /compact on|off|status"],
    ["/compact preview", "Preview the proposed compaction summary before applying (alias /compact edit)"],
    ["/export", "Export the session to self-contained HTML: /export [path]"], ["/reload", "Reload CrewCoder home metadata"],
    ["/goal", "Open goal editor; inline: /goal --max-turns N --check-model MODEL --timeout-minutes N <objective>"]
  ] },
  { title: "Settings", commands: [
    ["/profile", "Pick standalone or CrewCode-integrated behavior for this project"],
    ["/provider", "Pick any configured built-in or extension provider"], ["/model", "Pick model for the active provider"],
    ["/effort", "Pick reasoning effort for this model"], ["/thinking", "Enable or disable provider reasoning: /thinking on|off|status"], ["/modes", "Pick mode or worker: general, plugin, extension, or a saved worker"],
    ["/workers", "Pick mode or worker (alias of /modes)"], ["/prompts", "Pick a custom system prompt"],
    ["/full-access", "Toggle approval bypass: /full-access on|off"],
    ["/checkpoints", "Enable or disable automatic checkpoints: /checkpoints on|off|status"],
    ["/file-changes", "Show or hide the file-changes panel: /file-changes on|off|status"],
    ["/memory", "Project-only memory (off by default): /memory on|off|status|list"],
    ["/remember", "Save a project fact: /remember <fact> (requires /memory on)"],
    ["/set-budget", "Set a token budget for this session: /set-budget 200k|off|status"],
    ["/add-dir", "Grant an external directory to this session: /add-dir <path>"],
    ["/remove-dir", "Revoke a session external directory; opens a picker when called without a path"]
  ] },
  { title: "Content & Extensions", commands: [
    ["/commands", "Insert a saved prompt command"],
    ["/skills", "Pick a skill to attach to your next message"], ["/extensions", "List CrewCoder extensions"],
    ["/plugins", "List CrewCode app plugin templates"]
  ] },
  { title: "Review & Tasks", commands: [
    ["/review-summary", "Show git branch, changed files, and issue refs"], ["/why", "Explain the agent's last decision in plain language"], ["/task", "Manage tasks: /task on, off, list, add, done"],
    ["/handoff", "Hand off the active transcript to another worker: /handoff worker:name [prompt]"],
    ["/crew", "Run named workers sequentially: /crew worker1,worker2 <task>"],
    ["/teams", "List worker teams declared in crewcoder.json"], ["/team", "Run a declared team: /team <team> <task>"],
    ["/approve", "Approve the latest pending tool call"], ["/deny", "Deny the latest pending tool call"],
    ["/follow-up", "Queue a message for the active run: /follow-up <message>"], ["/stop", "Stop the active run"]
  ] },
  { title: "View", commands: [
    ["/sidebar", "Toggle the workspace, modified files, and crew tasks sidebar (Ctrl+B); explicit: /sidebar on|off|status"],
    ["/repaint", "Force a full TUI repaint after terminal resize artifacts"], ["/redraw", "Alias for /repaint"], ["/clear", "Clear the viewport"]
  ] },
  { title: "General", commands: [["/help", "Show help for interactive commands"], ["/quit", "Exit CrewCoder TUI"]] }
].map(({ title, commands }) => ({ title, commands: commands.map(([command, description]) => ({ command, description })) }));

export const commandOptions: CommandOption[] = commandCategories.flatMap((category) => category.commands);

export function builtinPaletteItems(profile: "standalone" | "crewcode" = "standalone"): CommandPaletteItem[] {
  return commandCategories.flatMap((category) => category.commands
    .filter((option) => profile === "crewcode" || option.command !== "/plugins")
    .map((option) => ({
    id: `command:${option.command}`,
    category: category.title as CommandPaletteItem["category"],
    label: option.command,
    description: option.description,
    keywords: [category.title],
    action: { type: "command" as const, command: option.command }
  })));
}

type PaletteRow = ModalRow & { item?: CommandPaletteItem };
const CATEGORY_ORDER: CommandPaletteItem["category"][] = [
  "Session", "Settings", "Content & Extensions", "Review & Tasks", "View", "General",
  "Modes", "Workers", "Extensions", "Sessions"
];

export class CommandPalette implements Component {
  private selected = 0;
  private query = "/";
  private items: CommandPaletteItem[] = builtinPaletteItems();
  private lastHeight = 1;
  private hovered: number | undefined;

  constructor(
    private readonly onSelect?: (item: CommandPaletteItem) => void,
    private readonly onQueryChange?: (query: string) => void
  ) {
    this.selected = this.firstSelectable(this.rows());
  }

  setItems(items: CommandPaletteItem[]): void {
    this.items = items;
    this.selected = this.firstSelectable(this.rows());
  }

  setQuery(query: string): void {
    this.query = query || "/";
    const rows = this.rows();
    if (!this.isSelectable(rows, this.selected)) this.selected = this.firstSelectable(rows);
  }

  render(ctx: RenderContext): string[] {
    this.lastHeight = ctx.size.height;
    const rows = this.rows();
    return renderModalView(ctx, {
      title: "Commands",
      search: this.searchTerm(),
      placeholder: "Search commands, workers, modes, extensions, sessions",
      rows,
      selected: this.selected,
      hovered: this.hovered,
      footer: "↑↓ navigate   ↵ open   esc close",
      emptyText: `No palette items match ${this.query}`
    });
  }

  desiredHeight(): number {
    return Math.min(Math.max(this.rows().length, 1), 14) + modalChromeHeight({ search: true, footer: true });
  }

  private searchTerm(): string { return this.query.replace(/^\//, ""); }

  handleInput(event: KeyEvent): boolean {
    const rows = this.rows();
        if (event.name === "mouse" && event.mouse?.kind === "hover") {
          const index = modalRowAt(rows, this.selected, this.lastHeight, event.mouse.y, { search: true, footer: true });
          this.hovered = index !== undefined && rows[index]?.item ? index : undefined;
          return true;
        }
        if (event.name === "mouse" && event.mouse?.kind === "press") {
          const index = modalRowAt(rows, this.selected, this.lastHeight, event.mouse.y, { search: true, footer: true });
          if (index === undefined) return true;
          const item = rows[index]?.item;
          if (!item) return true;
          this.selected = index;
          this.hovered = undefined;
          this.onSelect?.(item);
          return true;
        }
        if (event.name === "wheelup" || event.name === "wheeldown") {
          this.hovered = undefined;
          if (!rows.some((row) => row.item)) return true;
          const direction = event.name === "wheelup" ? -1 : 1;
          for (let count = 0; count < 3; count++) this.selected = this.step(rows, this.selected, direction);
          return true;
        }
        if (event.name === "up") {
          this.hovered = undefined;
          if (!rows.some((row) => row.item)) return false;
          this.selected = this.step(rows, this.selected, -1);
          return true;
        }
        if (event.name === "down") {
          this.hovered = undefined;
          if (!rows.some((row) => row.item)) return false;
          this.selected = this.step(rows, this.selected, 1);
          return true;
        }
        if (event.name === "return") {
          const item = rows[this.selected]?.item;
          const query = this.query.trim();
          const exactQuery = normalizePaletteTerm(query);
          const exact = this.items.find((candidate) => normalizePaletteTerm(candidate.label) === exactQuery);
          if (exact) this.onSelect?.(exact);
          else if ((query.includes(" ") || !item) && query.startsWith("/")) {
            this.onSelect?.({ id: `command:${query}`, category: "General", label: query, description: "Typed command", action: { type: "command", command: query } });
          } else if (item) this.onSelect?.(item);
          return true;
        }
        if (event.name === "backspace") {
          this.query = this.query.length > 1 ? this.query.slice(0, -1) : "/";
          this.selected = this.firstSelectable(this.rows());
          this.onQueryChange?.(this.query);
          return true;
        }
        if (event.sequence?.length === 1 && !event.ctrl && !event.meta) {
          this.query += event.sequence;
          this.selected = this.firstSelectable(this.rows());
          this.onQueryChange?.(this.query);
          return true;
        }
        return false;
  }

  private rows(): PaletteRow[] {
    const query = this.searchTerm().trim();
    const ranked = this.items
      .map((item, index) => ({ item, index, score: fuzzyScore(query, searchableText(item)) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const rows: PaletteRow[] = [];
    // Keep categories grouped, but order those groups by their strongest match.
    // A fixed category order can bury an exact mode/worker/session match below
    // weak description or category matches outside the visible list.
    const matchedCategories = [...new Set(ranked.map((entry) => entry.item.category))]
      .sort((left, right) => {
        const leftScore = ranked.find((entry) => entry.item.category === left)?.score ?? -1;
        const rightScore = ranked.find((entry) => entry.item.category === right)?.score ?? -1;
        return rightScore - leftScore || CATEGORY_ORDER.indexOf(left) - CATEGORY_ORDER.indexOf(right);
      });
    for (const category of matchedCategories) {
      const matches = ranked.filter((entry) => entry.item.category === category);
      rows.push({ label: category, header: true });
      for (const { item } of matches) rows.push({ label: item.label, hint: item.description, item });
    }
    return rows;
  }

  private isSelectable(rows: PaletteRow[], index: number): boolean { return Boolean(rows[index]?.item); }
  private firstSelectable(rows: PaletteRow[]): number { const index = rows.findIndex((row) => row.item); return index === -1 ? 0 : index; }
  private step(rows: PaletteRow[], from: number, direction: 1 | -1): number {
    for (let i = from + direction; i >= 0 && i < rows.length; i += direction) if (rows[i]?.item) return i;
    return from;
  }
}

function normalizePaletteTerm(value: string): string {
  return value.trim().replace(/^\//, "").toLowerCase();
}

function searchableText(item: CommandPaletteItem): string {
  return [item.label, item.description, item.category, ...(item.keywords ?? [])].join(" ").toLowerCase();
}

/** A small deterministic fuzzy matcher: every query token must be a subsequence. */
export function fuzzyScore(query: string, candidate: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  let total = 0;
  for (const token of tokens) {
    const direct = candidate.indexOf(token);
    if (direct >= 0) { total += 200 - Math.min(direct, 100) + token.length * 4; continue; }
    let cursor = 0;
    let first = -1;
    let last = -1;
    for (const char of token) {
      const at = candidate.indexOf(char, cursor);
      if (at < 0) return -1;
      if (first < 0) first = at;
      last = at;
      cursor = at + 1;
    }
    total += 80 - Math.min(first, 40) - Math.max(0, last - first - token.length);
  }
  return total;
}
