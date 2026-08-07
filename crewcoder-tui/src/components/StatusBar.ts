import type { Component, RenderContext } from "../tui/component.js";
import type { TuiState } from "../state/tui-store.js";
import type { CrewCoderLiveUiPermissions } from "../bridge/live-ui-protocol.js";
import { bold, fg, reset } from "../tui/ansi.js";
import { padRight, truncate } from "../tui/layout.js";

export class StatusBar implements Component {
  constructor(private readonly state: TuiState) {}
  render(ctx: RenderContext): string[] {
    const statusFrame = this.statusFrameLines(ctx.size.width);
    if (statusFrame) return statusFrame;

    const inset = Math.min(2, Math.max(0, ctx.size.width));
    const safety = this.state.safetyPolicies.length ? pill("SAFETY:", safetySummary(this.state.safetyPolicies), ctx.theme.warning, ctx.theme.muted) : "";
    const liveUi = this.state.liveUiFocus ? pill("LIVE-UI:", liveUiSummary(this.state.liveUiFocus), ctx.theme.accent, ctx.theme.muted) : "";
    return [
      alignedStatusRow([safety, liveUi], ctx.size.width, inset, ctx.theme.accent),
      alignedStatusRow([], ctx.size.width, inset, ctx.theme.accent)
    ];
  }

  /**
   * If the focused live UI contribution targets surface: "status" and a composited
   * frame exists, return those frame lines padded to the status bar width. Falls
   * back to the LIVE-UI pill when no frame is available.
   */
  private statusFrameLines(width: number): string[] | undefined {
    const focus = this.state.liveUiFocus;
    if (!focus || focus.surface !== "status") return undefined;
    const frame = this.state.liveUiFrames?.get(focus.key);
    if (!frame || frame.length === 0) return undefined;
    return frame.map((line) => padRight(line, width));
  }
}

function pill(label: string, value: string, color: string, muted: string): string {
  return `${fg(muted)}${bold()}${label}${reset()} ${fg(color)}${value}${reset()}`;
}
function alignedStatusRow(parts: string[], width: number, inset: number, markerColor: string): string {
  const available = Math.max(0, width - inset * 2);
  const slots = 3;
  const slotWidth = Math.floor(available / slots);
  const filtered = parts.filter(Boolean);
  const present = filtered.length > slots
    ? [filtered[0]!, filtered[1]!, filtered.slice(2).join(` ${fg(markerColor)}•${reset()} `)]
    : filtered;
  const cells = present.map((part, index) => {
    const marker = index > 0 ? `${fg(markerColor)}•${reset()} ` : "";
    const text = `${marker}${part}`;
    const cellWidth = index === slots - 1 ? available - slotWidth * (slots - 1) : slotWidth;
    if (index === 1) return centerCell(text, cellWidth);
    if (index === 2) return rightCell(text, cellWidth);
    return padRight(text, cellWidth);
  });
  while (cells.length < slots) cells.push(" ".repeat(cells.length === slots - 1 ? available - slotWidth * (slots - 1) : slotWidth));
  return `${" ".repeat(inset)}${cells.join("")}${" ".repeat(inset)}`;
}

function centerCell(value: string, width: number): string {
  const clipped = visible(value) > width ? truncate(value, width) : value;
  const left = Math.floor(Math.max(0, width - visible(clipped)) / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(Math.max(0, width - left - visible(clipped)))}`;
}

function rightCell(value: string, width: number): string {
  const clipped = visible(value) > width ? truncate(value, width) : value;
  return `${" ".repeat(Math.max(0, width - visible(clipped)))}${clipped}`;
}

function spreadStatusParts(parts: string[], width: number, inset: number, markerColor: string): string {
  const available = Math.max(0, width - inset * 2);
  const present = parts.filter(Boolean);
  if (!present.length) return padRight("", width);

  const total = present.reduce((sum, part) => sum + visible(part), 0);
  let content: string;
  if (present.length > 1 && total + present.length - 1 <= available) {
    const spaces = available - total;
    const gaps = present.length - 1;
    const baseGap = Math.floor(spaces / gaps);
    let remainder = spaces % gaps;
    content = present.map((part, index) => {
      if (index === present.length - 1) return part;
      const gapWidth = baseGap + (remainder-- > 0 ? 1 : 0);
      const left = Math.floor((gapWidth - 1) / 2);
      const right = Math.max(0, gapWidth - left - 1);
      return `${part}${" ".repeat(left)}${fg(markerColor)}◈${reset()}${" ".repeat(right)}`;
    }).join("");
  } else {
    const marker = `${fg(markerColor)}◈${reset()}`;
    const fitted: string[] = [];
    for (const part of present) {
      const candidate = [...fitted, part].join(" ◈ ");
      if (visible(candidate) <= available) fitted.push(part);
    }
    content = fitted.join(` ${marker} `);
  }
  return `${" ".repeat(inset)}${padRight(content, available)}${" ".repeat(inset)}`;
}
function safetySummary(policies: TuiState["safetyPolicies"]): string {
  const blocks = policies.filter((policy) => policy.action === "block").length;
  const reviews = policies.filter((policy) => policy.action === "review").length;
  if (blocks && reviews) return `${policies.length} (${blocks} block/${reviews} review)`;
  if (blocks) return `${policies.length} (${blocks} block)`;
  if (reviews) return `${policies.length} (${reviews} review)`;
  return String(policies.length);
}
function liveUiSummary(focus: NonNullable<TuiState["liveUiFocus"]>): string {
  const perms = permissionBadges(focus.permissions);
  return `${focus.title} [${perms}]`;
}
function permissionBadges(permissions: CrewCoderLiveUiPermissions): string {
  const badges: string[] = [];
  const ui = permissions.ui ?? [];
  if (ui.includes("render")) badges.push("render");
  if (ui.includes("input")) badges.push("input");
  if (ui.includes("focus")) badges.push("focus");
  if (permissions.commands?.includes("ui_response")) badges.push("commands:ui_response");
  if (permissions.storage === "session") badges.push("storage:session");
  if (permissions.clipboard && permissions.clipboard !== "none") badges.push(`clipboard:${permissions.clipboard}`);
  if (permissions.network?.allowedHosts?.length) badges.push("network");
  return badges.length ? badges.join(" ") : "none";
}
function strip(value: string): string { return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); }
function visible(value: string): number { return strip(value).length; }
