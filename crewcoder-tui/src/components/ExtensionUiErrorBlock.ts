import type { RenderContext } from "../tui/component.js";
import { bg, bold, fg, reset } from "../tui/ansi.js";
import { emptyLine, padRight, truncate, wrapText } from "../tui/layout.js";

export function renderExtensionUiErrorBlock(ctx: RenderContext, extensionId: string, error: unknown): string[] {
  const width = ctx.size.width;
  const lines: string[] = [];
  const message = safeErrorMessage(error);

  lines.push(emptyLine(width));
  lines.push(backgroundLine(`${fg(ctx.theme.danger)}${bold()}extension UI error${reset()} ${fg(ctx.theme.muted)}[${extensionId}]${reset()}`, width, ctx.theme.panel));
  for (const line of wrapText(message, Math.max(1, width - 4)).slice(0, 4)) {
    lines.push(backgroundLine(`  ${fg(ctx.theme.text)}${line}${reset()}`, width, ctx.theme.panel));
  }
  lines.push(emptyLine(width));
  return lines.slice(0, ctx.size.height);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return truncate(error.message, 240);
  return truncate(String(error), 240);
}

function backgroundLine(content: string, width: number, fill: string): string {
  const repainted = content.replaceAll(reset(), `${reset()}${bg(fill)}`);
  return `${bg(fill)}${padRight(repainted, width)}${reset()}`;
}
