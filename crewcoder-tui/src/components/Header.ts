import type { Component, RenderContext } from "../tui/component.js";
import type { TuiState } from "../state/tui-store.js";
import { bold, fg, reset, visibleLength } from "../tui/ansi.js";
import { padRight, truncate } from "../tui/layout.js";
import { compactCrewCodeLogoLines, miniCrewCodeLogoLines } from "../theme/logo.js";

export class Header implements Component {
  constructor(_state?: TuiState) {}

  render(ctx: RenderContext): string[] {
    const w = ctx.size.width;
    const logo = w >= 58 ? compactCrewCodeLogoLines : miniCrewCodeLogoLines;
    const logoWidth = Math.max(...logo.map(visibleLength));
    const logoLines = logo.map((line) => {
      const brand = `${fg(ctx.theme.accent)}${line}${reset()}`;
      const gap = " ".repeat(logoWidth - visibleLength(line) + 3);
      return chromeLine(` ${brand}${gap}`, w);
    });
    const tagline = `${fg(ctx.theme.primary)}${bold()}Code with a Crew · Local Tools · Any Provider${reset()}`;

    return [
      ...logoLines,
      chromeLine(` ${tagline}`, w),
      accentRule(w, ctx)
    ];
  }
}


function accentRule(width: number, ctx: RenderContext): string {
  return `${fg(ctx.theme.borderStrong)}${"─".repeat(Math.max(0, width))}${reset()}`;
}

function chromeLine(content: string, width: number): string {
  return padRight(truncate(content, width), width);
}
