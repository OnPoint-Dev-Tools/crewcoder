import { BoxRenderable, TextRenderable, bold, fg, t, type ScrollbackSurface } from "@opentui/core";
import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import type { Theme } from "./components/ui/types.js";
import { MarkdownBody } from "./markdown-body.js";
import { bodyColor, toneColor } from "./theme.js";
import { toolPresentation } from "./tool-presentation.js";
import { blockToRow } from "./transcript.js";

/**
 * How one transcript block is drawn into a native-scrollback surface. The
 * writer owns ordering and commits; a view owns layout and says which rows are
 * final while its block still streams.
 */
export interface BlockView {
  readonly surface: ScrollbackSurface;
  /** Show the block's current text and render the surface. */
  update(block: TuiEventBlock, streaming: boolean): void;
  /** Rows (from the top) that can no longer change while the block streams. */
  stableRows(): number;
  destroy(): void;
}

/** `cwd` shortens tool paths under the workspace to workspace-relative ones. */
export function createBlockView(surface: ScrollbackSurface, theme: Theme, block: TuiEventBlock, cwd?: string): BlockView {
  try {
    if (block.type === "thinking") return new ThinkingView(surface, theme);
    if (block.type === "assistant") return new AssistantView(surface, theme, block);
    if (block.type === "tool") return new ToolView(surface, theme, block, cwd);
    return new RowView(surface, theme, block);
  } catch (error) {
    surface.destroy();
    throw error;
  }
}

/** The bold, tone-colored label row every non-panel block starts with. */
function labelColumn(surface: ScrollbackSurface, theme: Theme, block: TuiEventBlock): BoxRenderable {
  const row = blockToRow(block);
  const column = new BoxRenderable(surface.renderContext, { flexDirection: "column", width: "100%" });
  column.add(new TextRenderable(surface.renderContext, {
    content: t`${bold(fg(toneColor(theme, row.tone))(row.label))}`,
    width: "100%",
    wrapMode: "word"
  }));
  return column;
}

/** `CREW CODER`, then the reply as markdown. */
class AssistantView implements BlockView {
  readonly surface: ScrollbackSurface;
  private readonly body: MarkdownBody;

  constructor(surface: ScrollbackSurface, theme: Theme, block: TuiEventBlock) {
    this.surface = surface;
    const column = labelColumn(surface, theme, block);
    this.body = new MarkdownBody(surface, theme, { base: bodyColor(theme, "assistant"), heading: theme.colors.primary });
    column.add(this.body.renderable);
    surface.root.add(column);
  }

  update(block: TuiEventBlock, streaming: boolean): void {
    this.body.set(blockToRow(block).text, streaming);
    this.surface.render();
  }

  stableRows(): number {
    return this.body.stableEnd();
  }

  destroy(): void {
    this.surface.destroy();
    this.body.destroy();
  }
}

/** Label row, plain body text, and optional muted detail (user background, approval reason, ...). */
class RowView implements BlockView {
  readonly surface: ScrollbackSurface;
  private readonly body: TextRenderable;
  private text = "";

  constructor(surface: ScrollbackSurface, theme: Theme, block: TuiEventBlock) {
    this.surface = surface;
    const row = blockToRow(block);
    const column = labelColumn(surface, theme, block);
    this.body = new TextRenderable(surface.renderContext, { content: "", width: "100%", wrapMode: "word", fg: bodyColor(theme, row.tone) });
    column.add(this.body);
    if (row.detail) {
      column.add(new TextRenderable(surface.renderContext, { content: row.detail, width: "100%", wrapMode: "word", fg: theme.colors.mutedForeground }));
    }
    surface.root.add(column);
  }

  update(block: TuiEventBlock): void {
    this.text = setText(this.body, this.text, blockToRow(block).text);
    this.surface.render();
  }

  /** Word wrap only ever changes the last row as text is appended. */
  stableRows(): number {
    return this.surface.height - 1;
  }

  destroy(): void {
    this.surface.destroy();
  }
}

/**
 * One tool call as a section row: icon and bold title, the target inline or on
 * its own row, then output only where it helps (commands, unknown tools, and
 * failures). Consecutive tools stack without spacer rows (see the writer).
 */
class ToolView implements BlockView {
  readonly surface: ScrollbackSurface;

  constructor(surface: ScrollbackSurface, theme: Theme, block: Extract<TuiEventBlock, { type: "tool" }>, cwd?: string) {
    this.surface = surface;
    const tool = toolPresentation(block, cwd);
    const titleColor = tool.failed ? theme.colors.error : theme.colors.primary;
    const title = tool.title || block.name;
    const status = tool.failed ? fg(theme.colors.error)(" · failed") : "";
    const inlineTarget = tool.layout === "inline" && tool.target ? fg(theme.colors.accent)(`: ${tool.target}`) : "";
    const column = new BoxRenderable(surface.renderContext, { flexDirection: "column", width: "100%" });
    column.add(new TextRenderable(surface.renderContext, {
      content: t`${fg(titleColor)(tool.icon)} ${bold(fg(titleColor)(title))}${inlineTarget}${status}`,
      width: "100%",
      wrapMode: "word"
    }));
    if (tool.layout === "stacked" && tool.target) {
      column.add(new TextRenderable(surface.renderContext, { content: tool.target, width: "100%", wrapMode: "word", fg: theme.colors.accent, paddingLeft: TOOL_INDENT }));
    }
    if (tool.output) {
      column.add(new TextRenderable(surface.renderContext, { content: tool.output, width: "100%", wrapMode: "word", fg: tool.failed ? theme.colors.error : theme.colors.mutedForeground, paddingLeft: TOOL_INDENT }));
    }
    surface.root.add(column);
  }

  update(): void {
    this.surface.render();
  }

  stableRows(): number {
    return this.surface.height - 1;
  }

  destroy(): void {
    this.surface.destroy();
  }
}

/** Lines under a tool title start below the title text, past the icon and its space. */
const TOOL_INDENT = 3;

/** Reasoning header, after termcn `thinking-block`'s label. */
export const THINKING_LABEL = "Reasoning";
const THINKING_ICON = "💭";

/**
 * Reasoning as a panel after termcn's `thinking-block`: a single-line bordered
 * box in the warning (amber) tone with a bold `💭 Reasoning` header, a blank
 * row, and the reasoning as markdown (summaries use bold headings). Ported as
 * core renderables because the transcript is native scrollback, not React. It
 * is always expanded: committed rows cannot be toggled, and thinking summaries
 * must stay visible (see the event-rendering guardrails).
 */
class ThinkingView implements BlockView {
  readonly surface: ScrollbackSurface;
  private readonly body: MarkdownBody;

  constructor(surface: ScrollbackSurface, theme: Theme) {
    this.surface = surface;
    const panel = new BoxRenderable(surface.renderContext, {
      flexDirection: "column",
      width: "100%",
      border: true,
      borderStyle: "single",
      borderColor: theme.colors.warning,
      paddingLeft: 1,
      paddingRight: 1
    });
    panel.add(new TextRenderable(surface.renderContext, {
      content: t`${THINKING_ICON} ${bold(fg(theme.colors.warning)(THINKING_LABEL))}`,
      width: "100%",
      wrapMode: "none"
    }));
    this.body = new MarkdownBody(surface, theme, { base: theme.colors.foreground, heading: theme.colors.foreground }, { marginTop: 1 });
    panel.add(this.body.renderable);
    surface.root.add(panel);
  }

  update(block: TuiEventBlock, streaming: boolean): void {
    // Trailing blank lines between reasoning summaries would only pad the panel.
    this.body.set(blockToRow(block).text.trimEnd(), streaming);
    this.surface.render();
  }

  /** The markdown's final rows, never the bottom border. */
  stableRows(): number {
    return Math.min(this.body.stableEnd(), this.surface.height - 1);
  }

  destroy(): void {
    this.surface.destroy();
    this.body.destroy();
  }
}

/** Assign only changed text, so an unchanged block is not re-laid out. */
function setText(body: TextRenderable, current: string, next: string): string {
  if (next !== current) body.content = next;
  return next;
}
