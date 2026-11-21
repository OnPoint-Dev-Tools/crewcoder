import { describe, expect, it } from "vitest";
import { DEFAULT_GOAL_SETTINGS, editGoalField, goalDefaults, initialGoalForm, selectGoalField, submitGoalForm } from "../goal-form.js";

describe("goal form", () => {
  it("prefills from config.goals and falls back to the legacy defaults field by field", () => {
    expect(goalDefaults({ goals: { maxTurns: 50, timeoutMinutes: 90, checkModel: " judge " } })).toEqual({ maxTurns: 50, timeoutMinutes: 90, checkModel: "judge" });
    expect(goalDefaults({ goals: { maxTurns: 0, timeoutMinutes: "x" } })).toEqual({ ...DEFAULT_GOAL_SETTINGS });
    expect(goalDefaults({})).toEqual({ ...DEFAULT_GOAL_SETTINGS });
    expect(goalDefaults(null)).toEqual({ ...DEFAULT_GOAL_SETTINGS });
    expect(initialGoalForm({ maxTurns: 50, timeoutMinutes: 90 }).values).toEqual({ objective: "", maxTurns: "50", checkModel: "", timeoutMinutes: "90" });
  });

  it("edits the selected field and clamps selection", () => {
    let form = initialGoalForm({ maxTurns: 1, timeoutMinutes: 1 });
    form = editGoalField(form, "ship it");
    form = selectGoalField(form, 9);
    expect(form.selected).toBe(3);
    form = editGoalField(form, "30");
    expect(form.values).toMatchObject({ objective: "ship it", timeoutMinutes: "30" });
    expect(selectGoalField(form, -2).selected).toBe(0);
  });

  it("starts with the check model, or turns the verifier off when it is blank", () => {
    const base = editGoalField(initialGoalForm({ maxTurns: 200, timeoutMinutes: 480, checkModel: "judge" }), "  pass the tests  ");
    expect(submitGoalForm(base)).toEqual({ start: { objective: "pass the tests", maxTurns: 200, timeoutMinutes: 480, checkModel: "judge" } });
    const noCheck = editGoalField(selectGoalField(base, 2), " ");
    expect(submitGoalForm(noCheck)).toEqual({ start: { objective: "pass the tests", maxTurns: 200, timeoutMinutes: 480, disableCheckModel: true } });
  });

  it("puts the first error on its field", () => {
    const empty = initialGoalForm({ maxTurns: 200, timeoutMinutes: 480 });
    expect(submitGoalForm(empty)).toEqual({ form: expect.objectContaining({ selected: 0, error: "Objective is required." }) });
    const withObjective = editGoalField(empty, "x");
    for (const turns of ["0", "10001", "2.5", ""]) {
      const result = submitGoalForm(editGoalField(selectGoalField(withObjective, 1), turns));
      expect(result).toEqual({ form: expect.objectContaining({ selected: 1, error: "Max turns must be an integer from 1 to 10000." }) });
    }
    const badTimeout = submitGoalForm(editGoalField(selectGoalField(withObjective, 3), "43201"));
    expect(badTimeout).toEqual({ form: expect.objectContaining({ selected: 3, error: "Timeout must be an integer from 1 to 43200 minutes." }) });
    // Editing clears the error.
    if ("form" in badTimeout) expect(editGoalField(badTimeout.form, "60").error).toBeUndefined();
  });
});
