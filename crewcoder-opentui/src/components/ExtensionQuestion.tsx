import type { InputRenderable } from "@opentui/core";
import type { ReactNode, RefObject } from "react";
import { useTheme } from "../hooks/use-theme.js";
import { actionLabel } from "../keybindings.js";
import type { QuestionBlock, QuestionView } from "../question-model.js";
import { Confirm } from "./ui/confirm.js";
import { Select } from "./ui/select.js";

export type ExtensionQuestionProps = {
  block: QuestionBlock;
  view: QuestionView;
  inputRef: RefObject<InputRenderable | null>;
  /** A click on a choice (option index; for confirm 0 = Yes, 1 = No). */
  onChoose: (choice: number) => void;
};

/**
 * Answers an extension's `ctx.ui.confirm/input/select/component` request. It
 * gates a live extension call, so it is a focused card, not a log. Shows the
 * question and the reply controls only, without extension or request ids.
 * Rows come from `questionView`, so its height matches `view.height`.
 */
export function ExtensionQuestion({ block, view, inputRef, onChoose }: ExtensionQuestionProps): ReactNode {
  const theme = useTheme();
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={theme.colors.focusRing} paddingLeft={1} paddingRight={1} flexShrink={0}>
      {view.question.map((line, index) => (
        <text key={`q-${index}`} fg={line.title ? theme.colors.primary : theme.colors.foreground} height={1} wrapMode="none" flexShrink={0}>
          {line.title ? <b>{line.text}</b> : line.text}
        </text>
      ))}
      {view.clipped ? (
        <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>
          {`${actionLabel("questionScrollUp")}/${actionLabel("questionScrollDown")} to read the whole question`}
        </text>
      ) : null}
      <text height={1} flexShrink={0} />
      {reply(block, view, inputRef, onChoose)}
      <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>{hint(block.uiKind)}</text>
    </box>
  );
}

function reply(block: QuestionBlock, view: QuestionView, inputRef: RefObject<InputRenderable | null>, onChoose: (choice: number) => void): ReactNode {
  if (block.uiKind === "confirm") {
    return <Confirm selected={view.cursor === 0} onConfirm={() => onChoose(0)} onCancel={() => onChoose(1)} />;
  }
  if (block.uiKind === "input") {
    return <QuestionInput block={block} inputRef={inputRef} />;
  }
  if (block.uiKind === "select") {
    return <Select rows={view.options} active={view.cursor} onChoose={onChoose} />;
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      <ComponentBody lines={view.body} />
      {view.body.length ? <text height={1} flexShrink={0} /> : null}
      <Select rows={view.options} active={view.cursor} onChoose={onChoose} />
    </box>
  );
}

function QuestionInput({ block, inputRef }: { block: QuestionBlock; inputRef: RefObject<InputRenderable | null> }): ReactNode {
  const theme = useTheme();
  return (
    <box flexDirection="row" height={1} gap={1} flexShrink={0}>
      <text fg={theme.colors.primary} wrapMode="none">›</text>
      <input
        ref={inputRef}
        focused
        flexGrow={1}
        value={block.defaultValue ?? ""}
        placeholder={block.placeholder ?? "Type a reply"}
        placeholderColor={theme.colors.mutedForeground}
        textColor={theme.colors.foreground}
        focusedTextColor={theme.colors.foreground}
      />
    </box>
  );
}

function ComponentBody({ lines }: { lines: readonly string[] }): ReactNode {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexShrink={0}>
      {lines.map((line, index) => (
        <text key={index} fg={theme.colors.foreground} height={1} wrapMode="none" flexShrink={0}>{line}</text>
      ))}
    </box>
  );
}

function hint(kind: QuestionBlock["uiKind"]): string {
  const submit = actionLabel("questionSubmit");
  const cancel = actionLabel("questionCancel");
  if (kind === "confirm") return `${actionLabel("questionYes")} yes · ${actionLabel("questionNo")} no · ${submit} select · ${cancel} cancel`;
  if (kind === "input") return `${submit} send · ${cancel} cancel`;
  return `↑↓ choose · ${submit} select · ${cancel} cancel`;
}
