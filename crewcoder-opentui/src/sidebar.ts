import { DISABLED_TASKS, type CrewTaskSnapshot } from "@onpoint-dev-tools/crewcoder-tui-core/state/crew-tasks";
import type { TuiState } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { clampSidebarWidth, MIN_SIDEBAR_TERMINAL_WIDTH, sidebarWidth } from "./sidebar-model.js";

/** Reads the crew task store for a workspace (tui-core `readCrewTaskSnapshot`). */
export type TaskReader = (cwd: string) => Promise<CrewTaskSnapshot>;
/** `<branch>[*]` for a workspace (tui-core `readGitLabelAsync`). */
export type GitLabelReader = (cwd: string) => Promise<string | undefined>;

/** How often the open sidebar rereads the task store; the agent writes it from another process. */
export const TASK_POLL_MS = 1000;

type SidebarHost = {
  readonly state: TuiState;
  changed(): void;
};

/**
 * Sidebar display state for one UI instance: open or closed, the dragged
 * width, the crew task snapshot, and refreshing the git label after runs.
 * Instance-local by design; nothing here is saved or shared.
 */
export class SidebarController {
  open = false;
  /** Width set by dragging the divider; undefined uses the default for the terminal. */
  preferredWidth: number | undefined;
  /** Undefined when tasks cannot be read here (remote SSH workspaces). */
  tasks: CrewTaskSnapshot | undefined;
  /** Wired by cli.tsx for local workspaces; undefined leaves `state.gitLabel` as it is. */
  gitLabelReader: GitLabelReader | undefined;
  private readonly host: SidebarHost;
  private readonly readTasks: TaskReader | null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private taskSignature = "";
  private terminalWidth = Number.POSITIVE_INFINITY;

  constructor(host: SidebarHost, readTasks: TaskReader | null) {
    this.host = host;
    this.readTasks = readTasks;
    this.tasks = readTasks ? DISABLED_TASKS : undefined;
  }

  /** Columns the sidebar takes in this terminal: 0 when closed or too narrow. */
  columns(terminalWidth: number): number {
    this.terminalWidth = terminalWidth;
    return this.open ? sidebarWidth(terminalWidth, this.preferredWidth) : 0;
  }

  /** True when the sidebar is open but the terminal is too narrow to show it. */
  get hiddenByWidth(): boolean {
    return this.open && this.terminalWidth < MIN_SIDEBAR_TERMINAL_WIDTH;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    if (open) {
      void this.refreshTasks();
      this.startPolling();
    } else {
      this.stopPolling();
    }
    this.host.changed();
  }

  /** The divider was dragged; `width` is the sidebar's new width in columns. */
  resize(width: number, terminalWidth: number): void {
    const next = clampSidebarWidth(width, terminalWidth);
    if (next === this.preferredWidth) return;
    this.preferredWidth = next;
    this.host.changed();
  }

  /** Reread the task store; renders only when something changed. Failures leave the last snapshot. */
  async refreshTasks(): Promise<void> {
    if (!this.readTasks) return;
    let snapshot: CrewTaskSnapshot;
    try {
      snapshot = await this.readTasks(this.host.state.cwd);
    } catch {
      return;
    }
    const signature = JSON.stringify(snapshot);
    if (signature === this.taskSignature) return;
    this.taskSignature = signature;
    this.tasks = snapshot;
    this.host.changed();
  }

  /** After a run: the branch may have moved and the tree is likely dirty now. */
  async refreshGitLabel(): Promise<void> {
    const reader = this.gitLabelReader;
    if (!reader) return;
    const label = await reader(this.host.state.cwd).catch(() => this.host.state.gitLabel);
    if (label === this.host.state.gitLabel) return;
    this.host.state.gitLabel = label;
    this.host.changed();
  }

  dispose(): void {
    this.stopPolling();
  }

  private startPolling(): void {
    if (this.timer || !this.readTasks) return;
    this.timer = setInterval(() => void this.refreshTasks(), TASK_POLL_MS);
    this.timer.unref?.();
  }

  private stopPolling(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
