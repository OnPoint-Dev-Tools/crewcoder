import type { Component, KeyEvent, RenderContext } from "../tui/component.js";
import { fg, reset } from "../tui/ansi.js";
import { emptyLine, padRight } from "../tui/layout.js";
import type { EffortLevel } from "../state/effort-levels.js";
import { effortLevelsForModel } from "../state/effort-levels.js";

export type EffortSelectHandler = (effort: EffortLevel) => void;

export class EffortOverlay implements Component {
  private readonly levels: EffortLevel[];
  private selected: number;

  constructor(provider: string, model: string, current: EffortLevel, private readonly onSelect: EffortSelectHandler) {
    this.levels = effortLevelsForModel(provider, model);
    this.selected = Math.max(0, this.levels.indexOf(current));
  }

  render(ctx: RenderContext): string[] {
    const lines: string[] = [];
    lines.push(padRight(`${fg(ctx.theme.accent)}Select reasoning effort:${reset()}`, ctx.size.width));
    lines.push(padRight(`${fg(ctx.theme.muted)}Enter to choose · Esc to close${reset()}`, ctx.size.width));
    lines.push(emptyLine(ctx.size.width));

    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i]!;
      const active = i === this.selected;
      const marker = active ? `${fg(ctx.theme.accent)}›${reset()}` : " ";
      const color = active ? ctx.theme.text : ctx.theme.muted;
      lines.push(padRight(`${marker} ${fg(color)}${level.padEnd(7)}${reset()} ${fg(ctx.theme.muted)}${description(level)}${reset()}`, ctx.size.width));
    }

    while (lines.length < ctx.size.height) lines.push(emptyLine(ctx.size.width));
    return lines.slice(0, ctx.size.height);
  }

  handleInput(event: KeyEvent): boolean {
    if (event.name === "mouse" && event.mouse?.kind === "press") {
      const index = event.mouse.y - 4;
      if (index < 0 || index >= this.levels.length) return true;
      this.selected = index;
      this.onSelect(this.levels[index]!);
      return true;
    }
    if (event.name === "up") { this.selected = Math.max(0, this.selected - 1); return true; }
    if (event.name === "down") { this.selected = Math.min(this.levels.length - 1, this.selected + 1); return true; }
    if (event.name === "return") {
      const level = this.levels[this.selected];
      if (level) this.onSelect(level);
      return true;
    }
    return false;
  }
}

function description(level: EffortLevel): string {
  if (level === "none") return "disable model reasoning";
  if (level === "low") return "fast, light thinking";
  if (level === "medium") return "balanced thinking";
  if (level === "high") return "deeper reasoning";
  return "maximum available reasoning";
}
