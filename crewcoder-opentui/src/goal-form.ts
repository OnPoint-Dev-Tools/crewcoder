import type { GoalStartInput } from "@onpoint-dev-tools/crewcoder-tui-core/state/command-results";

/**
 * The bare `/goal` preflight form (`docs/COMMAND_PALETTE.md#goal`), ported from legacy `GoalOverlay`:
 * objective, max turns, check model, and timeout for this goal only, prefilled from
 * `config.goals`. Pure: state, validation, and the start input; `GoalForm` only draws.
 */

export type GoalField = "objective" | "maxTurns" | "checkModel" | "timeoutMinutes";

export const GOAL_FIELDS: ReadonlyArray<{ key: GoalField; label: string; hint: string }> = [
  { key: "objective", label: "Objective", hint: "stopping contract and required validation" },
  { key: "maxTurns", label: "Max turns", hint: "supervisor cycles · 1–10000" },
  { key: "checkModel", label: "Check model", hint: "same provider · blank disables verifier" },
  { key: "timeoutMinutes", label: "Timeout", hint: "wall-clock minutes · 1–43200" }
];

export const MAX_GOAL_TURNS = 10_000;
export const MAX_GOAL_TIMEOUT_MINUTES = 43_200;

/** Legacy defaults when `config.goals` is missing. */
export const DEFAULT_GOAL_SETTINGS = { maxTurns: 200, timeoutMinutes: 480 } as const;

export type GoalFormState = {
  values: Readonly<Record<GoalField, string>>;
  /** Index into `GOAL_FIELDS`. */
  selected: number;
  error?: string;
};

export type GoalDefaults = { maxTurns: number; timeoutMinutes: number; checkModel?: string };

/** `config.goals` from `crewcoder config show --json`, falling back field by field to the legacy defaults. */
export function goalDefaults(config: unknown): GoalDefaults {
  const goals = config && typeof config === "object" ? (config as Record<string, unknown>).goals : undefined;
  const record = goals && typeof goals === "object" && !Array.isArray(goals) ? goals as Record<string, unknown> : {};
  const maxTurns = boundedInteger(record.maxTurns, MAX_GOAL_TURNS) ?? DEFAULT_GOAL_SETTINGS.maxTurns;
  const timeoutMinutes = boundedInteger(record.timeoutMinutes, MAX_GOAL_TIMEOUT_MINUTES) ?? DEFAULT_GOAL_SETTINGS.timeoutMinutes;
  const checkModel = typeof record.checkModel === "string" && record.checkModel.trim() ? record.checkModel.trim() : undefined;
  return { maxTurns, timeoutMinutes, ...(checkModel ? { checkModel } : {}) };
}

export function initialGoalForm(defaults: GoalDefaults): GoalFormState {
  return {
    values: { objective: "", maxTurns: String(defaults.maxTurns), checkModel: defaults.checkModel ?? "", timeoutMinutes: String(defaults.timeoutMinutes) },
    selected: 0
  };
}

/** Move to another field (clamped); the error clears. */
export function selectGoalField(form: GoalFormState, index: number): GoalFormState {
  return { values: form.values, selected: Math.max(0, Math.min(GOAL_FIELDS.length - 1, index)) };
}

/** Set the selected field's text; the error clears. */
export function editGoalField(form: GoalFormState, value: string): GoalFormState {
  const key = GOAL_FIELDS[form.selected]?.key ?? "objective";
  return { values: { ...form.values, [key]: value }, selected: form.selected };
}

/**
 * The goal to start, or the form with an error on the first bad field. A blank check
 * model turns the verifier off for this goal (legacy), not "use the default".
 */
export function submitGoalForm(form: GoalFormState): { start: GoalStartInput } | { form: GoalFormState } {
  const objective = form.values.objective.trim();
  const maxTurns = boundedInteger(form.values.maxTurns.trim(), MAX_GOAL_TURNS);
  const timeoutMinutes = boundedInteger(form.values.timeoutMinutes.trim(), MAX_GOAL_TIMEOUT_MINUTES);
  const invalid = (field: GoalField, error: string) => ({ form: { values: form.values, selected: GOAL_FIELDS.findIndex((item) => item.key === field), error } });
  if (!objective) return invalid("objective", "Objective is required.");
  if (maxTurns === undefined) return invalid("maxTurns", `Max turns must be an integer from 1 to ${MAX_GOAL_TURNS}.`);
  if (timeoutMinutes === undefined) return invalid("timeoutMinutes", `Timeout must be an integer from 1 to ${MAX_GOAL_TIMEOUT_MINUTES} minutes.`);
  const checkModel = form.values.checkModel.trim();
  return { start: { objective, maxTurns, timeoutMinutes, ...(checkModel ? { checkModel } : { disableCheckModel: true }) } };
}

function boundedInteger(value: unknown, maximum: number): number | undefined {
  if (value === "" || value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : undefined;
}

