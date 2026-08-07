import type { Component, KeyEvent, RenderContext } from "../tui/component.js";
import { bg, bold, fg, reset } from "../tui/ansi.js";
import { emptyLine, padRight } from "../tui/layout.js";

export type GoalDraft = {
  objective: string;
  maxTurns: number;
  checkModel?: string;
  timeoutMinutes: number;
};

type Field = "objective" | "maxTurns" | "checkModel" | "timeoutMinutes";

const FIELDS: Array<{ key: Field; label: string; hint: string }> = [
  { key: "objective", label: "Objective", hint: "stopping contract and required validation" },
  { key: "maxTurns", label: "Max turns", hint: "supervisor cycles · 1–10000" },
  { key: "checkModel", label: "Check model", hint: "same provider · blank disables verifier" },
  { key: "timeoutMinutes", label: "Timeout", hint: "wall-clock minutes · 1–43200" }
];

export class GoalOverlay implements Component {
  private selected = 0;
  private cursor = 0;
  private error = "";
  private values: Record<Field, string>;

  constructor(
    defaults: { maxTurns: number; checkModel?: string; timeoutMinutes: number },
    private readonly provider: string,
    private readonly model: string,
    private readonly onSubmit: (draft: GoalDraft) => void
  ) {
    this.values = {
      objective: "",
      maxTurns: String(defaults.maxTurns),
      checkModel: defaults.checkModel ?? "",
      timeoutMinutes: String(defaults.timeoutMinutes)
    };
  }

  desiredHeight(): number { return 13; }

  render(ctx: RenderContext): string[] {
    const width = ctx.size.width;
    const lines = [
      padRight(`${fg(ctx.theme.accent)}${bold()}Start durable goal${reset()}`, width),
      padRight(`${fg(ctx.theme.muted)}maker ${this.provider}/${this.model} · settings apply only to this goal${reset()}`, width),
      emptyLine(width)
    ];

    for (let index = 0; index < FIELDS.length; index++) {
      const field = FIELDS[index]!;
      const active = index === this.selected;
      const marker = active ? `${fg(ctx.theme.accent)}›${reset()}` : " ";
      const labelColor = active ? ctx.theme.text : ctx.theme.muted;
      const label = `${marker} ${fg(labelColor)}${field.label.padEnd(12)}${reset()}`;
      const value = this.renderValue(field.key, active, ctx);
      lines.push(padRight(`${label} ${value}`, width));
      lines.push(padRight(`  ${fg(ctx.theme.subtle)}${field.hint}${reset()}`, width));
    }

    if (this.error) lines.push(padRight(`${fg(ctx.theme.danger)}${this.error}${reset()}`, width));
    else lines.push(emptyLine(width));
    lines.push(padRight(`${fg(ctx.theme.muted)}tab/↑↓ fields   ↵ next/start   ^S start   esc cancel${reset()}`, width));
    while (lines.length < ctx.size.height) lines.push(emptyLine(width));
    return lines.slice(0, ctx.size.height);
  }

  handleInput(event: KeyEvent): boolean {
    if (event.ctrl && event.name === "s") { this.submit(); return true; }
    if (event.name === "tab" || event.name === "down") { this.select(Math.min(FIELDS.length - 1, this.selected + 1)); return true; }
    if (event.name === "up") { this.select(Math.max(0, this.selected - 1)); return true; }
    if (event.name === "return") {
      if (this.selected === FIELDS.length - 1) this.submit();
      else this.select(this.selected + 1);
      return true;
    }
    if (event.name === "mouse" && event.mouse?.kind === "press") {
      const index = Math.floor((event.mouse.y - 4) / 2);
      if (index >= 0 && index < FIELDS.length) this.select(index);
      return true;
    }
    if (event.name === "backspace") { this.deleteBackward(); return true; }
    if (event.name === "delete") { this.deleteForward(); return true; }
    if (event.name === "left") { this.cursor = Math.max(0, this.cursor - 1); return true; }
    if (event.name === "right") { this.cursor = Math.min(this.currentValue().length, this.cursor + 1); return true; }
    if (event.name === "home") { this.cursor = 0; return true; }
    if (event.name === "end") { this.cursor = this.currentValue().length; return true; }
    if (event.sequence?.length === 1 && !event.ctrl && !event.meta) { this.insert(event.sequence); return true; }
    return true;
  }

  private select(index: number): void {
    this.selected = index;
    this.cursor = this.currentValue().length;
    this.error = "";
  }

  private currentKey(): Field { return FIELDS[this.selected]!.key; }
  private currentValue(): string { return this.values[this.currentKey()]; }

  private insert(fragment: string): void {
    const key = this.currentKey();
    const value = this.values[key];
    this.values[key] = value.slice(0, this.cursor) + fragment + value.slice(this.cursor);
    this.cursor += fragment.length;
    this.error = "";
  }

  private deleteBackward(): void {
    if (this.cursor === 0) return;
    const key = this.currentKey();
    const value = this.values[key];
    this.values[key] = value.slice(0, this.cursor - 1) + value.slice(this.cursor);
    this.cursor -= 1;
    this.error = "";
  }

  private deleteForward(): void {
    const key = this.currentKey();
    const value = this.values[key];
    if (this.cursor >= value.length) return;
    this.values[key] = value.slice(0, this.cursor) + value.slice(this.cursor + 1);
    this.error = "";
  }

  private submit(): void {
    const objective = this.values.objective.trim();
    const maxTurns = parseBoundedInteger(this.values.maxTurns, 10_000);
    const timeoutMinutes = parseBoundedInteger(this.values.timeoutMinutes, 43_200);
    if (!objective) { this.error = "Objective is required."; this.selectWithError(0); return; }
    if (maxTurns === undefined) { this.error = "Max turns must be an integer from 1 to 10000."; this.selectWithError(1); return; }
    if (timeoutMinutes === undefined) { this.error = "Timeout must be an integer from 1 to 43200 minutes."; this.selectWithError(3); return; }
    const checkModel = this.values.checkModel.trim();
    this.onSubmit({ objective, maxTurns, timeoutMinutes, ...(checkModel ? { checkModel } : {}) });
  }

  private selectWithError(index: number): void {
    const error = this.error;
    this.select(index);
    this.error = error;
  }

  private renderValue(key: Field, active: boolean, ctx: RenderContext): string {
    const value = this.values[key];
    if (!active) return `${fg(value ? ctx.theme.text : ctx.theme.subtle)}${value || "(disabled)"}${reset()}`;
    const before = value.slice(0, this.cursor);
    const current = value[this.cursor] ?? " ";
    const after = value.slice(this.cursor + (this.cursor < value.length ? 1 : 0));
    return `${fg(ctx.theme.text)}${before}${reset()}${bg(ctx.theme.accent)}${fg(ctx.theme.background)}${current}${reset()}${fg(ctx.theme.text)}${after}${reset()}`;
  }
}

function parseBoundedInteger(value: string, maximum: number): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : undefined;
}
