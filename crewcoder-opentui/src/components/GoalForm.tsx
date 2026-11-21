import type { InputRenderable } from "@opentui/core";
import type { ReactNode, RefObject } from "react";
import { GOAL_FIELDS, type GoalField, type GoalFormState } from "../goal-form.js";
import { useTheme } from "../hooks/use-theme.js";
import { actionLabel } from "../keybindings.js";

/** What an empty field means: the objective is required; a blank check model turns the verifier off. */
function emptyText(field: GoalField): string {
  return field === "objective" ? "(required)" : "(disabled)";
}

/** Label column width: the longest label ("Check model") plus a space. */
const LABEL_WIDTH = 12;

/**
 * The bare `/goal` preflight form (`goal-form.ts`), in the footer's place like the
 * other overlays: one row per field with its hint under it, the first error, and the
 * keys. Only the selected field is an input (focused); the others show their value.
 * Keys go through `DEFAULT_APP_KEYBINDINGS` in `App`; a click selects a field.
 */
export function GoalForm({ form, maker, inputRef, onInput, onSelect }: {
  form: GoalFormState;
  /** `provider/model` that makes the goal's turns. */
  maker: string;
  inputRef: RefObject<InputRenderable | null>;
  onInput: (value: string) => void;
  onSelect: (index: number) => void;
}): ReactNode {
  const theme = useTheme();
  const keys = `${actionLabel("goalFormNext")}/↑↓ fields · ${actionLabel("goalFormEnter")} next/start · ${actionLabel("goalFormSubmit")} start · ${actionLabel("goalFormCancel")} cancel`;
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={theme.colors.focusRing} paddingLeft={1} paddingRight={1} flexShrink={0}>
      <text fg={theme.colors.primary} height={1} wrapMode="none" flexShrink={0}><b>Start durable goal</b></text>
      <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>{`maker ${maker} · settings apply only to this goal`}</text>
      <box height={1} flexShrink={0} />
      {GOAL_FIELDS.map((field, index) => {
        const active = index === form.selected;
        const value = form.values[field.key];
        return (
          <box key={field.key} flexDirection="column" flexShrink={0} onMouseDown={() => onSelect(index)}>
            <box flexDirection="row" height={1} flexShrink={0}>
              <text fg={active ? theme.colors.primary : theme.colors.mutedForeground} wrapMode="none" flexShrink={0}>{active ? "› " : "  "}</text>
              <text fg={active ? theme.colors.foreground : theme.colors.mutedForeground} wrapMode="none" flexShrink={0}>{field.label.padEnd(LABEL_WIDTH)}</text>
              {active ? (
                <input
                  ref={inputRef}
                  focused
                  flexGrow={1}
                  value={value}
                  placeholder={emptyText(field.key)}
                  placeholderColor={theme.colors.mutedForeground}
                  textColor={theme.colors.foreground}
                  focusedTextColor={theme.colors.foreground}
                  onInput={onInput}
                />
              ) : (
                <text fg={value ? theme.colors.foreground : theme.colors.mutedForeground} wrapMode="none" flexGrow={1} flexShrink={1}>{value || emptyText(field.key)}</text>
              )}
            </box>
            <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0} paddingLeft={2}>{field.hint}</text>
          </box>
        );
      })}
      <text fg={theme.colors.error} height={1} wrapMode="none" flexShrink={0}>{form.error ?? " "}</text>
      <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>{keys}</text>
      <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>Existing goals: /goal status · /goal list · /goal logs</text>
    </box>
  );
}
