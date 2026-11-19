import { BoxRenderable, SyntaxStyle, type RenderContext, type Renderable, type RenderNodeContext, type StyleDefinitionInput } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";
import type { Theme } from "./components/ui/types.js";
import { SYNTAX_COLORS } from "./theme.js";

export type MarkdownColors = {
  /** Body text. */
  base: string;
  /** Headings (bold). */
  heading: string;
};

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/**
 * Tree-sitter capture styles for highlighted code (fenced blocks, diffs, read
 * output). Base names only: OpenTUI resolves `keyword.function` to `keyword`.
 * Variables and plain identifiers keep the surrounding text color.
 */
export function codeStyles(): Record<string, StyleDefinitionInput> {
  const c = SYNTAX_COLORS;
  return {
    keyword: { fg: c.keyword },
    conditional: { fg: c.keyword },
    repeat: { fg: c.keyword },
    include: { fg: c.keyword },
    exception: { fg: c.keyword },
    string: { fg: c.string },
    "string.special.key": { fg: c.property },
    character: { fg: c.string },
    escape: { fg: c.escape },
    number: { fg: c.number },
    float: { fg: c.number },
    boolean: { fg: c.constant },
    constant: { fg: c.constant },
    comment: { fg: c.comment, italic: true },
    function: { fg: c.function },
    method: { fg: c.function },
    constructor: { fg: c.type },
    type: { fg: c.type },
    namespace: { fg: c.type },
    module: { fg: c.type },
    property: { fg: c.property },
    field: { fg: c.property },
    attribute: { fg: c.attribute },
    label: { fg: c.attribute },
    operator: { fg: c.operator },
    punctuation: { fg: c.punctuation },
    tag: { fg: c.tag },
    "tag.attribute": { fg: c.attribute },
    "tag.delimiter": { fg: c.punctuation }
  };
}

/**
 * Slate styles for the scopes OpenTUI's markdown engine asks for (`markup.*`,
 * `conceal`, `default`), plus the code scopes for fenced blocks.
 */
export function markdownStyles(theme: Theme, colors: MarkdownColors): Record<string, StyleDefinitionInput> {
  const heading: StyleDefinitionInput = { fg: colors.heading, bold: true };
  const link: StyleDefinitionInput = { fg: theme.colors.info, underline: true };
  return {
    ...codeStyles(),
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
 * A native `SyntaxStyle` built once per component and freed on unmount.
 * Colors are read once; the theme does not change at runtime.
 */
function useSyntaxStyle(build: () => Record<string, StyleDefinitionInput>): SyntaxStyle {
  const renderer = useRenderer();
  const [style] = useState(() => SyntaxStyle.fromStyles(build(), renderer.nativeScene));
  useEffect(() => () => style.destroy(), [style]);
  return style;
}

export function useMarkdownStyle(theme: Theme, colors: MarkdownColors): SyntaxStyle {
  return useSyntaxStyle(() => markdownStyles(theme, colors));
}

/** Code scopes alone, for `<diff>` and `<code>` (read output). */
export function useCodeStyle(theme: Theme): SyntaxStyle {
  return useSyntaxStyle(() => ({ ...codeStyles(), default: { fg: theme.colors.foreground } }));
}

/**
 * A fenced code block behind a left rail. The block itself is OpenTUI's
 * default `CodeRenderable`, highlighted by Tree-sitter when the fence's info
 * string names a language with a parser (`infoStringToFiletype`), plain text
 * otherwise. Markdown reuses that renderable across streaming updates and
 * takes it out of the old rail before dropping it.
 */
export function codeFence(ctx: RenderContext, theme: Theme, context: RenderNodeContext): Renderable | undefined {
  const code = context.defaultRender();
  if (!code) return undefined;
  const rail = new BoxRenderable(ctx, {
    width: "100%",
    flexShrink: 0,
    border: ["left"],
    borderStyle: "single",
    borderColor: theme.colors.border,
    paddingLeft: 1
  });
  rail.add(code);
  return rail;
}
