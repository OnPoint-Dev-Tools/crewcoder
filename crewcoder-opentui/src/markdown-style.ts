import { BoxRenderable, SyntaxStyle, TextRenderable, type MarkdownBlock, type RenderContext, type Renderable, type StyleDefinitionInput } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";
import type { Theme } from "./components/ui/types.js";

export type MarkdownColors = {
  /** Body text. */
  base: string;
  /** Headings (bold). */
  heading: string;
};

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/**
 * Slate styles for the scopes OpenTUI's markdown engine asks for. The names
 * come from the native engine (`markup.*`, `conceal`, `default`).
 */
export function markdownStyles(theme: Theme, colors: MarkdownColors): Record<string, StyleDefinitionInput> {
  const heading: StyleDefinitionInput = { fg: colors.heading, bold: true };
  const link: StyleDefinitionInput = { fg: theme.colors.info, underline: true };
  return {
    default: { fg: colors.base },
    conceal: { fg: theme.colors.mutedForeground },
    "markup.heading": heading,
    ...Object.fromEntries(HEADING_LEVELS.map((level) => [`markup.heading.${level}`, heading])),
    "markup.strong": { fg: colors.base, bold: true },
    "markup.italic": { fg: colors.base, italic: true },
    "markup.strikethrough": { fg: theme.colors.mutedForeground, strikethrough: true },
    "markup.raw": { fg: theme.colors.accent },
    "markup.math": { fg: theme.colors.accent },
    "markup.link": link,
    "markup.link.label": link,
    "markup.link.url": { fg: theme.colors.mutedForeground },
    "markup.list": { fg: theme.colors.mutedForeground },
    "markup.quote": { fg: theme.colors.mutedForeground }
  };
}

/**
 * A native `SyntaxStyle` for these colors, owned by the component and freed on
 * unmount. Colors are read once; the theme does not change at runtime.
 */
export function useMarkdownStyle(theme: Theme, colors: MarkdownColors): SyntaxStyle {
  const renderer = useRenderer();
  const [style] = useState(() => SyntaxStyle.fromStyles(markdownStyles(theme, colors), renderer.nativeScene));
  useEffect(() => () => style.destroy(), [style]);
  return style;
}

/**
 * Fenced code as plain accent text behind a left rail. Highlighting would need
 * a tree-sitter worker and scope styles for every language; plain text keeps
 * code readable without them.
 */
export function codeBlock(ctx: RenderContext, theme: Theme, block: MarkdownBlock): Renderable {
  const box = new BoxRenderable(ctx, {
    width: "100%",
    border: ["left"],
    borderStyle: "single",
    borderColor: theme.colors.border,
    paddingLeft: 1
  });
  box.add(new TextRenderable(ctx, { content: block.text.replace(/\n$/, ""), width: "100%", wrapMode: "char", fg: theme.colors.accent }));
  return box;
}
