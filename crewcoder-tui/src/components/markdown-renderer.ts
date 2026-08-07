import { bold, dim, fg, italic, reset } from "../tui/ansi.js";
import { wrapText } from "../tui/layout.js";
import type { RenderContext } from "../tui/component.js";

export type MarkdownLine = {
  text: string;
  accent?: boolean;
  code?: boolean;
};

export function renderMarkdown(text: string, width: number, ctx: RenderContext): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  const source = text.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  let fenceLang = "";

  for (const rawLine of source) {
    const fence = rawLine.match(/^\s*```\s*([^`]*)$/);
    if (fence) {
      inFence = !inFence;
      fenceLang = inFence ? fence[1]?.trim() ?? "" : "";
      const label = inFence ? `code${fenceLang ? ` · ${fenceLang}` : ""}` : "end code";
      lines.push({ text: `${dim()}${label}${reset()}`, code: true });
      continue;
    }

    if (inFence) {
      for (const wrapped of wrapText(rawLine || " ", width)) lines.push({ text: highlightSyntaxLine(wrapped, ctx), code: true });
      continue;
    }

    if (!rawLine.trim()) {
      lines.push({ text: "" });
      continue;
    }

    const heading = rawLine.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const marker = level <= 2 ? "◆" : "◇";
      for (const wrapped of wrapText(`${marker} ${heading[2]}`, width)) {
        lines.push({ text: `${fg(ctx.theme.accent)}${bold()}${wrapped}${reset()}`, accent: true });
      }
      continue;
    }

    const quote = rawLine.match(/^>\s?(.*)$/);
    if (quote) {
      for (const wrapped of wrapText(quote[1] ?? "", Math.max(1, width - 2))) {
        lines.push({ text: `${fg(ctx.theme.muted)}┃ ${italic()}${wrapped}${reset()}` });
      }
      continue;
    }

    const unordered = rawLine.match(/^(\s*)[-*+]\s+(.+)$/);
    if (unordered) {
      const indent = Math.min(6, Math.floor((unordered[1]?.length ?? 0) / 2) * 2);
      const prefix = `${" ".repeat(indent)}• `;
      pushWrappedRich(lines, prefix, unordered[2]!, width, ctx);
      continue;
    }

    const ordered = rawLine.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (ordered) {
      const indent = Math.min(6, Math.floor((ordered[1]?.length ?? 0) / 2) * 2);
      const prefix = `${" ".repeat(indent)}› `;
      pushWrappedRich(lines, prefix, ordered[2]!, width, ctx);
      continue;
    }

    pushWrappedRich(lines, "", rawLine, width, ctx);
  }

  return lines;
}

function pushWrappedRich(lines: MarkdownLine[], prefix: string, text: string, width: number, ctx: RenderContext): void {
  const available = Math.max(1, width - prefix.length);
  const wrapped = wrapText(text, available);
  for (let index = 0; index < wrapped.length; index++) {
    const linePrefix = index === 0 ? prefix : " ".repeat(prefix.length);
    lines.push({ text: `${linePrefix}${styleInline(wrapped[index]!, ctx)}` });
  }
}

function highlightSyntaxLine(text: string, ctx: RenderContext): string {
  if (!text.trim()) return text;
  const commentStart = text.search(/\/\/|#/);
  const code = commentStart >= 0 ? text.slice(0, commentStart) : text;
  const comment = commentStart >= 0 ? text.slice(commentStart) : "";
  const highlighted = code.replace(/("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`|\b(?:const|let|var|function|return|if|else|for|while|import|from|export|type|interface|class|extends|async|await|new|try|catch|throw)\b|\b(?:true|false|null|undefined)\b|\b\d+(?:\.\d)?\b|(?:\.?\.?\/[\w./-]+|[\w.-]+\/[\w./-]+))/g, (token) => {
    if (/^["'`]/.test(token)) return `${fg(ctx.theme.success)}${token}${reset()}${fg(ctx.theme.text)}`;
    if (/^\d/.test(token)) return `${fg(ctx.theme.accent3)}${token}${reset()}${fg(ctx.theme.text)}`;
    if (/^(true|false|null|undefined)$/.test(token)) return `${fg(ctx.theme.accent3)}${token}${reset()}${fg(ctx.theme.text)}`;
    if (token.includes("/")) return `${fg(ctx.theme.accent2)}${token}${reset()}${fg(ctx.theme.text)}`;
    return `${fg(ctx.theme.warning)}${token}${reset()}${fg(ctx.theme.text)}`;
  });
  const commentSegment = comment ? `${fg(ctx.theme.success)}${italic()}${comment}${reset()}` : "";
  return `${fg(ctx.theme.text)}${highlighted}${reset()}${commentSegment}`;
}

function styleInline(text: string, ctx: RenderContext): string {
  return text
    .replace(/`([^`]+)`/g, `${fg(ctx.theme.accent2)}$1${reset()}${fg(ctx.theme.text)}`)
    .replace(/\*\*([^*]+)\*\*/g, `${bold()}$1${reset()}${fg(ctx.theme.text)}`)
    .replace(/__([^_]+)__/g, `${bold()}$1${reset()}${fg(ctx.theme.text)}`)
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, `${italic()}$1${reset()}${fg(ctx.theme.text)}`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `$1 ${fg(ctx.theme.muted)}<$2>${reset()}${fg(ctx.theme.text)}`);
}
