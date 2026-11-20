import { BoxRenderable, SyntaxStyle, type RenderContext, type Renderable, type RenderNodeContext, type StyleDefinitionInput } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useMemo } from "react";
import type { MarkdownColors, SyntaxColors } from "@onpoint-dev-tools/crewcoder-tui-core/theme/crewcoder-theme";
import type { Theme } from "./components/ui/types.js";
import { useAppColors } from "./hooks/use-app-colors.js";

/** Per-block text colors: replies and reasoning differ in body and heading color. */
export type MarkdownTextColors = {
  /** Body text. */
  base: string;
  /** Headings (bold). Replies use the theme's markdown heading; reasoning keeps its body color. */
  heading: string;
};

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/**
 * Tree-sitter capture styles for highlighted code (fenced blocks, diffs, read
 * output). OpenTUI's `SyntaxStyle` looks up the exact capture name, then only
 * its first segment (`keyword.function` -> `keyword`), so base names cover
 * dotted captures here. Variables and plain identifiers keep the surrounding
 * text color. Colors come from the active theme's `syntax` palette.
 */
export function codeStyles(c: SyntaxColors): Record<string, StyleDefinitionInput> {
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
 * Markdown element styles (`markup.*`), shared by rendered replies and by
 * markdown source (`.md` read output, diffs, ```markdown fences). Every full
 * capture name the markdown grammar emits is listed: OpenTUI would resolve
 * `markup.raw.block` only to `markup`, which has no style.
 */
export function markupStyles(md: MarkdownColors, heading: string, concealed: string): Record<string, StyleDefinitionInput> {
  const headingStyle: StyleDefinitionInput = { fg: heading, bold: true };
  const link: StyleDefinitionInput = { fg: md.link, underline: true };
  const list: StyleDefinitionInput = { fg: md.listMarker };
  const code: StyleDefinitionInput = { fg: md.code };
  return {
    conceal: { fg: concealed },
    "markup.heading": headingStyle,
    ...Object.fromEntries(HEADING_LEVELS.map((level) => [`markup.heading.${level}`, headingStyle])),
    "markup.strong": { fg: md.strong, bold: true },
    "markup.italic": { fg: md.emphasis, italic: true },
    "markup.strikethrough": { fg: md.strikethrough, strikethrough: true },
    "markup.raw": code,
    "markup.raw.block": code,
    "markup.math": code,
    "markup.link": link,
    "markup.link.label": link,
    "markup.link.url": { fg: md.linkUrl },
    "markup.link.bracket.close": { fg: md.linkUrl },
    "markup.list": list,
    "markup.list.checked": list,
    "markup.list.unchecked": list,
    "markup.quote": { fg: md.quote }
  };
}

/**
 * Styles for OpenTUI's markdown engine (`markup.*`, `conceal`, `default`) plus
 * the code scopes for fenced blocks.
 */
export function markdownStyles(theme: Theme, colors: MarkdownTextColors, syntax: SyntaxColors, markdown: MarkdownColors): Record<string, StyleDefinitionInput> {
  return {
    ...codeStyles(syntax),
    ...markupStyles(markdown, colors.heading, theme.colors.mutedForeground),
    default: { fg: colors.base }
  };
}

/**
 * A native `SyntaxStyle`, rebuilt when its colors change (`/theme`) and freed
 * when replaced or unmounted. `deps` are the colors `build` reads.
 */
function useSyntaxStyle(build: () => Record<string, StyleDefinitionInput>, deps: readonly unknown[]): SyntaxStyle {
  const renderer = useRenderer();
  const style = useMemo(() => SyntaxStyle.fromStyles(build(), renderer.nativeScene), [renderer, ...deps]);
  useEffect(() => () => style.destroy(), [style]);
  return style;
}

export function useMarkdownStyle(theme: Theme, colors: MarkdownTextColors): SyntaxStyle {
  const { syntax, markdown } = useAppColors();
  return useSyntaxStyle(() => markdownStyles(theme, colors, syntax, markdown), [theme, colors.base, colors.heading, syntax, markdown]);
}

/**
 * Highlighted source for `<diff>` and `<code>` (read output): code scopes, and
 * markdown element scopes so `.md` files color their headings, emphasis,
 * links, and code spans like a rendered reply.
 */
export function useCodeStyle(theme: Theme): SyntaxStyle {
  const { syntax, markdown } = useAppColors();
  return useSyntaxStyle(() => ({
    ...codeStyles(syntax),
    ...markupStyles(markdown, markdown.heading, theme.colors.mutedForeground),
    default: { fg: theme.colors.foreground }
  }), [theme, syntax, markdown]);
}

/**
 * A fenced code block behind a left rail. The block itself is OpenTUI's
 * default `CodeRenderable`, highlighted by Tree-sitter when the fence's info
 * string names a language with a parser (`infoStringToFiletype`), plain text
 * otherwise. Markdown reuses that renderable across streaming updates and
 * takes it out of the old rail before dropping it. OpenTUI leaves fenced
 * code unconcealed, so a ```markdown fence keeps its `#` and `**` markers.
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
