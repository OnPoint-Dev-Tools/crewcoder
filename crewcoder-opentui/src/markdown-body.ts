import {
  BoxRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  TextRenderable,
  type MarkdownBlock,
  type Renderable,
  type ScrollbackSurface,
  type StyleDefinitionInput
} from "@opentui/core";
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
 * Agent text rendered with OpenTUI's native `MarkdownRenderable` inside a
 * scrollback surface: paragraphs, headings, lists, quotes, tables, and fenced
 * code. While streaming, `stableEnd` reports which rows are final so the writer
 * can commit them early.
 *
 * Fenced code renders as plain accent text behind a rail. OpenTUI would
 * otherwise highlight it with tree-sitter asynchronously, after its rows may
 * already be committed, so colors would differ from block to block.
 */
export class MarkdownBody {
  readonly renderable: MarkdownRenderable;
  private readonly surface: ScrollbackSurface;
  private readonly style: SyntaxStyle;
  private text = "";

  constructor(surface: ScrollbackSurface, theme: Theme, colors: MarkdownColors, options: { marginTop?: number } = {}) {
    this.surface = surface;
    this.style = SyntaxStyle.fromStyles(markdownStyles(theme, colors), surface.renderContext.nativeScene);
    this.renderable = new MarkdownRenderable(surface.renderContext, {
      content: "",
      syntaxStyle: this.style,
      fg: colors.base,
      width: "100%",
      streaming: true,
      conceal: true,
      marginTop: options.marginTop,
      tableOptions: { borderColor: theme.colors.border, wrapMode: "word", widthMode: "content", cellPaddingX: 1 },
      renderBlock: (block) => (block.kind === "code" ? codeBlock(surface, theme, block) : undefined)
    });
  }

  set(text: string, streaming: boolean): void {
    if (this.renderable.streaming !== streaming) this.renderable.streaming = streaming;
    if (text === this.text) return;
    this.renderable.content = text;
    this.text = text;
  }

  /**
   * Surface row up to which the document is final. Top-level blocks the engine
   * reports committed are final. Of the block still being written, a paragraph
   * or code block only ever changes its last row as text is appended, so its
   * other rows are final too; anything else (lists, tables, quotes) can still
   * reflow and is held back whole. Call after the surface rendered.
   */
  stableEnd(): number {
    const origin = this.surface.root.y;
    const children = this.renderable.getChildren();
    const next = children[this.renderable.committedBlockCount];
    const last = children.at(-1);
    // Nothing shown yet: only the rows above the document are final.
    let end = this.renderable.y - origin;
    if (next) {
      const top = next.y - origin;
      const kind = this.renderable.blocks.find((block) => block.renderable === next)?.kind;
      end = kind === "paragraph" || kind === "code" ? top + Math.max(0, next.height - 1) : top;
    } else if (last) {
      end = last.y - origin + last.height;
    }
    return Math.max(0, Math.min(end, this.surface.height));
  }

  /** Call after the surface is destroyed. */
  destroy(): void {
    this.style.destroy();
  }
}

function codeBlock(surface: ScrollbackSurface, theme: Theme, block: MarkdownBlock): Renderable {
  const box = new BoxRenderable(surface.renderContext, {
    width: "100%",
    border: ["left"],
    borderStyle: "single",
    borderColor: theme.colors.border,
    paddingLeft: 1
  });
  box.add(new TextRenderable(surface.renderContext, { content: block.text.replace(/\n$/, ""), width: "100%", wrapMode: "char", fg: theme.colors.accent }));
  return box;
}
