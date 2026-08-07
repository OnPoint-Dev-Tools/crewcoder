# Workflow Contribution Point

A workflow is a deterministic, linear sequence of tool calls and model turns declared in an
extension manifest. Implementation: `src/extensions/extension-workflows.ts`. Validation:
`validateWorkflowContributions` in `src/extensions/extension-loader.ts`. Tests:
`src/tests/extension-workflows.test.ts`.

The point is **reviewability**. `crewcoder workflow show <ref>` renders the exact plan before
anything runs, so a reviewer reading a manifest diff in a PR knows what the agent will do.

## Manifest shape

```jsonc
{
  "contributes": {
    "workflows": [{
      "id": "release-check",
      "title": "Release check",
      "description": "Run the suite, then explain any failure.",
      "steps": [
        { "id": "test", "kind": "tool", "title": "Run tests",
          "tool": "bash", "args": { "command": "npm test" }, "onFailure": "continue" },
        { "id": "explain", "kind": "prompt", "when": "steps.test.failed",
          "prompt": "These tests failed:\n{{steps.test.output}}\nFind the cause.",
          "allowTools": ["read", "grep", "lsp_diagnostics"] }
      ]
    }]
  }
}
```

### Step fields

| Field | Applies to | Meaning |
|---|---|---|
| `kind` | all | `tool` (fixed args, no model discretion) or `prompt` (one model turn) |
| `id` | all | Referenced by `when` and `{{steps.<id>.output}}`. Defaults to the 1-based index |
| `title` | all | Label shown in `workflow show` |
| `tool` / `args` | `tool` | Built-in tool name and its arguments |
| `prompt` | `prompt` | Prompt text |
| `allowTools` | `prompt` | Restrict the model to these built-in tools for this step |
| `when` | all | `steps.<id>.ok` or `steps.<id>.failed`. Omitted means always run |
| `onFailure` | all | `stop` (default) or `continue` |

### Templating

`{{steps.<id>.output}}` interpolates a previous step's text output. It works in `prompt` text and
in any string inside `args`, including nested objects and arrays. Unknown ids resolve to empty.

### Guards

`when` accepts exactly two forms, `steps.<id>.ok` and `steps.<id>.failed`. A step that was itself
skipped satisfies neither, so guard chains do not silently cascade. Anything malformed is a
manifest validation error, not a silent no-op.

This is deliberately not a programming language: linear steps, one guard form, one failure
policy. No loops, no arithmetic, no variables. If something needs those, it should be a tool.

## Failure semantics

A `tool` step fails when the tool throws **or** when it reports a non-zero `details.exitCode`.
That second case matters: `bash` returns normally on a non-zero exit, so without it a step
wrapping `npm test` would always look successful and every guard built on it would be
meaningless.

A `prompt` step fails on `providerError` or `stallError`, matching the agent loop's own honest
early-stop contract.

The run stops at the first failure unless that step sets `onFailure: "continue"`.
`crewcoder workflow run` exits non-zero when any step failed.

## Commands

```bash
crewcoder workflow list [--json]          # workflows from enabled extensions, with trust status
crewcoder workflow show <ref> [--json]    # the reviewable plan
crewcoder workflow run <ref> [-p <provider>] [-m <model>] [--json]
```

Refs are namespaced `ext.<extensionId>.<workflowId>`. `<extensionId>.<workflowId>` and a bare
`<workflowId>` also resolve when unambiguous; ambiguity is reported with the candidates rather
than guessed.

## Trust boundary

| Workflow contains | Required tier |
|---|---|
| only `prompt` steps | any, including `prompt-only` |
| any `tool` step | `sandboxed` or `trusted` |

Prompt steps are safe at any tier because the agent's normal approval and tool gates still
apply — the model still has to decide to call a tool, and the user still approves it. A `tool`
step is different: it executes with fixed arguments and no model judgement, which is the same
risk profile as an extension-contributed tool, so it needs the same tier.

`workflow list` shows `needs trust (<tier>)` for workflows that cannot run, and `workflow run`
refuses with the exact `extension trust` command to fix it.

## Status

Active: manifest validation, `list`/`show`/`run`, tool steps, prompt steps with `allowTools`,
guards, templating, failure policy, trust gating.

Not implemented: nested workflow steps (`kind: "workflow"`), extension-contributed tools as step
targets (steps resolve against the built-in registry only), and parallel steps.
