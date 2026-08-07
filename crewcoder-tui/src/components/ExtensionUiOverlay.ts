import type { Component, KeyEvent, RenderContext } from "../tui/component.js";
import type { TuiEventBlock } from "../state/tui-store.js";
import { bg, bold, fg, reset, visibleLength } from "../tui/ansi.js";
import { emptyLine, padRight, truncate, wrapText } from "../tui/layout.js";
import { renderExtensionUiErrorBlock } from "./ExtensionUiErrorBlock.js";
import { renderMarkdown } from "./markdown-renderer.js";

type ExtensionUiBlock = Extract<TuiEventBlock, { type: "extension_ui" }>;

type OverlayOption = { label: string; description?: string };

/**
 * One rendered line of the option list, tagged with the option it belongs to.
 * `leading` marks the first line of an option, which is the only row that shows
 * the selection bullet.
 */
type OptionRow = { option: number; text: string; kind: "label" | "description" | "spacer"; leading: boolean };

/** Lines the footer occupies: one blank separator plus the hint row. */
const FOOTER_HEIGHT = 2;
/** Upper bound on how tall the modal may ask to be before the App clamps it. */
const MAX_DESIRED_HEIGHT = 30;
const MAX_MESSAGE_LINES = 6;
const MAX_COMPONENT_LINES = 8;

/**
 * Focused popup that answers a trusted extension's `ctx.ui.confirm/input/select`
 * request. Mirrors ApprovalOverlay: it is live control-channel state, not a
 * passive log. `onResolve` receives the raw response written back over the
 * `ui_response` control channel — boolean for confirm, string for input/select,
 * or null to cancel.
 *
 * Question text, option labels, and option descriptions all wrap to the modal
 * width. Agent-authored questions are frequently a full sentence and their
 * options carry a rationale, so truncating either to a single row hid the part
 * the user needs in order to choose.
 */
export class ExtensionUiOverlay implements Component {
  private selected = 0;
  private value: string;
  /** Rendered line index -> selectable option index, for mouse clicks. */
  private selectableRows = new Map<number, number>();

  constructor(
    private readonly request: ExtensionUiBlock,
    private readonly onResolve: (value: string | boolean | null) => void
  ) {
    this.value = request.defaultValue ?? "";
  }

  render(ctx: RenderContext): string[] {
    try {
      const width = ctx.size.width;
      const lines: string[] = [];
      this.selectableRows = new Map();

      for (const line of wrapText(this.request.title, width)) {
        lines.push(padRight(`${fg(ctx.theme.accent)}${bold()}${line}${reset()}`, width));
      }
      lines.push(padRight(`${fg(ctx.theme.muted)}[${this.request.extensionId}] ${this.request.uiKind}${reset()}`, width));

      if (this.request.message) {
        lines.push(emptyLine(width));
        for (const line of wrapText(this.request.message, width).slice(0, MAX_MESSAGE_LINES)) {
          lines.push(padRight(`${fg(ctx.theme.text)}${line}${reset()}`, width));
        }
      }

      lines.push(emptyLine(width));
      const bodyHeight = Math.max(1, ctx.size.height - lines.length - FOOTER_HEIGHT);
      if (this.request.uiKind === "confirm") this.renderConfirm(ctx, lines);
      else if (this.request.uiKind === "select") this.renderSelect(ctx, lines, bodyHeight);
      else if (this.request.uiKind === "component") this.renderComponent(ctx, lines, bodyHeight);
      else this.renderInput(ctx, lines);

      while (lines.length < ctx.size.height - FOOTER_HEIGHT) lines.push(emptyLine(width));
      lines.push(emptyLine(width));
      lines.push(padRight(`${fg(ctx.theme.muted)}${this.footerHint()}${reset()}`, width));
      return lines.slice(0, ctx.size.height);
    } catch (error) {
      return renderExtensionUiErrorBlock(ctx, this.request.extensionId, error);
    }
  }

  /**
   * Height the modal needs at `width`. Measured from the wrapped content rather
   * than a per-kind constant, so a long question or verbose option descriptions
   * grow the box instead of being clipped by it.
   */
  desiredHeight(width = 60): number {
    try {
      const safeWidth = Math.max(8, width);
      let height = wrapText(this.request.title, safeWidth).length + 1;
      if (this.request.message) height += 1 + Math.min(MAX_MESSAGE_LINES, wrapText(this.request.message, safeWidth).length);
      height += 1 + FOOTER_HEIGHT;

      if (this.request.uiKind === "confirm") height += 2;
      else if (this.request.uiKind === "select") height += optionRows(this.request.options ?? [], safeWidth).length || 1;
      else if (this.request.uiKind === "component") height += this.componentBodyHeight(safeWidth) + 1 + optionRows(this.componentActionOptions(), safeWidth).length;
      else height += 1;

      return Math.min(MAX_DESIRED_HEIGHT, height);
    } catch {
      return 14;
    }
  }

  handleInput(event: KeyEvent): boolean {
    try {
      if (event.name === "mouse" && event.mouse?.kind === "press") return this.handleMouse(event.mouse.y - 1);
      if (this.request.uiKind === "confirm") return this.handleConfirm(event);
      if (this.request.uiKind === "select") return this.handleSelect(event);
      if (this.request.uiKind === "component") return this.handleComponent(event);
      return this.handleTextInput(event);
    } catch (error) {
      return true;
    }
  }


  private handleMouse(row: number): boolean {
    const index = this.selectableRows.get(row);
    if (index === undefined) return true;
    this.selected = index;
    if (this.request.uiKind === "confirm") this.onResolve(index === 0);
    else if (this.request.uiKind === "select") this.onResolve(this.request.options?.[index]?.value ?? null);
    else if (this.request.uiKind === "component") this.onResolve(this.componentActionOptions()[index]?.id ?? "close");
    return true;
  }

  /**
   * Draws a windowed option list. Every line of an option maps back to that
   * option so a click on a wrapped description row still selects it.
   */
  private renderOptionList(ctx: RenderContext, lines: string[], options: OverlayOption[], bodyHeight: number): void {
    const width = ctx.size.width;
    const rows = optionRows(options, width);
    const start = optionWindowStart(rows, this.selected, bodyHeight);
    for (const row of rows.slice(start, start + bodyHeight)) {
      if (row.kind === "spacer") {
        lines.push(emptyLine(width));
        continue;
      }
      const active = row.option === this.selected;
      this.selectableRows.set(lines.length, row.option);
      const text = `${active && row.leading ? "●" : " "} ${row.text}`;
      if (row.kind === "label" && active) {
        lines.push(`${bg(ctx.theme.accent)}${fg(ctx.theme.background)}${bold()}${padRight(text, width)}${reset()}`);
      } else if (row.kind === "label") {
        lines.push(padRight(`${fg(ctx.theme.text)}${text}${reset()}`, width));
      } else {
        lines.push(padRight(`${fg(active ? ctx.theme.text : ctx.theme.subtle)}${text}${reset()}`, width));
      }
    }
  }

  // ── confirm ──────────────────────────────────────────────────────────────
  private renderConfirm(ctx: RenderContext, lines: string[]): void {
    this.selectableRows.set(lines.length, 0);
    lines.push(this.renderAction(ctx, 0, "Yes", "confirm"));
    this.selectableRows.set(lines.length, 1);
    lines.push(this.renderAction(ctx, 1, "No", "decline"));
  }

  private handleConfirm(event: KeyEvent): boolean {
    if (event.name === "up" || event.name === "left") { this.selected = 0; return true; }
    if (event.name === "down" || event.name === "right") { this.selected = 1; return true; }
    if (event.name === "y") { this.onResolve(true); return true; }
    if (event.name === "n") { this.onResolve(false); return true; }
    if (event.name === "return") { this.onResolve(this.selected === 0); return true; }
    return true;
  }

  // ── select ───────────────────────────────────────────────────────────────
  private renderSelect(ctx: RenderContext, lines: string[], bodyHeight: number): void {
    const options = this.request.options ?? [];
    if (options.length === 0) {
      lines.push(padRight(`${fg(ctx.theme.muted)}(no options provided)${reset()}`, ctx.size.width));
      return;
    }
    this.renderOptionList(ctx, lines, options, bodyHeight);
  }

  private handleSelect(event: KeyEvent): boolean {
    const options = this.request.options ?? [];
    if (options.length === 0) {
      if (event.name === "return") this.onResolve(null);
      return true;
    }
    if (event.name === "up") { this.selected = (this.selected - 1 + options.length) % options.length; return true; }
    if (event.name === "down") { this.selected = (this.selected + 1) % options.length; return true; }
    if (event.name === "return") { this.onResolve(options[this.selected]?.value ?? null); return true; }
    return true;
  }

  // ── component ────────────────────────────────────────────────────────────
  private renderComponent(ctx: RenderContext, lines: string[], bodyHeight: number): void {
    const actions = this.componentActionOptions();
    const actionHeight = optionRows(actions, ctx.size.width).length;
    const contentHeight = Math.max(1, bodyHeight - actionHeight - 1);
    const component = this.request.component;

    if (!component) {
      lines.push(padRight(`${fg(ctx.theme.muted)}(component payload unavailable)${reset()}`, ctx.size.width));
    } else if (component.kind === "markdown") {
      for (const line of renderMarkdown(component.text, ctx.size.width, ctx).slice(0, contentHeight)) {
        lines.push(padRight(`${fg(ctx.theme.text)}${line.text}${reset()}`, ctx.size.width));
      }
    } else if (component.kind === "details") {
      this.renderDetails(ctx, lines, component.items.slice(0, MAX_COMPONENT_LINES), contentHeight);
    } else if (component.kind === "table") {
      this.renderTable(ctx, lines, component);
    } else {
      for (const line of describeActions(component.actions.slice(0, MAX_COMPONENT_LINES), ctx.size.width).slice(0, contentHeight)) {
        lines.push(padRight(`${fg(ctx.theme.text)}${line}${reset()}`, ctx.size.width));
      }
    }

    lines.push(emptyLine(ctx.size.width));
    if (actions.length) this.renderOptionList(ctx, lines, actions, actionHeight);
  }

  private renderDetails(ctx: RenderContext, lines: string[], items: Array<{ label: string; value: string }>, contentHeight: number): void {
    let budget = contentHeight;
    for (const item of items) {
      if (budget <= 0) break;
      const indent = " ".repeat(visibleLength(item.label) + 2);
      const wrapped = wrapText(item.value, Math.max(8, ctx.size.width - indent.length));
      lines.push(padRight(`${fg(ctx.theme.accent2)}${item.label}${reset()}  ${fg(ctx.theme.text)}${wrapped[0] ?? ""}${reset()}`, ctx.size.width));
      budget -= 1;
      for (const line of wrapped.slice(1)) {
        if (budget <= 0) break;
        lines.push(padRight(`${indent}${fg(ctx.theme.text)}${line}${reset()}`, ctx.size.width));
        budget -= 1;
      }
    }
  }

  private renderTable(ctx: RenderContext, lines: string[], component: Extract<ExtensionUiBlock["component"], { kind: "table" }>): void {
    const columns = component.columns.slice(0, 4);
    if (!columns.length) {
      lines.push(padRight(`${fg(ctx.theme.muted)}(no columns)${reset()}`, ctx.size.width));
      return;
    }
    const columnWidth = Math.max(6, Math.floor(ctx.size.width / columns.length));
    const header = columns.map((column) => truncate(column.label, columnWidth - 1).padEnd(columnWidth)).join("");
    lines.push(padRight(`${fg(ctx.theme.accent2)}${bold()}${header}${reset()}`, ctx.size.width));
    for (const row of component.rows.slice(0, 6)) {
      const text = columns.map((column) => truncate(String(row[column.key] ?? ""), columnWidth - 1).padEnd(columnWidth)).join("");
      lines.push(padRight(`${fg(ctx.theme.text)}${text}${reset()}`, ctx.size.width));
    }
  }

  private componentBodyHeight(width: number): number {
    const component = this.request.component;
    if (!component) return 1;
    if (component.kind === "markdown") return Math.min(MAX_COMPONENT_LINES, wrapText(component.text, width).length);
    if (component.kind === "details") return Math.min(MAX_COMPONENT_LINES, component.items.length) * 2;
    if (component.kind === "table") return Math.min(6, component.rows.length) + 1;
    return describeActions(component.actions.slice(0, MAX_COMPONENT_LINES), width).length;
  }

  private handleComponent(event: KeyEvent): boolean {
    const actions = this.componentActionOptions();
    if (event.name === "up" && actions.length) { this.selected = (this.selected - 1 + actions.length) % actions.length; return true; }
    if (event.name === "down" && actions.length) { this.selected = (this.selected + 1) % actions.length; return true; }
    if (event.name === "return") { this.onResolve(actions[this.selected]?.id ?? "close"); return true; }
    return true;
  }

  private componentActionOptions(): Array<{ id: string; label: string; description?: string }> {
    if (this.request.actions?.length) return this.request.actions;
    if (this.request.component?.kind === "actionList") return this.request.component.actions;
    return [{ id: "close", label: "Close" }];
  }

  // ── input ────────────────────────────────────────────────────────────────
  private renderInput(ctx: RenderContext, lines: string[]): void {
    const shown = this.value.length > 0
      ? `${fg(ctx.theme.text)}${this.value}${reset()}`
      : `${fg(ctx.theme.muted)}${this.request.placeholder ?? "type a value…"}${reset()}`;
    lines.push(padRight(`${fg(ctx.theme.accent)}›${reset()} ${shown}${fg(ctx.theme.accent)}▌${reset()}`, ctx.size.width));
  }

  private handleTextInput(event: KeyEvent): boolean {
    if (event.name === "return") { this.onResolve(this.value); return true; }
    if (event.name === "backspace") { this.value = this.value.slice(0, -1); return true; }
    if (event.sequence && event.sequence.length === 1 && !event.ctrl && !event.meta) {
      this.value += event.sequence;
      return true;
    }
    return true;
  }

  private footerHint(): string {
    if (this.request.uiKind === "confirm") return "y yes   n no   ↑↓ choose   ↵ select   esc cancel";
    if (this.request.uiKind === "select") return "↑↓ choose   ↵ select   esc cancel";
    if (this.request.uiKind === "component") return "↑↓ choose action   ↵ run action   esc cancel";
    return "type a value   ↵ submit   esc cancel";
  }

  private renderAction(ctx: RenderContext, index: number, label: string, hint: string): string {
    const width = ctx.size.width;
    const active = this.selected === index;
    const text = `${active ? "●" : " "} ${label}  ${hint}`;
    if (active) return `${bg(ctx.theme.accent)}${fg(ctx.theme.background)}${bold()}${padRight(text, width)}${reset()}`;
    // Keep the inactive row on the same column as the bulleted active row.
    return padRight(`  ${fg(index === 0 ? ctx.theme.success : ctx.theme.danger)}${label}${reset()}  ${fg(ctx.theme.muted)}${hint}${reset()}`, width);
  }
}

/**
 * Expands options into wrapped display rows: the bullet + label, then the
 * description indented beneath it, then a blank separator between options.
 */
function optionRows(options: OverlayOption[], width: number): OptionRow[] {
  const bulletWidth = 2;
  const descriptionIndent = 4;
  const rows: OptionRow[] = [];
  options.forEach((option, index) => {
    if (index > 0) rows.push({ option: -1, text: "", kind: "spacer", leading: false });
    const labelLines = wrapText(option.label, Math.max(1, width - bulletWidth));
    labelLines.forEach((line, lineIndex) => {
      rows.push({ option: index, text: line, kind: "label", leading: lineIndex === 0 });
    });
    if (!option.description) return;
    for (const line of wrapText(option.description, Math.max(1, width - descriptionIndent))) {
      rows.push({ option: index, text: `${" ".repeat(descriptionIndent - bulletWidth)}${line}`, kind: "description", leading: false });
    }
  });
  return rows;
}

/** Scrolls the option list so the whole selected option stays visible. */
function optionWindowStart(rows: OptionRow[], selected: number, height: number): number {
  if (rows.length <= height) return 0;
  const first = rows.findIndex((row) => row.option === selected);
  if (first < 0) return 0;
  let last = first;
  while (last + 1 < rows.length && rows[last + 1]!.option === selected) last += 1;
  const start = last >= height ? Math.min(last - height + 1, rows.length - height) : 0;
  return Math.max(0, Math.min(start, first));
}

function describeActions(actions: Array<{ label: string; description?: string }>, width: number): string[] {
  const lines: string[] = [];
  for (const action of actions) {
    const wrapped = wrapText(action.description ? `${action.label} — ${action.description}` : action.label, Math.max(1, width - 2));
    wrapped.forEach((line, index) => lines.push(`${index === 0 ? "•" : " "} ${line}`));
  }
  return lines;
}
