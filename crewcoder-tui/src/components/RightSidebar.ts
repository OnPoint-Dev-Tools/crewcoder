import type { Component, RenderContext } from "../tui/component.js";
import type { TuiCrewWorker, TuiState } from "../state/tui-store.js";
import { bg, bold, fg, reset } from "../tui/ansi.js";
import { horizontalRule, padRight, truncate, wrapText } from "../tui/layout.js";
import { spinnerFrame } from "./Spinner.js";
import { TaskWidget } from "./TaskWidget.js";

const SECTION_INSET = 2;

export class RightSidebar implements Component {
  private readonly taskWidget: TaskWidget;

  constructor(private readonly state: TuiState) {
    this.taskWidget = new TaskWidget(state);
  }

  render(ctx: RenderContext): string[] {
    const workspaceLines = this.renderWorkspace(ctx);
    const contentHeight = Math.max(0, ctx.size.height - workspaceLines.length);
    const statusLines = this.renderStatus(ctx);
    const fileLines = this.renderFileChanges(ctx);
    const agentLines = this.renderAgents(ctx);
    const topLines = statusLines.length ? [...statusLines, sidebarRule(ctx)] : [];
    const fixedLines = agentLines.length > 0
      ? [...topLines, ...fileLines, sidebarRule(ctx), ...agentLines, sidebarRule(ctx)]
      : [...topLines, ...fileLines, sidebarRule(ctx)];
    const remainingHeight = Math.max(0, contentHeight - fixedLines.length);
    const taskLines = remainingHeight > 0
      ? this.taskWidget.render({ ...ctx, size: { width: ctx.size.width, height: remainingHeight } })
      : [];
    const content = [...fixedLines, ...taskLines].slice(0, contentHeight);
    while (content.length < contentHeight) content.push("");
    const lines = [...content, ...workspaceLines].slice(0, ctx.size.height);
    while (lines.length < ctx.size.height) lines.push("");
    return lines.map((line) => paintSidebarLine(line, ctx));
  }

  private renderStatus(ctx: RenderContext): string[] {
    const lines: string[] = [];
    if (this.state.safetyPolicies.length) {
      lines.push(...statusDetailLines("SAFETY", safetySummary(this.state.safetyPolicies), ctx.theme.warning, ctx));
    }
    const focus = this.state.liveUiFocus;
    if (focus) {
      lines.push(...statusDetailLines("LIVE UI", liveUiSummary(focus), ctx.theme.accent2, ctx));
      if (focus.surface === "status") {
        const frame = this.state.liveUiFrames?.get(focus.key) ?? [];
        const available = Math.max(1, ctx.size.width - SECTION_INSET * 2);
        lines.push(...frame.slice(0, 2).map((line) => sidebarText(truncate(line, available), ctx.theme.text)));
      }
    }
    return lines.length ? [sectionHeading("STATUS", String(Number(this.state.safetyPolicies.length > 0) + Number(Boolean(focus))), ctx), ...lines] : [];
  }

  private renderWorkspace(ctx: RenderContext): string[] {
    const location = this.state.remoteTarget
      ? `${this.state.remoteTarget}:${this.state.cwd}`
      : shortCwd(this.state.cwd);
    const workspace = `${location}:${this.state.gitLabel ?? "local"}`;
    const available = Math.max(1, ctx.size.width - SECTION_INSET * 2);
    const workspaceLines = wrapText(workspace, available).map((line) => sidebarText(line, this.state.gitLabel ? ctx.theme.text : ctx.theme.muted));
    return [
      sidebarRule(ctx),
      ...workspaceLines,
      "",
      brandLine(ctx)
    ];
  }

  private renderAgents(ctx: RenderContext): string[] {
    const hasLiveCrew = this.state.crewWorkers.some((worker) => worker.status === "running" || worker.status === "pending");
    if (!hasLiveCrew) return [];

    const workers = prioritizedWorkers(this.state.crewWorkers);
    const activeNames = workers.filter((worker) => worker.status === "running").map((worker) => worker.name);
    const summary = activeNames.length > 0 ? activeNames.join(", ") : "waiting";
    const lineBudget = Math.max(2, Math.min(8, Math.floor(ctx.size.height * 0.25)));
    const lines = [sectionHeading("AGENTS:", summary, ctx)];
    let visibleWorkers = 0;
    for (const worker of workers) {
      const workerLines = renderWorkerLines(worker, ctx);
      if (lines.length + workerLines.length > lineBudget) break;
      lines.push(...workerLines);
      visibleWorkers += 1;
    }
    if (workers.length > visibleWorkers && lines.length < lineBudget) lines.push(sidebarText(`… ${workers.length - visibleWorkers} more`, ctx.theme.muted));
    return lines;
  }

  private renderFileChanges(ctx: RenderContext): string[] {
    const files = this.state.changedFiles;
    const headingCount = this.state.showFileChanges ? String(files.length) : "off";
    const lines = [sectionHeading("MODIFIED FILES", headingCount, ctx)];

    if (!this.state.showFileChanges) {
      lines.push(sidebarText("Display disabled", ctx.theme.muted));
      lines.push(sidebarText("/file-changes on", ctx.theme.subtle));
      return lines;
    }
    if (!files.length) {
      lines.push(sidebarText("✓ No file changes", ctx.theme.success));
      return lines;
    }

    const lineBudget = Math.max(3, Math.min(9, Math.floor(ctx.size.height * 0.3)));
    let firstVisibleFile = files.length;
    for (let index = files.length - 1; index >= 0; index--) {
      const fileLines = renderWrappedItem(files[index]!, "●", ctx.theme.warning, ctx.theme.text, ctx);
      if (lines.length + fileLines.length > lineBudget) break;
      lines.splice(1, 0, ...fileLines);
      firstVisibleFile = index;
    }
    if (firstVisibleFile > 0 && lines.length < lineBudget) lines.push(sidebarText(`… ${firstVisibleFile} more`, ctx.theme.muted));
    return lines;
  }
}

function prioritizedWorkers(workers: TuiCrewWorker[]): TuiCrewWorker[] {
  const rank: Record<TuiCrewWorker["status"], number> = { running: 0, pending: 1, failed: 2, completed: 3 };
  return [...workers].sort((left, right) => rank[left.status] - rank[right.status]);
}

function renderWorkerLines(worker: TuiCrewWorker, ctx: RenderContext): string[] {
  const icon = worker.status === "running" ? spinnerFrame() : worker.status === "completed" ? "✓" : worker.status === "failed" ? "✕" : "□";
  const color = worker.status === "running" ? ctx.theme.accent2 : worker.status === "completed" ? ctx.theme.success : worker.status === "failed" ? ctx.theme.danger : ctx.theme.muted;
  const status = worker.status === "pending" ? "queued" : worker.status;
  const available = Math.max(1, ctx.size.width - SECTION_INSET - 2);
  const wrapped = wrapText(`${worker.name} ${status}`, available);
  return wrapped.map((line, index) => `${" ".repeat(SECTION_INSET)}${index === 0 ? `${fg(color)}${icon}${reset()} ` : "  "}${fg(index === 0 ? ctx.theme.text : ctx.theme.subtle)}${line}${reset()}`);
}

function renderWrappedItem(text: string, icon: string, iconColor: string, textColor: string, ctx: RenderContext): string[] {
  const available = Math.max(1, ctx.size.width - SECTION_INSET - 2);
  return wrapText(text, available).map((line, index) => `${" ".repeat(SECTION_INSET)}${index === 0 ? `${fg(iconColor)}${icon}${reset()} ` : "  "}${fg(textColor)}${line}${reset()}`);
}

function sectionHeading(label: string, count: string, ctx: RenderContext): string {
  const countWidth = count.length;
  const labelWidth = Math.max(1, ctx.size.width - SECTION_INSET * 2 - countWidth - 1);
  return `${" ".repeat(SECTION_INSET)}${fg(ctx.theme.accent)}${bold()}${truncate(label, labelWidth)}${reset()} ${fg(ctx.theme.muted)}${count}${reset()}`;
}

function sidebarText(text: string, color: string): string {
  return `${" ".repeat(SECTION_INSET)}${fg(color)}${text}${reset()}`;
}

function statusDetailLines(label: string, value: string, valueColor: string, ctx: RenderContext): string[] {
  const prefix = `${label}  `;
  const available = Math.max(1, ctx.size.width - SECTION_INSET * 2 - prefix.length);
  return wrapText(value, available).map((line, index) => index === 0
    ? `${" ".repeat(SECTION_INSET)}${fg(ctx.theme.muted)}${bold()}${label}${reset()}  ${fg(valueColor)}${line}${reset()}`
    : `${" ".repeat(SECTION_INSET + prefix.length)}${fg(valueColor)}${line}${reset()}`);
}

function safetySummary(policies: TuiState["safetyPolicies"]): string {
  const blocks = policies.filter((policy) => policy.action === "block").length;
  const reviews = policies.filter((policy) => policy.action === "review").length;
  if (blocks && reviews) return `${policies.length} · ${blocks} block · ${reviews} review`;
  if (blocks) return `${policies.length} · ${blocks} block`;
  if (reviews) return `${policies.length} · ${reviews} review`;
  return String(policies.length);
}

function liveUiSummary(focus: NonNullable<TuiState["liveUiFocus"]>): string {
  const permissions: string[] = [];
  permissions.push(...(focus.permissions.ui ?? []));
  if (focus.permissions.commands?.includes("ui_response")) permissions.push("respond");
  if (focus.permissions.storage === "session") permissions.push("session storage");
  if (focus.permissions.clipboard && focus.permissions.clipboard !== "none") permissions.push(`clipboard ${focus.permissions.clipboard}`);
  if (focus.permissions.network?.allowedHosts.length) permissions.push("network");
  return permissions.length ? `${focus.title} · ${permissions.join(" · ")}` : focus.title;
}

function brandLine(ctx: RenderContext): string {
  return `${" ".repeat(SECTION_INSET)}${fg(ctx.theme.accent2)}•${reset()} ${fg(ctx.theme.text)}${bold()}CrewCoder${reset()}`;
}

function shortCwd(cwd: string): string {
  const home = process.env.HOME;
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function sidebarRule(ctx: RenderContext): string {
  return horizontalRule(ctx.size.width, ctx.theme.border);
}

function paintSidebarLine(line: string, ctx: RenderContext): string {
  const repainted = line.replaceAll(reset(), `${reset()}${bg(ctx.theme.backgroundAlt)}`);
  return `${bg(ctx.theme.backgroundAlt)}${padRight(repainted, ctx.size.width)}${reset()}`;
}
