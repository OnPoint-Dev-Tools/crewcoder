import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listWorkflows, findWorkflow, describeWorkflow, runWorkflow } from "../extensions/extension-workflows.js";
import { validateExtensionManifest } from "../extensions/extension-loader.js";
import { setExtensionTrustTier } from "../extensions/extension-registry.js";
import type { CrewCoderExtensionManifest, CrewCoderExtensionWorkflowContribution } from "../extensions/types.js";

let home = "";
let scratch = "";
const originalHome = process.env.CREWCODER_HOME;

async function installWorkflowExtension(id: string, workflows: CrewCoderExtensionWorkflowContribution[]): Promise<void> {
  const dir = path.join(home, "extensions", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "crewcoder.extension.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", crewcoder: { apiVersion: "0.1" }, contributes: { workflows } }, null, 2),
    "utf8"
  );
}

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-workflow-test-"));
  home = path.join(scratch, ".crewcoder");
  process.env.CREWCODER_HOME = home;
  await fs.mkdir(path.join(home, "extensions"), { recursive: true });
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalHome;
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("workflow manifest validation", () => {
  // These cases feed deliberately malformed manifests through the validator, which is the
  // boundary that must reject them, so the input is cast rather than typed.
  const manifestWith = (workflows: unknown[]): CrewCoderExtensionManifest =>
    ({ id: "wf", name: "WF", version: "1.0.0", crewcoder: { apiVersion: "0.1" }, contributes: { workflows } }) as unknown as CrewCoderExtensionManifest;

  it("requires a non-empty steps array", () => {
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A" }]))).toThrow(/non-empty steps array/);
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A", steps: [] }]))).toThrow(/non-empty steps array/);
  });

  it("requires a valid step kind", () => {
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A", steps: [{ kind: "shell" }] }]))).toThrow(/kind must be/);
  });

  it("requires tool steps to name a tool and prompt steps to carry a prompt", () => {
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A", steps: [{ kind: "tool" }] }]))).toThrow(/must declare a tool name/);
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A", steps: [{ kind: "prompt" }] }]))).toThrow(/must declare a prompt/);
  });

  it("rejects malformed guards, failure policies, and duplicate step ids", () => {
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A", steps: [{ kind: "prompt", prompt: "x", when: "if tests pass" }] }]))).toThrow(/when must look like/);
    expect(() => validateExtensionManifest(manifestWith([{ id: "a", title: "A", steps: [{ kind: "prompt", prompt: "x", onFailure: "retry" }] }]))).toThrow(/onFailure must be/);
    expect(() => validateExtensionManifest(manifestWith([{
      id: "a", title: "A", steps: [{ id: "dup", kind: "prompt", prompt: "x" }, { id: "dup", kind: "prompt", prompt: "y" }]
    }]))).toThrow(/reuses step id/);
  });

  it("accepts a well-formed workflow and warns only about tool steps", () => {
    const warnings: string[] = [];
    expect(() => validateExtensionManifest(manifestWith([{
      id: "check", title: "Check",
      steps: [{ id: "test", kind: "tool", tool: "bash", args: { command: "npm test" } }, { kind: "prompt", prompt: "Summarize {{steps.test.output}}", when: "steps.test.failed" }]
    }]), warnings)).not.toThrow();
    expect(warnings.some((warning) => warning.includes("workflow tool steps"))).toBe(true);
  });
});

describe("listWorkflows and findWorkflow", () => {
  it("namespaces workflows and marks prompt-only ones runnable at prompt-only tier", async () => {
    await installWorkflowExtension("pack-a", [{ id: "review", title: "Review", steps: [{ kind: "prompt", prompt: "Review the diff." }] }]);

    const entries = await listWorkflows();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ref: "ext.pack-a.review", tier: "prompt-only", hasToolSteps: false, runnable: true });
  });

  it("marks tool-step workflows unrunnable until the extension is trusted", async () => {
    await installWorkflowExtension("pack-b", [{ id: "build", title: "Build", steps: [{ kind: "tool", tool: "bash", args: { command: "echo hi" } }] }]);

    expect((await listWorkflows())[0]).toMatchObject({ hasToolSteps: true, runnable: false });

    setExtensionTrustTier("pack-b", "sandboxed");
    expect((await listWorkflows())[0]).toMatchObject({ tier: "sandboxed", runnable: true });
  });

  it("resolves fully qualified, extension-scoped, and unambiguous bare refs", async () => {
    await installWorkflowExtension("pack-c", [{ id: "ship", title: "Ship", steps: [{ kind: "prompt", prompt: "Ship it." }] }]);

    expect((await findWorkflow("ext.pack-c.ship")).ref).toBe("ext.pack-c.ship");
    expect((await findWorkflow("pack-c.ship")).ref).toBe("ext.pack-c.ship");
    expect((await findWorkflow("ship")).ref).toBe("ext.pack-c.ship");
  });

  it("reports ambiguity instead of guessing", async () => {
    await installWorkflowExtension("pack-d", [{ id: "ship", title: "Ship", steps: [{ kind: "prompt", prompt: "a" }] }]);
    await installWorkflowExtension("pack-e", [{ id: "ship", title: "Ship", steps: [{ kind: "prompt", prompt: "b" }] }]);

    await expect(findWorkflow("ship")).rejects.toThrow(/ambiguous/);
  });

  it("fails clearly for an unknown ref", async () => {
    await expect(findWorkflow("nope")).rejects.toThrow(/Workflow not found/);
  });
});

describe("describeWorkflow", () => {
  it("renders a reviewable plan", async () => {
    await installWorkflowExtension("pack-f", [{
      id: "check", title: "Check",
      steps: [
        { id: "test", kind: "tool", tool: "bash", args: { command: "npm test" } },
        { id: "explain", kind: "prompt", prompt: "Explain the failure.", allowTools: ["read"], when: "steps.test.failed", onFailure: "continue" }
      ]
    }]);

    const lines = describeWorkflow(await findWorkflow("check"));

    expect(lines[0]).toBe('1. [tool:test] bash {"command":"npm test"}');
    expect(lines[1]).toBe('2. [prompt:explain] "Explain the failure." (tools: read) [if steps.test.failed] [continue on failure]');
  });
});

describe("runWorkflow", () => {
  it("refuses to run tool steps from an untrusted extension", async () => {
    await installWorkflowExtension("pack-g", [{ id: "danger", title: "Danger", steps: [{ kind: "tool", tool: "bash", args: { command: "echo pwned" } }] }]);

    await expect(runWorkflow("danger", { cwd: scratch })).rejects.toThrow(/contains tool steps/);
  });

  it("runs tool steps in order and pipes output into later steps", async () => {
    await installWorkflowExtension("pack-h", [{
      id: "chain", title: "Chain",
      steps: [
        { id: "one", kind: "tool", tool: "bash", args: { command: "echo first" } },
        { id: "two", kind: "tool", tool: "bash", args: { command: "echo saw:{{steps.one.output}}" } }
      ]
    }]);
    setExtensionTrustTier("pack-h", "trusted");

    const result = await runWorkflow("chain", { cwd: scratch });

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.status)).toEqual(["ok", "ok"]);
    expect(result.steps[1].output).toContain("saw:");
    expect(result.steps[1].output).toContain("first");
  });

  it("stops at the first failure by default", async () => {
    await installWorkflowExtension("pack-i", [{
      id: "halt", title: "Halt",
      steps: [
        { id: "boom", kind: "tool", tool: "bash", args: { command: "exit 3" } },
        { id: "never", kind: "tool", tool: "bash", args: { command: "echo unreachable" } }
      ]
    }]);
    setExtensionTrustTier("pack-i", "trusted");

    const result = await runWorkflow("halt", { cwd: scratch });

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe("failed");
  });

  it("continues past a failure when onFailure is continue, and honours guards", async () => {
    await installWorkflowExtension("pack-j", [{
      id: "guarded", title: "Guarded",
      steps: [
        { id: "boom", kind: "tool", tool: "bash", args: { command: "exit 1" }, onFailure: "continue" },
        { id: "onfail", kind: "tool", tool: "bash", args: { command: "echo recovered" }, when: "steps.boom.failed" },
        { id: "onok", kind: "tool", tool: "bash", args: { command: "echo not-run" }, when: "steps.boom.ok" }
      ]
    }]);
    setExtensionTrustTier("pack-j", "trusted");

    const result = await runWorkflow("guarded", { cwd: scratch });

    expect(result.steps.map((step) => step.status)).toEqual(["failed", "ok", "skipped"]);
    expect(result.steps[1].output).toContain("recovered");
    expect(result.ok).toBe(false);
  });

  it("fails a step that names an unknown tool", async () => {
    await installWorkflowExtension("pack-k", [{ id: "bogus", title: "Bogus", steps: [{ kind: "tool", tool: "nope" }] }]);
    setExtensionTrustTier("pack-k", "trusted");

    const result = await runWorkflow("bogus", { cwd: scratch });

    expect(result.ok).toBe(false);
    expect(result.steps[0].error).toMatch(/Unknown tool: nope/);
  });

  it("fails a prompt step that allowlists an unknown tool instead of silently widening access", async () => {
    await installWorkflowExtension("pack-l", [{
      id: "typo", title: "Typo",
      steps: [{ kind: "prompt", prompt: "Do a thing.", allowTools: ["read", "nonexistent"] }]
    }]);

    const result = await runWorkflow("typo", { cwd: scratch });

    expect(result.ok).toBe(false);
    expect(result.steps[0].error).toMatch(/Unknown tools in allowTools: nonexistent/);
  });
});
