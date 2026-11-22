import { pathToFileURL } from "node:url";
import type { BorderCharacters, ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { useMemo, useState, type ReactNode, type Ref } from "react";
import { blockPanel, isPanelBlock, type BlockPanel, type PanelTone } from "../block-panels.js";
import { reasoningIcon, type GlyphSet } from "../glyphs.js";
import { useAppColors } from "../hooks/use-app-colors.js";
import { useGlyphSet } from "../hooks/use-glyph-set.js";
import { useTheme } from "../hooks/use-theme.js";
import { codeFenceRenderer, useCodeStyle, useMarkdownStyle, type MarkdownTextColors } from "../markdown-style.js";
import { codeFiletype } from "../syntax/filetype.js";
import { imageBox, type ImageMode } from "../image-view.js";
import { bodyColor, toneColor } from "../theme.js";
import { toolDiffs, type FileDiff } from "../tool-diff.js";
import { clampOutput, COLLAPSED_OUTPUT_LINES, diffLineTone, toolPresentation, type DiffLineTone } from "../tool-presentation.js";
import { actionLabel, type AppAction } from "../keybindings.js";
import { blockElementId, chromeId } from "../search-jump.js";
import { SEARCH_MARKER } from "../glyphs.js";
import { workflowView, type WorkflowView } from "../workflow-tools.js";
import { renderedTool } from "../tool-renderer-view.js";
import { findToolRenderer } from "@onpoint-dev-tools/crewcoder-tui-core/state/tool-renderers";
import type { TuiRendererHook } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { blockToRow, isStreaming, normalize, throughputLabel, transcriptSections, workerOf, type ApprovalBlock, type ToolBlock, type ToolExpansion, type WorkBlock } from "../transcript.js";
import { Spinner } from "./ui/spinner.js";
import type { Theme } from "./ui/types.js";

export type TranscriptProps = {
  blocks: readonly TuiEventBlock[];
  running: boolean;
  cwd: string;
  expansion: ToolExpansion;
  images: ImageDisplay;
  scrollRef?: Ref<ScrollBoxRenderable>;
  /** Content row of the current search match; a marker points at it from the left margin. */
  markRow?: number;
  /** Extension tool renderers (`crewcoder extension renderers`); a match draws the tool from its template. */
  renderers?: readonly TuiRendererHook[];
};

/** How image blocks draw: the pixel mode, the columns they may use, and the screen height they are capped against. */
export type ImageDisplay = { mode: ImageMode; cols: number; screenRows: number };

/** Shown under an image whose pixels could not be drawn (unreadable or undecodable file). */
export const IMAGE_FAILED_TEXT = "(image could not be drawn)";

/** Dashed rounded border for the Agent work box. */
export const DASHED_BORDER: BorderCharacters = {
  topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
  horizontal: "╌", vertical: "╎",
  topT: "┬", bottomT: "┴", leftT: "├", rightT: "┤", cross: "┼"
};

export const AGENT_WORK_TITLE = "Agent work";
export const REASONING_LABEL = "Reasoning";

/**
 * The whole conversation in a scrollbox that sticks to the bottom while new
 * output arrives and stays put once the user scrolls up (until they scroll back
 * down). Sections follow event order, divided by a blank row.
 */
export function Transcript({ blocks, running, cwd, expansion, images, scrollRef, markRow, renderers = [] }: TranscriptProps): ReactNode {
  const theme = useTheme();
  // Emoji icons only where the terminal draws them whole; single-cell symbols elsewhere.
  const glyphs = useGlyphSet();
  const sections = transcriptSections(blocks);
  const lastIndex = blocks.length - 1;
  return (
    <scrollbox
      ref={scrollRef}
      flexGrow={1}
      flexShrink={1}
      width="100%"
      // Clicking the transcript must not take focus from the composer; the wheel still scrolls it.
      focusable={false}
      stickyScroll
      stickyStart="bottom"
      viewportCulling
      contentOptions={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}
      verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.colors.border, backgroundColor: theme.colors.background } }}
    >
      {sections.map((section, index) => (
        <box
          key={`${section.kind}-${section.start}`}
          // Search finds a block by this id (`search-jump.ts`); work entries carry their own.
          {...(section.kind === "block" ? { id: blockElementId(section.start) } : {})}
          flexDirection="column"
          width="100%"
          flexShrink={0}
          marginTop={index === 0 ? 0 : 1}
        >
          {section.kind === "work"
            ? <AgentWork blocks={section.blocks} start={section.start} cwd={cwd} expansion={expansion} glyphs={glyphs} renderers={renderers} />
            : <BlockView block={section.block} index={section.start} streaming={isStreaming(section.block, section.start === lastIndex, running)} glyphs={glyphs} images={images} />}
        </box>
      ))}
      {/* Last, so the first child stays the content origin; it sits in the content's left padding. */}
      {markRow !== undefined ? (
        <box position="absolute" top={markRow} left={0} width={1} height={1}>
          <text id={chromeId("search-mark")} fg={theme.colors.warning} wrapMode="none"><b>{SEARCH_MARKER}</b></text>
        </box>
      ) : null}
    </scrollbox>
  );
}

function BlockView({ block, index, streaming, glyphs, images }: { block: TuiEventBlock; index: number; streaming: boolean; glyphs: GlyphSet; images: ImageDisplay }): ReactNode {
  if (block.type === "thinking") return <ReasoningPanel text={blockToRow(block).text} worker={block.worker} streaming={streaming} glyphs={glyphs} index={index} />;
  if (block.type === "assistant") return <AssistantMessage text={blockToRow(block).text} worker={block.worker} throughput={throughputLabel(block)} streaming={streaming} index={index} />;
  if (block.type === "image") return <ImageView block={block} display={images} index={index} />;
  // A crew worker's brief keeps its `TASK → <worker>` label row.
  if (block.type === "user" && !block.worker) return <UserMessage block={block} />;
  if (isPanelBlock(block)) return <PanelView panel={blockPanel(block)} />;
  return <RowView block={block} index={index} />;
}

function panelColor(theme: Theme, tone: PanelTone): string {
  switch (tone) {
    case "primary": return theme.colors.primary;
    case "success": return theme.colors.success;
    case "warning": return theme.colors.warning;
    case "error": return theme.colors.error;
    case "info": return theme.colors.info;
    case "muted": return theme.colors.mutedForeground;
    case "text": return theme.colors.foreground;
  }
}

/**
 * A crew, goal, review summary, `/why` answer, background job, validation, or
 * checkpoint: a rounded box in its status color, a title row (spinner while it
 * is still changing), then its rows. Text wraps; markers keep their own column.
 */
function PanelView({ panel }: { panel: BlockPanel }): ReactNode {
  const theme = useTheme();
  const color = panelColor(theme, panel.tone);
  return (
    <box flexDirection="column" width="100%" border borderStyle="rounded" borderColor={color} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" width="100%" flexShrink={0}>
        {panel.live ? <Spinner color={color} flexShrink={0} marginRight={1} /> : null}
        <text wrapMode="word" flexGrow={1} flexShrink={1}>
          <span fg={color}><b>{panel.title}</b></span>
          {panel.meta ? <span fg={theme.colors.mutedForeground}>{`  ${panel.meta}`}</span> : null}
        </text>
      </box>
      {panel.lines.map((row, index) => (
        <box key={index} flexDirection="row" width="100%" flexShrink={0}>
          {row.marker === "spinner"
            ? <Spinner color={theme.colors.warning} flexShrink={0} marginRight={1} />
            : row.marker
              ? <text fg={panelColor(theme, row.marker.tone)} flexShrink={0} marginRight={1}>{row.marker.glyph}</text>
              : null}
          <text fg={panelColor(theme, row.tone)} wrapMode="word" flexGrow={1} flexShrink={1}>{row.text || " "}</text>
        </box>
      ))}
    </box>
  );
}

type ImageBlock = Extract<TuiEventBlock, { type: "image" }>;

/**
 * An attached or tool-produced image: label, name and size, the pixels through
 * OpenTUI's `<image>` (kitty, sixel, or half-block cells, per `display.mode`),
 * then the file path. A file that cannot be read or decoded keeps the caption
 * and says so; it never fails the render.
 */
function ImageView({ block, display, index }: { block: ImageBlock; display: ImageDisplay; index: number }): ReactNode {
  const theme = useTheme();
  const row = blockToRow(block);
  const { path, width, height } = block.attachment;
  const [failedPath, setFailedPath] = useState<string>();
  // A file URL, never a bare string: OpenTUI fetches strings that look like http(s) URLs.
  const source = useMemo(() => pathToFileURL(path), [path]);
  const failed = failedPath === path;
  const box = imageBox(width, height, display.cols, display.screenRows);
  return (
    <>
      <text id={chromeId("label", index)} fg={toneColor(theme, row.tone)} wrapMode="word" width="100%"><b>{row.label}</b></text>
      <text fg={bodyColor(theme, row.tone)} wrapMode="word" width="100%">{row.text}</text>
      {display.mode !== "none" && !failed ? (
        <image
          source={source}
          protocol={display.mode}
          fit="fit"
          width={box.cols}
          height={box.rows}
          flexShrink={0}
          onError={() => setFailedPath(path)}
        />
      ) : null}
      {failed ? <text id={chromeId("image-failed", index)} fg={theme.colors.mutedForeground} wrapMode="word" width="100%">{IMAGE_FAILED_TEXT}</text> : null}
      {row.detail ? <text fg={theme.colors.mutedForeground} wrapMode="word" width="100%">{row.detail}</text> : null}
    </>
  );
}

/** `CREW CODER` (`· <worker>` in a crew) and its muted throughput (`42.3 tok/s`), then the reply as markdown. */
function AssistantMessage({ text, worker, throughput, streaming, index }: { text: string; worker?: string; throughput?: string; streaming: boolean; index: number }): ReactNode {
  const theme = useTheme();
  const { markdown } = useAppColors();
  return (
    <>
      <text id={chromeId("label", index)} fg={theme.colors.success} wrapMode="none" flexShrink={0}>
        <b>CREW CODER</b>
        {worker ? <span fg={theme.colors.accent}>{` · ${normalize(worker)}`}</span> : null}
        {throughput ? <span fg={theme.colors.mutedForeground}>{` ${throughput}`}</span> : null}
      </text>
      <MarkdownText text={text} streaming={streaming} colors={{ base: bodyColor(theme, "assistant"), heading: markdown.heading }} />
    </>
  );
}

/**
 * Reasoning after termcn's `thinking-block`: amber single border, bold
 * `💭 Reasoning` header (`∴` where emoji clip), blank row, markdown. Always
 * expanded: thinking summaries must stay visible (event-rendering guardrails).
 */
function ReasoningPanel({ text, worker, streaming, glyphs, index }: { text: string; worker?: string; streaming: boolean; glyphs: GlyphSet; index: number }): ReactNode {
  const theme = useTheme();
  return (
    <box flexDirection="column" width="100%" border borderStyle="single" borderColor={theme.colors.warning} paddingLeft={1} paddingRight={1}>
      <text id={chromeId("label", index)} wrapMode="none" flexShrink={0}>
        <span>{`${reasoningIcon(glyphs)} `}</span>
        <span fg={theme.colors.warning}><b>{REASONING_LABEL}</b></span>
        {worker ? <span fg={theme.colors.accent}>{` · ${normalize(worker)}`}</span> : null}
      </text>
      {/* Trailing blank lines between reasoning summaries would only pad the panel. */}
      <box marginTop={1} width="100%">
        <MarkdownText text={text.trimEnd()} streaming={streaming} colors={{ base: theme.colors.foreground, heading: theme.colors.foreground }} />
      </box>
    </box>
  );
}

function MarkdownText({ text, streaming, colors }: { text: string; streaming: boolean; colors: MarkdownTextColors }): ReactNode {
  const theme = useTheme();
  const renderer = useRenderer();
  const style = useMarkdownStyle(theme, colors);
  const renderBlock = useMemo(() => codeFenceRenderer(renderer, theme), [renderer, theme]);
  return (
    <markdown
      content={text}
      syntaxStyle={style}
      fg={colors.base}
      width="100%"
      streaming={streaming}
      conceal
      tableOptions={{ borderColor: theme.colors.border, wrapMode: "word", widthMode: "content", cellPaddingX: 1 }}
      renderBlock={renderBlock}
    />
  );
}

/**
 * The user's own message: a filled circle (`primary`) left of the text, which wraps
 * under itself, never under the marker. Background context stays muted and
 * separate below (event-rendering guardrails).
 */
function UserMessage({ block }: { block: Extract<TuiEventBlock, { type: "user" }> }): ReactNode {
  const theme = useTheme();
  const row = blockToRow(block);
  return (
    <>
      <box flexDirection="row" width="100%" flexShrink={0}>
        <text fg={toneColor(theme, row.tone)} flexShrink={0} marginRight={1}>{row.label}</text>
        <text fg={bodyColor(theme, row.tone)} wrapMode="word" flexGrow={1} flexShrink={1}>{row.text || " "}</text>
      </box>
      {row.detail ? <text fg={theme.colors.mutedForeground} wrapMode="word" width="100%" paddingLeft={USER_TEXT_INDENT}>{row.detail}</text> : null}
    </>
  );
}

/** The marker and its space: background context lines up with the message text. */
const USER_TEXT_INDENT = 2;

/** Label row, plain text, and optional muted detail. */
function RowView({ block, index }: { block: TuiEventBlock; index: number }): ReactNode {
  const theme = useTheme();
  const row = blockToRow(block);
  return (
    <>
      <text id={chromeId("label", index)} fg={toneColor(theme, row.tone)} wrapMode="word" width="100%"><b>{row.label}</b></text>
      {row.text ? <text fg={bodyColor(theme, row.tone)} wrapMode="word" width="100%">{row.text}</text> : null}
      {row.detail ? <text fg={theme.colors.mutedForeground} wrapMode="word" width="100%">{row.detail}</text> : null}
    </>
  );
}

/**
 * Consecutive tool calls and approvals in one dashed box titled `Agent work`.
 * Running tools show here live, with a spinner, as soon as they start.
 */
function AgentWork({ blocks, start, cwd, expansion, glyphs, renderers }: { blocks: readonly WorkBlock[]; start: number; cwd: string; expansion: ToolExpansion; glyphs: GlyphSet; renderers: readonly TuiRendererHook[] }): ReactNode {
  const theme = useTheme();
  // A box holds one worker's tools (transcriptSections splits on a worker change).
  const worker = blocks.map(workerOf).find(Boolean);
  return (
    <box
      flexDirection="column"
      width="100%"
      border
      customBorderChars={DASHED_BORDER}
      borderColor={theme.colors.border}
      title={` ${AGENT_WORK_TITLE}${worker ? ` · ${normalize(worker)}` : ""} `}
      titleColor={theme.colors.primary}
      paddingLeft={1}
      paddingRight={1}
    >
      {blocks.map((block, index) => (
        <box key={block.type === "tool" ? (block.id ?? `tool-${index}`) : (block.id ?? `approval-${index}`)} id={blockElementId(start + index)} flexDirection="column" width="100%" flexShrink={0} marginTop={index === 0 ? 0 : 1}>
          {block.type === "tool"
            ? <ToolEntry block={block} index={start + index} cwd={cwd} expansion={expansion} glyphs={glyphs} renderers={renderers} />
            : <ApprovalEntry block={block} />}
        </box>
      ))}
    </box>
  );
}

/**
 * One tool call: status, highlighted title chip, target, then either the
 * file diff of an edit (`DiffSection`) or its output, collapsed to
 * COLLAPSED_OUTPUT_LINES with a clickable toggle.
 */
function ToolEntry({ block, index, cwd, expansion, glyphs, renderers }: { block: ToolBlock; index: number; cwd: string; expansion: ToolExpansion; glyphs: GlyphSet; renderers: readonly TuiRendererHook[] }): ReactNode {
  const theme = useTheme();
  // An extension's declarative renderer replaces the whole view, as in legacy.
  const renderer = findToolRenderer(block, renderers);
  if (renderer) return <RenderedTool block={block} renderer={renderer} />;
  // A CrewCoder-mode plan or clarify step reads from its arguments, never collapsed;
  // its title replaces the tool name and it has no target (that would repeat an argument).
  const workflow = workflowView(block);
  const presented = toolPresentation(block, cwd, glyphs);
  const tool = workflow ? { ...presented, title: workflow.title, target: undefined } : presented;
  const running = block.status === "running";
  const expanded = expansion.isExpanded(block);
  const onToggle = (): void => expansion.toggle(block);
  const diffs = workflow ? [] : toolDiffs(block, cwd, expansion.lineAnchors(block));
  // An edit's diff replaces its output ("Edited src/a.ts" says nothing more).
  // Only edit/write tools have diffs; commands show their output alone.
  const text = diffs.length > 0 || workflow ? undefined : tool.output;
  // The highlighted title: dark text on a light chip, so each step stands out in the box.
  const chipBg = tool.failed ? theme.colors.error : theme.colors.primary;
  const chipFg = tool.failed ? theme.colors.errorForeground : theme.colors.primaryForeground;
  const output = text ? clampOutput(text, expanded) : undefined;
  const canCollapse = expanded && text !== undefined && clampOutput(text, false).hidden > 0;
  return (
    <>
      <box flexDirection="row" width="100%" flexShrink={0}>
        {running
          ? <Spinner color={theme.colors.warning} flexShrink={0} />
          : <text fg={tool.failed ? theme.colors.error : theme.colors.success} flexShrink={0}>{tool.failed ? "✗" : "✓"}</text>}
        <text marginLeft={1} wrapMode="word" flexGrow={1} flexShrink={1}>
          <span bg={chipBg} fg={chipFg}><b>{` ${tool.icon} ${tool.title || block.name} `}</b></span>
          {tool.layout === "inline" && tool.target ? <span fg={theme.colors.accent}>{` ${tool.target}`}</span> : null}
          {running ? <span fg={theme.colors.mutedForeground}> running…</span> : null}
          {tool.failed ? <span fg={theme.colors.error}> failed</span> : null}
        </text>
      </box>
      {tool.layout === "stacked" && tool.target
        ? <text fg={theme.colors.accent} wrapMode="word" width="100%" paddingLeft={OUTPUT_INDENT}>{tool.target}</text>
        : null}
      {workflow ? <WorkflowBody view={workflow} index={index} theme={theme} /> : null}
      {output ? <ToolOutput lines={output.lines} diff={tool.diff} failed={tool.failed} filetype={tool.filetype} theme={theme} /> : null}
      {output ? <ExpandRow id={chromeId("output-toggle", index)} hidden={output.hidden} canCollapse={canCollapse} onToggle={onToggle} theme={theme} /> : null}
      {diffs.length > 0
        ? <DiffSection index={index} diffs={diffs} shown={expansion.isDiffShown(block)} onToggleShown={() => expansion.toggleDiff(block)} expanded={expanded} onToggle={onToggle} theme={theme} />
        : null}
    </>
  );
}

/**
 * A tool drawn by an extension's template (`renderToolTemplate`, values only; no extension
 * code runs): status, the renderer's title chip and its extension, then the filled-in
 * template as markdown. Not collapsed, as in legacy: the template decides what shows.
 */
function RenderedTool({ block, renderer }: { block: ToolBlock; renderer: TuiRendererHook }): ReactNode {
  const theme = useTheme();
  const view = renderedTool(block, renderer);
  const failed = block.status === "error";
  return (
    <>
      <box flexDirection="row" width="100%" flexShrink={0}>
        {block.status === "running"
          ? <Spinner color={theme.colors.warning} flexShrink={0} />
          : <text fg={failed ? theme.colors.error : theme.colors.success} flexShrink={0}>{failed ? "✗" : "✓"}</text>}
        <text marginLeft={1} wrapMode="word" flexGrow={1} flexShrink={1}>
          <span bg={failed ? theme.colors.error : theme.colors.primary} fg={failed ? theme.colors.errorForeground : theme.colors.primaryForeground}><b>{` ${view.title} `}</b></span>
          <span fg={theme.colors.mutedForeground}>{` ${view.source}`}</span>
          {block.status === "running" ? <span fg={theme.colors.mutedForeground}> running…</span> : null}
          {failed ? <span fg={theme.colors.error}> failed</span> : null}
        </text>
      </box>
      {view.body ? (
        <box width="100%" paddingLeft={OUTPUT_INDENT} flexShrink={0}>
          <MarkdownText text={view.body} streaming={false} colors={{ base: theme.colors.foreground, heading: theme.colors.foreground }} />
        </box>
      ) : null}
    </>
  );
}

const FILE_ACTION_TONES: Readonly<Record<string, (theme: Theme) => string>> = {
  create: (theme) => theme.colors.success,
  delete: (theme) => theme.colors.error,
  modify: (theme) => theme.colors.warning
};

/**
 * A plan's sections (Requirements, Investigation, File changes, Plan, Acceptance
 * criteria) or the clarify questions, then the approval hint. Headings and the hint are
 * labels (`chromeId`), so search skips them as `workflowTexts` does.
 */
function WorkflowBody({ view, index, theme }: { view: WorkflowView; index: number; theme: Theme }): ReactNode {
  return (
    <box flexDirection="column" width="100%" paddingLeft={OUTPUT_INDENT} flexShrink={0}>
      {view.sections.map((section, at) => (
        <box key={at} flexDirection="column" width="100%" flexShrink={0} marginTop={at === 0 ? 0 : 1}>
          {section.heading ? <text id={chromeId("workflow-heading", `${index}-${at}`)} fg={theme.colors.primary} wrapMode="word" width="100%"><b>{section.heading}</b></text> : null}
          {section.kind === "text" ? <text fg={theme.colors.foreground} wrapMode="word" width="100%">{section.text}</text> : null}
          {section.kind === "list" ? section.items.map((item, number) => (
            <text key={number} fg={theme.colors.foreground} wrapMode="word" width="100%">{`${number + 1}. ${item}`}</text>
          )) : null}
          {section.kind === "files" ? section.files.map((file, fileIndex) => (
            <box key={`${file.path}-${fileIndex}`} flexDirection="column" width="100%" flexShrink={0} marginTop={fileIndex === 0 ? 0 : 1}>
              <text wrapMode="word" width="100%">
                <span fg={(FILE_ACTION_TONES[file.action] ?? ((value: Theme) => value.colors.info))(theme)}>{file.action}</span>
                <span fg={theme.colors.accent}>{` ${file.path}`}</span>
              </text>
              {file.description ? <text fg={theme.colors.mutedForeground} wrapMode="word" width="100%">{file.description}</text> : null}
              {file.snippet ? <SnippetView snippet={file.snippet} path={file.path} theme={theme} /> : null}
            </box>
          )) : null}
        </box>
      ))}
      {view.hint ? <text id={chromeId("workflow-hint", index)} fg={theme.colors.warning} wrapMode="word" width="100%" marginTop={1}>{view.hint}</text> : null}
    </box>
  );
}

/** A planned change's code, highlighted by its path's language when a parser covers it. */
function SnippetView({ snippet, path, theme }: { snippet: string; path: string; theme: Theme }): ReactNode {
  const style = useCodeStyle(theme);
  const filetype = codeFiletype(path);
  return (
    <box width="100%" border={["left"]} borderStyle="single" borderColor={theme.colors.border} paddingLeft={1} flexShrink={0}>
      {filetype
        ? <code content={snippet} filetype={filetype} syntaxStyle={style} fg={theme.colors.foreground} wrapMode="word" width="100%" conceal={false} />
        : <text fg={theme.colors.foreground} wrapMode="word" width="100%">{snippet}</text>}
    </box>
  );
}

function ExpandRow({ id, hidden, canCollapse, onToggle, theme }: { id: string; hidden: number; canCollapse: boolean; onToggle: () => void; theme: Theme }): ReactNode {
  if (hidden > 0) return <ToggleRow id={id} label={`▸ Show ${hidden} more ${hidden === 1 ? "line" : "lines"}`} hint="toggleToolOutput" onToggle={onToggle} theme={theme} />;
  return canCollapse ? <ToggleRow id={id} label="▾ Show less" hint="toggleToolOutput" onToggle={onToggle} theme={theme} /> : null;
}

/**
 * An edit's file changes inline: a clickable `▾ Diff +3 -1` header that hides
 * or shows them, then one OpenTUI `<diff>` per file. Long diffs collapse to
 * COLLAPSED_OUTPUT_LINES rows like other output.
 */
function DiffSection({ index, diffs, shown, onToggleShown, expanded, onToggle, theme }: {
  index: number;
  diffs: readonly FileDiff[];
  shown: boolean;
  onToggleShown: () => void;
  expanded: boolean;
  onToggle: () => void;
  theme: Theme;
}): ReactNode {
  const added = diffs.reduce((sum, diff) => sum + diff.added, 0);
  const removed = diffs.reduce((sum, diff) => sum + diff.removed, 0);
  const multi = diffs.length > 1;
  // Rows: diff lines, plus a file-name row per file when there are several.
  const rows = diffs.reduce((sum, diff) => sum + Math.max(diff.body.length, diff.note ? 1 : 0) + (multi ? 1 : 0), 0);
  const hidden = expanded ? 0 : Math.max(0, rows - COLLAPSED_OUTPUT_LINES);
  const files = multi ? `${diffs.length} files` : (diffs[0] ? fileLabel(diffs[0]) : "");
  return (
    <>
      <text id={chromeId("diff-header", index)} wrapMode="none" paddingLeft={OUTPUT_INDENT} flexShrink={0} onMouseDown={onToggleShown}>
        <span fg={theme.colors.info}>{shown ? "▾ Diff" : "▸ Diff"}</span>
        <span fg={theme.colors.success}>{`  +${added}`}</span>
        <span fg={theme.colors.error}>{` -${removed}`}</span>
        <span fg={theme.colors.mutedForeground}>{`  ${files}${shown ? "" : `  (click, or ${actionLabel("toggleDiffs")} for all)`}`}</span>
      </text>
      {shown ? (
        <box flexDirection="column" width="100%" paddingLeft={OUTPUT_INDENT} flexShrink={0} height={hidden > 0 ? COLLAPSED_OUTPUT_LINES : undefined} overflow="hidden">
          {diffs.map((diff, file) => (
            <box key={`${diff.path}-${file}`} flexDirection="column" width="100%" flexShrink={0}>
              {multi ? <text id={chromeId("diff-file", `${index}-${file}`)} fg={theme.colors.accent} wrapMode="none" flexShrink={0}>{fileLabel(diff)}</text> : null}
              <FileDiffView diff={diff} theme={theme} />
            </box>
          ))}
        </box>
      ) : null}
      {shown ? <ExpandRow id={chromeId("diff-toggle", index)} hidden={hidden} canCollapse={expanded && rows > COLLAPSED_OUTPUT_LINES} onToggle={onToggle} theme={theme} /> : null}
    </>
  );
}

function fileLabel(diff: FileDiff): string {
  return diff.status === "added" ? `${diff.path} (new)` : diff.path;
}

/**
 * One file's change: OpenTUI `<diff>` when the line numbers are real, tinted
 * +/- lines otherwise (OpenTUI draws signs in its line-number gutter), or a
 * note for binary and oversized changes.
 */
function FileDiffView({ diff, theme }: { diff: FileDiff; theme: Theme }): ReactNode {
  if (diff.note) return <text fg={theme.colors.mutedForeground} wrapMode="none" flexShrink={0}>{`(${diff.note})`}</text>;
  if (!diff.exactLines) return <DiffLines lines={diff.body} theme={theme} />;
  return <HighlightedDiff diff={diff} theme={theme} />;
}

/** OpenTUI `<diff>`, highlighted by the edited file's language when a parser covers it. */
function HighlightedDiff({ diff, theme }: { diff: FileDiff; theme: Theme }): ReactNode {
  const style = useCodeStyle(theme);
  const { diff: colors } = useAppColors();
  const filetype = codeFiletype(diff.path);
  return (
    <diff
      diff={diff.patch}
      {...(filetype ? { filetype, syntaxStyle: style } : {})}
      view="unified"
      width="100%"
      wrapMode="word"
      showLineNumbers
      fg={theme.colors.foreground}
      addedBg={colors.addedBg}
      removedBg={colors.removedBg}
      contextBg={theme.colors.background}
      addedSignColor={theme.colors.success}
      removedSignColor={theme.colors.error}
      lineNumberFg={theme.colors.mutedForeground}
      lineNumberBg={colors.lineNumberBg}
      addedLineNumberBg={colors.addedLineNumberBg}
      removedLineNumberBg={colors.removedLineNumberBg}
    />
  );
}

/** Output starts under the title text, past the status icon and its space. */
const OUTPUT_INDENT = 2;

const LINE_TONE_COLORS: Readonly<Record<DiffLineTone, (theme: Theme) => string>> = {
  added: (theme) => theme.colors.success,
  removed: (theme) => theme.colors.error,
  hunk: (theme) => theme.colors.info,
  plain: (theme) => theme.colors.mutedForeground
};

/** Diff lines with their +/- signs, tinted like the `<diff>` rows. */
function DiffLines({ lines, theme }: { lines: readonly string[]; theme: Theme }): ReactNode {
  const { diff: colors } = useAppColors();
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      {lines.map((line, index) => {
        const tone = diffLineTone(line);
        const bg = tone === "added" ? colors.addedBg : tone === "removed" ? colors.removedBg : undefined;
        const fg = tone === "plain" ? theme.colors.foreground : LINE_TONE_COLORS[tone](theme);
        return <text key={index} fg={fg} bg={bg} width="100%" wrapMode="word" flexShrink={0}>{line || " "}</text>;
      })}
    </box>
  );
}

function ToolOutput({ lines, diff, failed, filetype, theme }: { lines: readonly string[]; diff: boolean; failed: boolean; filetype?: string; theme: Theme }): ReactNode {
  if (filetype && !failed) return <CodeOutput text={lines.join("\n")} filetype={filetype} theme={theme} />;
  if (!diff || failed) {
    return <text fg={failed ? theme.colors.error : theme.colors.mutedForeground} wrapMode="word" width="100%" paddingLeft={OUTPUT_INDENT}>{lines.join("\n")}</text>;
  }
  return (
    <text wrapMode="word" width="100%" paddingLeft={OUTPUT_INDENT}>
      {lines.map((line, index) => (
        <span key={index} fg={LINE_TONE_COLORS[diffLineTone(line)](theme)}>{index === lines.length - 1 ? line : `${line}\n`}</span>
      ))}
    </text>
  );
}

/** A read tool's file contents, highlighted by the read path's language. */
function CodeOutput({ text, filetype, theme }: { text: string; filetype: string; theme: Theme }): ReactNode {
  const style = useCodeStyle(theme);
  // `<code>` draws its text buffer from its own left edge, so the indent comes from a box.
  return (
    <box width="100%" paddingLeft={OUTPUT_INDENT} flexShrink={0}>
      {/* Source, not a rendered document: `# Title` and `**bold**` keep their markers (OpenTUI conceals by default). */}
      <code content={text} filetype={filetype} syntaxStyle={style} fg={theme.colors.foreground} wrapMode="word" width="100%" conceal={false} />
    </box>
  );
}

function ToggleRow({ id, label, hint, onToggle, theme }: { id: string; label: string; hint: AppAction; onToggle: () => void; theme: Theme }): ReactNode {
  return (
    <text id={id} fg={theme.colors.info} wrapMode="none" paddingLeft={OUTPUT_INDENT} flexShrink={0} onMouseDown={onToggle}>
      {label}
      <span fg={theme.colors.mutedForeground}>{`  (click, or ${actionLabel(hint)} for all)`}</span>
    </text>
  );
}

function ApprovalEntry({ block }: { block: ApprovalBlock }): ReactNode {
  const theme = useTheme();
  const name = block.toolName ?? "tool";
  const status = block.status === "pending" ? "waiting for approval" : block.status;
  const color = block.status === "denied" ? theme.colors.error : theme.colors.warning;
  return (
    <>
      <text wrapMode="word" width="100%">
        <span fg={color}>{block.status === "pending" ? "⚠" : block.status === "approved" ? "✓" : "✗"}</span>
        <span fg={color}>{` Approval · ${name} · ${status}`}</span>
      </text>
      {block.resolutionReason
        ? <text fg={theme.colors.mutedForeground} wrapMode="word" width="100%" paddingLeft={OUTPUT_INDENT}>{normalize(block.resolutionReason)}</text>
        : null}
    </>
  );
}
