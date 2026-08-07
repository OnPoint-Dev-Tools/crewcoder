# Parallel tool calls

CrewCoder supports models that emit more than one tool call in a single assistant response. Support has two independent gates:

1. The provider/model must advertise that it can emit parallel tool calls.
2. Each tool must explicitly declare that concurrent execution is safe.

## Provider and model capability

Built-in providers advertise `capabilities.parallelToolCalls`. An extension provider should set the capability only when its API and default model family support multiple tool calls in one response:

```json
{
  "capabilities": {
    "streaming": true,
    "toolCalling": true,
    "parallelToolCalls": true
  }
}
```

A mixed model catalog can override the provider default per model:

```json
{
  "capabilities": { "parallelToolCalls": true },
  "modelCatalog": [
    { "id": "fast-parallel", "parallelToolCalls": true },
    { "id": "legacy-sequential", "parallelToolCalls": false }
  ]
}
```

The selected model override takes precedence. Missing capability metadata is treated as `false`. OpenAI Responses and compatible Chat Completions requests send `parallel_tool_calls: true` only when this resolution enables it; unsupported extension gateways do not receive the field. Anthropic-shaped transports do not use that OpenAI request field, but multiple returned `tool_use` blocks still enter the same scheduler.

## Tool execution safety

A tool opts in with `executionMode: "parallel"`:

```ts
const inspectTool: ToolDefinition = {
  name: "inspect",
  description: "Inspect one independent target.",
  executionMode: "parallel",
  parse: (args) => args,
  async execute(args, context, signal) {
    // Concurrent-safe implementation.
    return { content: [{ type: "text", text: String(args.target) }] };
  }
};
```

`executionMode` defaults to `"sequential"`. Mutation tools, approval-sensitive tools, extension command tools, and tools with shared mutable state should stay sequential.

The scheduler preserves model order:

- adjacent parallel tools form one concurrent batch;
- a sequential tool is a barrier and runs only after the prior batch finishes;
- later parallel calls wait until that sequential tool finishes;
- tool-result messages are appended in the model's original call order, even if calls complete out of order;
- a terminating result prevents later batches from starting. Calls already started in the same parallel batch are allowed to finish.

Built-in `read`, `listFiles`, `grep`, `listTemplates`, and `docs` calls are parallel-safe. Mutating and process-oriented built-ins remain sequential.

## Events and hooks

Each call keeps its own `tool_execution_start`, `tool_delta`, and `tool_execution_end` lifecycle. Events from concurrently running calls may interleave and must be correlated by `toolCallId`. Before/after/error hooks for parallel-safe calls can also overlap, so a hook that depends on global mutable state should target sequential tools or provide its own synchronization.
