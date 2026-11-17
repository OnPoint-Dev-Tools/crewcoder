import { describe, expect, it } from "vitest";
import { choiceAnswer, optionRows, QUESTION_CHROME_ROWS, questionMaxRows, questionView, wrapText, type QuestionBlock } from "../question-model.js";

function block(overrides: Partial<QuestionBlock>): QuestionBlock {
  return { type: "extension_ui", requestId: "r-1", extensionId: "ext", uiKind: "confirm", title: "Proceed?", status: "pending", ...overrides };
}

describe("question model", () => {
  it("wraps words to the width and splits words longer than a row", () => {
    expect(wrapText("one two three", 7)).toEqual(["one two", "three"]);
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("sizes confirm and input questions from the wrapped question", () => {
    const confirm = questionView(block({ title: "Delete the build folder and start over?", message: "This cannot be undone." }), 20, 30);
    expect(confirm.question.map((line) => line.text)).toEqual(["Delete the build", "folder and start", "over?", "", "This cannot be", "undone."]);
    expect(confirm.height).toBe(QUESTION_CHROME_ROWS + 6 + 1);
    expect(questionView(block({ uiKind: "input" }), 40, 30).height).toBe(QUESTION_CHROME_ROWS + 1 + 1);
  });

  it("wraps option labels and indents descriptions; every row maps to its option", () => {
    const rows = optionRows([{ label: "Use the faster cache layer", description: "Saves time on repeated builds" }, { label: "Skip" }], 14);
    expect(rows).toEqual([
      { option: 0, text: "Use the", kind: "label", leading: true },
      { option: 0, text: "faster cache", kind: "label", leading: false },
      { option: 0, text: "layer", kind: "label", leading: false },
      { option: 0, text: "Saves time", kind: "description", leading: false },
      { option: 0, text: "on", kind: "description", leading: false },
      { option: 0, text: "repeated", kind: "description", leading: false },
      { option: 0, text: "builds", kind: "description", leading: false },
      { option: -1, text: "", kind: "spacer", leading: false },
      { option: 1, text: "Skip", kind: "label", leading: true }
    ]);
    expect(optionRows([{ label: "a" }, { label: "b" }], 10).map((row) => row.kind)).toEqual(["label", "label"]);
  });

  it("windows a long option list so the whole selected option stays visible", () => {
    const options = Array.from({ length: 20 }, (_, index) => ({ label: `option ${index}`, value: `v${index}` }));
    const view = questionView(block({ uiKind: "select", options }), 40, 12, 15);
    expect(view.height).toBeLessThanOrEqual(12);
    expect(view.options.some((row) => row.option === 15 && row.leading)).toBe(true);
    expect(view.cursor).toBe(15);
  });

  it("windows a long question and keeps room for the reply", () => {
    const title = Array.from({ length: 40 }, (_, index) => `line${index}`).join("\n");
    const top = questionView(block({ uiKind: "select", title, options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] }), 40, 14);
    expect(top.clipped).toBe(true);
    expect(top.options).toHaveLength(2);
    expect(top.height).toBeLessThanOrEqual(14);
    expect(top.question[0]?.text).toBe("line0");
    const scrolled = questionView(block({ uiKind: "select", title, options: [{ label: "A", value: "a" }] }), 40, 14, 0, 999);
    expect(scrolled.question.at(-1)?.text).toBe("line39");
  });

  it("answers with the original option value, the action id, or a boolean", () => {
    expect(choiceAnswer(block({ uiKind: "confirm" }), 0)).toBe(true);
    expect(choiceAnswer(block({ uiKind: "confirm" }), 1)).toBe(false);
    expect(choiceAnswer(block({ uiKind: "select", options: [{ label: "Fast", value: "fast-path" }] }), 0)).toBe("fast-path");
    expect(choiceAnswer(block({ uiKind: "component", actions: [{ id: "open", label: "Open" }] }), 0)).toBe("open");
    expect(choiceAnswer(block({ uiKind: "component" }), 0)).toBe("close");
  });

  it("strips terminal control sequences from agent text", () => {
    const view = questionView(block({ title: "\x1b[31mred\x1b[0m title" }), 40, 30);
    expect(view.question[0]?.text).toBe("red title");
  });

  it("renders declarative component bodies as rows", () => {
    const view = questionView(block({ uiKind: "component", component: { kind: "details", items: [{ label: "Branch", value: "main" }] } }), 40, 30);
    expect(view.body).toEqual(["Branch: main"]);
    expect(view.options.map((row) => row.text)).toEqual(["Close"]);
    expect(view.height).toBe(QUESTION_CHROME_ROWS + 1 + 1 + 1 + 1);
  });

  it("never asks for more rows than the terminal allows", () => {
    expect(questionMaxRows(24)).toBe(22);
    expect(questionMaxRows(100)).toBe(30);
  });
});
