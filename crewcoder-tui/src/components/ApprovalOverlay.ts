import type { Component, KeyEvent, RenderContext } from "../tui/component.js";
import type { TuiEventBlock } from "../state/tui-store.js";
import { bg, bold, fg, reset } from "../tui/ansi.js";
import { emptyLine, padRight, truncate, wrapText } from "../tui/layout.js";

type ApprovalBlock = Extract<TuiEventBlock, { type: "approval" }>;

export class ApprovalOverlay implements Component {
  private selected: 0 | 1 = 0;
  private actionRows: number[] = [];

  constructor(
    private readonly approval: ApprovalBlock,
    private readonly onResolve: (approved: boolean) => void
  ) {}

  render(ctx: RenderContext): string[] {
    const width = ctx.size.width;
    const lines: string[] = [];
    const riskColor = this.approval.risk === "dangerous" ? ctx.theme.danger : ctx.theme.warning;
    const tool = this.approval.toolName ?? "tool";
    const risk = this.approval.risk ?? "review";

    lines.push(spread(`${fg(riskColor)}${bold()}Approval required${reset()}`, `${fg(ctx.theme.muted)}esc${reset()}`, width));
    lines.push(padRight(`${fg(ctx.theme.warning)}${tool}${reset()} ${fg(ctx.theme.muted)}${risk}${reset()}`, width));
    lines.push(emptyLine(width));

    for (const line of wrapText(this.approval.text, Math.max(1, width - 2)).slice(0, 5)) {
      lines.push(padRight(`${fg(ctx.theme.text)}${line}${reset()}`, width));
    }

    const args = formatArgs(this.approval.args);
    if (args) {
      lines.push(emptyLine(width));
      for (const line of wrapText(args, Math.max(1, width - 2)).slice(0, 4)) {
        lines.push(padRight(`${fg(ctx.theme.subtle)}${line}${reset()}`, width));
      }
    }

    lines.push(emptyLine(width));
    this.actionRows = [lines.length, lines.length + 1];
    lines.push(this.renderAction(ctx, 0, "Approve", "run this tool"));
    lines.push(this.renderAction(ctx, 1, "Deny", "skip this tool"));

    while (lines.length < ctx.size.height - 2) lines.push(emptyLine(width));
    lines.push(emptyLine(width));
    lines.push(padRight(`${fg(ctx.theme.muted)}y approve   n deny   ↑↓ choose   ↵ select   esc keep pending${reset()}`, width));
    return lines.slice(0, ctx.size.height);
  }

  desiredHeight(): number {
    return 16;
  }

  handleInput(event: KeyEvent): boolean {
    if (event.name === "mouse" && event.mouse?.kind === "press") {
      const row = event.mouse.y - 1;
      const index = this.actionRows.indexOf(row);
      if (index < 0) return true;
      this.selected = index as 0 | 1;
      this.onResolve(index === 0);
      return true;
    }
    if (event.name === "up" || event.name === "left") {
      this.selected = 0;
      return true;
    }
    if (event.name === "down" || event.name === "right") {
      this.selected = 1;
      return true;
    }
    if (event.name === "y" || event.name === "a") {
      this.onResolve(true);
      return true;
    }
    if (event.name === "n" || event.name === "d") {
      this.onResolve(false);
      return true;
    }
    if (event.name === "return") {
      this.onResolve(this.selected === 0);
      return true;
    }
    return false;
  }

  private renderAction(ctx: RenderContext, index: 0 | 1, label: string, hint: string): string {
    const width = ctx.size.width;
    const active = this.selected === index;
    const text = `${active ? "●" : " "} ${label}  ${hint}`;
    if (active) return `${bg(ctx.theme.accent)}${fg(ctx.theme.background)}${bold()}${padRight(text, width)}${reset()}`;
    return padRight(`${fg(index === 0 ? ctx.theme.success : ctx.theme.danger)}${label}${reset()} ${fg(ctx.theme.muted)}${hint}${reset()}`, width);
  }
}

function formatArgs(args?: Record<string, unknown>): string {
  if (!args) return "";
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "";
  if (entries.length === 1 && typeof entries[0]?.[1] === "string") return String(entries[0][1]);
  return truncate(JSON.stringify(args), 320);
}

function spread(left: string, right: string, width: number): string {
  const plainLeft = stripAnsiLite(left);
  const plainRight = stripAnsiLite(right);
  const gap = Math.max(1, width - plainLeft.length - plainRight.length);
  return padRight(`${left}${" ".repeat(gap)}${right}`, width);
}

function stripAnsiLite(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
