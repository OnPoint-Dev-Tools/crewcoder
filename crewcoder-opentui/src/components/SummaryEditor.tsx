import type { TextareaRenderable } from "@opentui/core";
import { useEffect, type ReactNode, type RefObject } from "react";
import type { SummaryEditorState } from "../command-runner.js";
import { useTheme } from "../hooks/use-theme.js";
import { actionLabel } from "../keybindings.js";

export type SummaryEditorProps = {
  editor: SummaryEditorState;
  editorRef: RefObject<TextareaRenderable | null>;
  /** Text rows (`summaryEditorTextRows`); the editor adds its border and hint row. */
  textRows: number;
};

/**
 * `/compact preview`: edit the proposed compaction summary before it is
 * installed. It gates a live compaction, so it is a focused editor, not a log.
 * Keys (apply / reset / cancel) are routed by App through DEFAULT_APP_KEYBINDINGS.
 */
export function SummaryEditor({ editor, editorRef, textRows }: SummaryEditorProps): ReactNode {
  const theme = useTheme();
  // Open with the cursor after the summary, so typing appends instead of prepending.
  useEffect(() => {
    editorRef.current?.gotoBufferEnd();
  }, [editorRef, editor]);
  const counts = editor.originalMessageCount !== undefined && editor.retainedMessageCount !== undefined
    ? ` · ${editor.originalMessageCount} → ${editor.retainedMessageCount} messages` : "";
  const title = ` Edit compaction summary${editor.source ? ` · ${editor.source}` : ""}${counts} `;
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={theme.colors.focusRing} title={title} titleColor={theme.colors.mutedForeground} paddingLeft={1} paddingRight={1} flexShrink={0}>
      <textarea
        ref={editorRef}
        focused
        height={textRows}
        wrapMode="word"
        initialValue={editor.summary}
        textColor={theme.colors.foreground}
        focusedTextColor={theme.colors.foreground}
      />
      <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>
        {`${actionLabel("summaryApply")} apply · ${actionLabel("summaryReset")} reset · ${actionLabel("summaryCancel")} cancel`}
      </text>
    </box>
  );
}
