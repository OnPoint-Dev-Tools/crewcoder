import type { BorderCharacters, ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import type { ReactNode, Ref } from "react";
import { reasoningIcon, type GlyphSet } from "../glyphs.js";
import { useGlyphSet } from "../hooks/use-glyph-set.js";
import { useTheme } from "../hooks/use-theme.js";
import { codeBlock, useMarkdownStyle, type MarkdownColors } from "../markdown-style.js";
import { bodyColor, DIFF_COLORS, toneColor } from "../theme.js";
import { toolDiffs, type FileDiff } from "../tool-diff.js";
import { clampOutput, COLLAPSED_OUTPUT_LINES, diffLineTone, toolPresentation, type DiffLineTone } from "../tool-presentation.js";
import { actionLabel, type AppAction } from "../keybindings.js";
import { blockToRow, isStreaming, normalize, transcriptSections, type ApprovalBlock, type ToolBlock, type ToolExpansion, type WorkBlock } from "../transcript.js";
import { Spinner } from "./ui/spinner.js";
import type { Theme } from "./ui/types.js";

export type TranscriptProps = {
  blocks: readonly TuiEventBlock[];
  running: boolean;
  cwd: string;
  expansion: ToolExpansion;
  scrollRef?: Ref<ScrollBoxRenderable>;
};

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
export function Transcript({ blocks, running, cwd, expansion, scrollRef }: TranscriptProps): ReactNode {
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
        <box key={`${section.kind}-${section.start}`} flexDirection="column" width="100%" flexShrink={0} marginTop={index === 0 ? 0 : 1}>
          {section.kind === "work"
            ? <AgentWork blocks={section.blocks} cwd={cwd} expansion={expansion} glyphs={glyphs} />
            : <BlockView block={section.block} streaming={isStreaming(section.block, section.start === lastIndex, running)} glyphs={glyphs} />}
        </box>
      ))}
    </scrollbox>
  );
}

function BlockView({ block, streaming, glyphs }: { block: TuiEventBlock; streaming: boolean; glyphs: GlyphSet }): ReactNode {
  if (block.type === "thinking") return <ReasoningPanel text={blockToRow(block).text} streaming={streaming} glyphs={glyphs} />;
  if (block.type === "assistant") return <AssistantMessage text={blockToRow(block).text} streaming={streaming} />;
  return <RowView block={block} />;
}

/** `CREW CODER`, then the reply as markdown. */
function AssistantMessage({ text, streaming }: { text: string; streaming: boolean }): ReactNode {
  const theme = useTheme();
  return (
    <>
      <text fg={theme.colors.success} wrapMode="none" flexShrink={0}><b>CREW CODER</b></text>
      <MarkdownText text={text} streaming={streaming} colors={{ base: bodyColor(theme, "assistant"), heading: theme.colors.primary }} />
    </>
  );
}

/**
 * Reasoning after termcn's `thinking-block`: amber single border, bold
 * `💭 Reasoning` header (`∴` where emoji clip), blank row, markdown. Always
 * expanded: thinking summaries must stay visible (event-rendering guardrails).
 */
function ReasoningPanel({ text, streaming, glyphs }: { text: string; streaming: boolean; glyphs: GlyphSet }): ReactNode {
  const theme = useTheme();
  return (
    <box flexDirection="column" width="100%" border borderStyle="single" borderColor={theme.colors.warning} paddingLeft={1} paddingRight={1}>
      <text wrapMode="none" flexShrink={0}>
        <span>{`${reasoningIcon(glyphs)} `}</span>
        <span fg={theme.colors.warning}><b>{REASONING_LABEL}</b></span>
      </text>
      {/* Trailing blank lines between reasoning summaries would only pad the panel. */}
      <box marginTop={1} width="100%">
        <MarkdownText text={text.trimEnd()} streaming={streaming} colors={{ base: theme.colors.foreground, heading: theme.colors.foreground }} />
      </box>
    </box>
  );
}

function MarkdownText({ text, streaming, colors }: { text: string; streaming: boolean; colors: MarkdownColors }): ReactNode {
  const theme = useTheme();
  const renderer = useRenderer();
  const style = useMarkdownStyle(theme, colors);
  return (
    <markdown
      content={text}
      syntaxStyle={style}
      fg={colors.base}
      width="100%"
      streaming={streaming}
      conceal
      tableOptions={{ borderColor: theme.colors.border, wrapMode: "word", widthMode: "content", cellPaddingX: 1 }}
      renderBlock={(block) => (block.kind === "code" ? codeBlock(renderer, theme, block) : undefined)}
    />
  );
}

/** Label row, plain text, and optional muted detail (user background, ...). */
function RowView({ block }: { block: TuiEventBlock }): ReactNode {
  const theme = useTheme();
  const row = blockToRow(block);
  return (
    <>
      <text fg={toneColor(theme, row.tone)} wrapMode="word" width="100%"><b>{row.label}</b></text>
      {row.text ? <text fg={bodyColor(theme, row.tone)} wrapMode="word" width="100%">{row.text}</text> : null}
      {row.detail ? <text fg={theme.colors.mutedForeground} wrapMode="word" width="100%">{row.detail}</text> : null}
    </>
  );
}

/**
 * Consecutive tool calls and approvals in one dashed box titled `Agent work`.
 * Running tools show here live, with a spinner, as soon as they start.
 */
function AgentWork({ blocks, cwd, expansion, glyphs }: { blocks: readonly WorkBlock[]; cwd: string; expansion: ToolExpansion; glyphs: GlyphSet }): ReactNode {
  const theme = useTheme();
  return (
    <box
      flexDirection="column"
      width="100%"
      border
      customBorderChars={DASHED_BORDER}
      borderColor={theme.colors.border}
      title={` ${AGENT_WORK_TITLE} `}
      titleColor={theme.colors.primary}
      paddingLeft={1}
      paddingRight={1}
    >
      {blocks.map((block, index) => (
        <box key={block.type === "tool" ? (block.id ?? `tool-${index}`) : (block.id ?? `approval-${index}`)} flexDirection="column" width="100%" flexShrink={0} marginTop={index === 0 ? 0 : 1}>
          {block.type === "tool"
            ? <ToolEntry block={block} cwd={cwd} expansion={expansion} glyphs={glyphs} />
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
function ToolEntry({ block, cwd, expansion, glyphs }: { block: ToolBlock; cwd: string; expansion: ToolExpansion; glyphs: GlyphSet }): ReactNode {
  const theme = useTheme();
  const tool = toolPresentation(block, cwd, glyphs);
  const running = block.status === "running";
  const expanded = expansion.isExpanded(block);
  const onToggle = (): void => expansion.toggle(block);
  const diffs = toolDiffs(block, cwd, expansion.lineAnchors(block));
  // An edit's diff replaces its output ("Edited src/a.ts" says nothing more).
  // Only edit/write tools have diffs; commands show their output alone.
  const text = diffs.length > 0 ? undefined : tool.output;
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
      {output ? <ToolOutput lines={output.lines} diff={tool.diff} failed={tool.failed} theme={theme} /> : null}
      {output ? <ExpandRow hidden={output.hidden} canCollapse={canCollapse} onToggle={onToggle} theme={theme} /> : null}
      {diffs.length > 0
        ? <DiffSection diffs={diffs} shown={expansion.isDiffShown(block)} onToggleShown={() => expansion.toggleDiff(block)} expanded={expanded} onToggle={onToggle} theme={theme} />
        : null}
    </>
  );
}

function ExpandRow({ hidden, canCollapse, onToggle, theme }: { hidden: number; canCollapse: boolean; onToggle: () => void; theme: Theme }): ReactNode {
  if (hidden > 0) return <ToggleRow label={`▸ Show ${hidden} more ${hidden === 1 ? "line" : "lines"}`} hint="toggleToolOutput" onToggle={onToggle} theme={theme} />;
  return canCollapse ? <ToggleRow label="▾ Show less" hint="toggleToolOutput" onToggle={onToggle} theme={theme} /> : null;
}

/**
 * An edit's file changes inline: a clickable `▾ Diff +3 -1` header that hides
 * or shows them, then one OpenTUI `<diff>` per file. Long diffs collapse to
 * COLLAPSED_OUTPUT_LINES rows like other output.
 */
function DiffSection({ diffs, shown, onToggleShown, expanded, onToggle, theme }: {
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
      <text wrapMode="none" paddingLeft={OUTPUT_INDENT} flexShrink={0} onMouseDown={onToggleShown}>
        <span fg={theme.colors.info}>{shown ? "▾ Diff" : "▸ Diff"}</span>
        <span fg={theme.colors.success}>{`  +${added}`}</span>
        <span fg={theme.colors.error}>{` -${removed}`}</span>
        <span fg={theme.colors.mutedForeground}>{`  ${files}${shown ? "" : `  (click, or ${actionLabel("toggleDiffs")} for all)`}`}</span>
      </text>
      {shown ? (
        <box flexDirection="column" width="100%" paddingLeft={OUTPUT_INDENT} flexShrink={0} height={hidden > 0 ? COLLAPSED_OUTPUT_LINES : undefined} overflow="hidden">
          {diffs.map((diff, index) => (
            <box key={`${diff.path}-${index}`} flexDirection="column" width="100%" flexShrink={0}>
              {multi ? <text fg={theme.colors.accent} wrapMode="none" flexShrink={0}>{fileLabel(diff)}</text> : null}
              <FileDiffView diff={diff} theme={theme} />
            </box>
          ))}
        </box>
      ) : null}
      {shown ? <ExpandRow hidden={hidden} canCollapse={expanded && rows > COLLAPSED_OUTPUT_LINES} onToggle={onToggle} theme={theme} /> : null}
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
  return (
    <diff
      diff={diff.patch}
      view="unified"
      width="100%"
      wrapMode="word"
      showLineNumbers
      fg={theme.colors.foreground}
      addedBg={DIFF_COLORS.addedBg}
      removedBg={DIFF_COLORS.removedBg}
      contextBg={theme.colors.background}
      addedSignColor={theme.colors.success}
      removedSignColor={theme.colors.error}
      lineNumberFg={theme.colors.mutedForeground}
      lineNumberBg={DIFF_COLORS.lineNumberBg}
      addedLineNumberBg={DIFF_COLORS.addedLineNumberBg}
      removedLineNumberBg={DIFF_COLORS.removedLineNumberBg}
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
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      {lines.map((line, index) => {
        const tone = diffLineTone(line);
        const bg = tone === "added" ? DIFF_COLORS.addedBg : tone === "removed" ? DIFF_COLORS.removedBg : undefined;
        const fg = tone === "plain" ? theme.colors.foreground : LINE_TONE_COLORS[tone](theme);
        return <text key={index} fg={fg} bg={bg} width="100%" wrapMode="word" flexShrink={0}>{line || " "}</text>;
      })}
    </box>
  );
}

function ToolOutput({ lines, diff, failed, theme }: { lines: readonly string[]; diff: boolean; failed: boolean; theme: Theme }): ReactNode {
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

function ToggleRow({ label, hint, onToggle, theme }: { label: string; hint: AppAction; onToggle: () => void; theme: Theme }): ReactNode {
  return (
    <text fg={theme.colors.info} wrapMode="none" paddingLeft={OUTPUT_INDENT} flexShrink={0} onMouseDown={onToggle}>
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
