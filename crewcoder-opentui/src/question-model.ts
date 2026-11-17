import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { normalize } from "./transcript.js";

/**
 * Pure model for extension UI questions (`extension_ui_request`). The footer
 * sizer, `App`, and `ExtensionQuestion` all derive rows from `questionView`, so
 * the footer height always equals what renders and the cursor indexes the same
 * options that are drawn.
 *
 * Question text, option labels, and option descriptions wrap rather than
 * truncate: agent-authored questions are usually a full sentence and their
 * options carry the rationale needed to choose (see the legacy
 * `ExtensionUiOverlay`).
 */
export type QuestionBlock = Extract<TuiEventBlock, { type: "extension_ui" }>;

/** The value written back over the `ui_response` control channel; `null` cancels. */
export type QuestionAnswer = string | boolean | null;

export type QuestionOption = { label: string; description?: string };

/** One drawn row of an option list; every row of an option maps back to it (mouse clicks). */
export type OptionRow = { option: number; text: string; kind: "label" | "description" | "spacer"; leading: boolean };

export type QuestionLine = { text: string; title: boolean };

export type QuestionView = {
  kind: QuestionBlock["uiKind"];
  /** Visible question lines (title, then message), windowed by `offset`. */
  question: QuestionLine[];
  /** The question is longer than its share; a scroll hint row is drawn. */
  clipped: boolean;
  /** The applied (clamped) question scroll offset. */
  offset: number;
  /** Declarative component content (`component` kind). */
  body: string[];
  /** Visible option rows (select options or component actions), windowed around the cursor. */
  options: OptionRow[];
  /** The applied (clamped) cursor. */
  cursor: number;
  /** Total rows, including border, separator, and hint. */
  height: number;
};

/** Border (2) + blank row between question and reply (1) + hint row (1). */
export const QUESTION_CHROME_ROWS = 4;
/** Border (2) + left/right padding (2). */
export const QUESTION_HORIZONTAL_CHROME = 4;
/** Reply rows kept visible before a long question is windowed. */
const REPLY_RESERVE_ROWS = 6;
const MAX_QUESTION_ROWS = 30;
const MAX_COMPONENT_ROWS = 8;
const MAX_TABLE_COLUMNS = 4;
const MAX_TABLE_ROWS = 6;
const LABEL_INDENT = 2;
const DESCRIPTION_INDENT = 4;

/** Most rows the question card may take on a terminal this tall. */
export function questionMaxRows(terminalHeight: number): number {
  return Math.max(QUESTION_CHROME_ROWS + 2, Math.min(MAX_QUESTION_ROWS, terminalHeight - 2));
}

/** Text columns inside the card on a terminal this wide. */
export function questionContentWidth(terminalWidth: number): number {
  return Math.max(8, terminalWidth - QUESTION_HORIZONTAL_CHROME);
}

/** Choices the cursor moves over: select options, component actions, or Yes/No. */
export function questionChoices(block: QuestionBlock): QuestionOption[] {
  if (block.uiKind === "select") return (block.options ?? []).map(({ label, description }) => ({ label: normalize(label), description: description ? normalize(description) : undefined }));
  if (block.uiKind === "component") return componentActions(block).map(({ label, description }) => ({ label: normalize(label), description: description ? normalize(description) : undefined }));
  if (block.uiKind === "confirm") return [{ label: "Yes" }, { label: "No" }];
  return [];
}

/** The answer for the choice at `cursor`. Input answers come from the text field instead. */
export function choiceAnswer(block: QuestionBlock, cursor: number): QuestionAnswer {
  if (block.uiKind === "confirm") return cursor === 0;
  if (block.uiKind === "select") return block.options?.[cursor]?.value ?? null;
  if (block.uiKind === "component") return componentActions(block)[cursor]?.id ?? "close";
  return null;
}

export function questionView(block: QuestionBlock, width: number, maxRows: number, cursor = 0, offset = 0): QuestionView {
  const inner = Math.max(1, maxRows - QUESTION_CHROME_ROWS);
  const choices = questionChoices(block);
  const clampedCursor = Math.max(0, Math.min(Math.max(0, choices.length - 1), cursor));
  const allOptions = block.uiKind === "select" || block.uiKind === "component" ? optionRows(choices, width) : [];
  const allBody = block.uiKind === "component" ? componentBody(block, width) : [];
  const replyFull = block.uiKind === "component"
    ? allBody.length + (allBody.length ? 1 : 0) + allOptions.length
    : block.uiKind === "select" ? Math.max(1, allOptions.length) : 1;

  const allQuestion = questionLines(block, width);
  const questionBudget = Math.max(1, inner - Math.min(replyFull, REPLY_RESERVE_ROWS));
  const clipped = allQuestion.length > questionBudget;
  const shown = clipped ? Math.max(1, questionBudget - 1) : allQuestion.length;
  const appliedOffset = Math.max(0, Math.min(allQuestion.length - shown, offset));
  const question = allQuestion.slice(appliedOffset, appliedOffset + shown);

  const replyBudget = Math.max(1, inner - shown - (clipped ? 1 : 0));
  let body: string[] = [];
  let options: OptionRow[] = [];
  if (block.uiKind === "select") {
    options = windowOptions(allOptions, clampedCursor, replyBudget);
  } else if (block.uiKind === "component") {
    options = windowOptions(allOptions, clampedCursor, Math.max(1, Math.min(allOptions.length, replyBudget - 2)));
    body = allBody.slice(0, Math.max(0, replyBudget - options.length - 1));
  }
  const replyRows = block.uiKind === "component"
    ? body.length + (body.length ? 1 : 0) + options.length
    : block.uiKind === "select" ? Math.max(1, options.length) : 1;
  const height = QUESTION_CHROME_ROWS + question.length + (clipped ? 1 : 0) + replyRows;
  return { kind: block.uiKind, question, clipped, offset: appliedOffset, body, options, cursor: clampedCursor, height };
}

/** Word-wrap `text` to `width` columns, splitting words longer than a row. */
export function wrapText(text: string, width: number): string[] {
  const columns = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const logical of text.split("\n")) {
    let line = "";
    for (const word of logical.split(/\s+/).filter(Boolean)) {
      let rest = word;
      if (line && line.length + 1 + rest.length <= columns) {
        line = `${line} ${rest}`;
        continue;
      }
      if (line) lines.push(line);
      while (rest.length > columns) {
        lines.push(rest.slice(0, columns));
        rest = rest.slice(columns);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

function questionLines(block: QuestionBlock, width: number): QuestionLine[] {
  const lines = wrapText(normalize(block.title), width).map((text) => ({ text, title: true }));
  if (block.message) {
    lines.push({ text: "", title: false });
    for (const text of wrapText(normalize(block.message), width)) lines.push({ text, title: false });
  }
  return lines;
}

/**
 * Bulleted, wrapped label rows, then the description indented beneath them. A
 * blank row separates options only when some option has a description, so a
 * plain list stays compact.
 */
export function optionRows(options: readonly QuestionOption[], width: number): OptionRow[] {
  const spaced = options.some((option) => option.description);
  const rows: OptionRow[] = [];
  options.forEach((option, index) => {
    if (index > 0 && spaced) rows.push({ option: -1, text: "", kind: "spacer", leading: false });
    wrapText(option.label, Math.max(1, width - LABEL_INDENT)).forEach((text, line) => {
      rows.push({ option: index, text, kind: "label", leading: line === 0 });
    });
    if (!option.description) return;
    for (const text of wrapText(option.description, Math.max(1, width - DESCRIPTION_INDENT))) {
      rows.push({ option: index, text, kind: "description", leading: false });
    }
  });
  return rows;
}

/** Scroll the option rows so the whole selected option stays visible. */
function windowOptions(rows: OptionRow[], selected: number, height: number): OptionRow[] {
  if (rows.length <= height) return rows;
  const first = rows.findIndex((row) => row.option === selected);
  if (first < 0) return rows.slice(0, height);
  let last = first;
  while (last + 1 < rows.length && rows[last + 1]!.option === selected) last += 1;
  const start = last >= height ? Math.min(last - height + 1, rows.length - height) : 0;
  const from = Math.max(0, Math.min(start, first));
  return rows.slice(from, from + height);
}

function componentActions(block: QuestionBlock): Array<{ id: string; label: string; description?: string }> {
  if (block.actions?.length) return block.actions;
  if (block.component?.kind === "actionList") return block.component.actions;
  return [{ id: "close", label: "Close" }];
}

/** Plain-text rows for a declarative component. `actionList` has none: its actions are the choices. */
function componentBody(block: QuestionBlock, width: number): string[] {
  const component = block.component;
  if (!component) return ["(component payload unavailable)"];
  if (component.kind === "markdown") return wrapText(normalize(component.text), width).slice(0, MAX_COMPONENT_ROWS);
  if (component.kind === "details") {
    return component.items.flatMap((item) => wrapText(`${normalize(item.label)}: ${normalize(item.value)}`, width)).slice(0, MAX_COMPONENT_ROWS);
  }
  if (component.kind === "table") {
    const columns = component.columns.slice(0, MAX_TABLE_COLUMNS);
    if (!columns.length) return ["(no columns)"];
    const cell = Math.max(4, Math.floor(width / columns.length));
    const row = (values: string[]): string => values.map((value) => fit(normalize(value), cell - 1).padEnd(cell)).join("").trimEnd();
    return [
      row(columns.map((column) => column.label)),
      ...component.rows.slice(0, MAX_TABLE_ROWS).map((values) => row(columns.map((column) => String(values[column.key] ?? ""))))
    ];
  }
  return [];
}

function fit(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
}
