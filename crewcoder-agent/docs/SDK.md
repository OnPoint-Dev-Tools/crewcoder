# CrewCoder SDK

`@onpoint-dev-tools/crewcoder-sdk` is CrewCoder's supported TypeScript API for embedding the agent loop in a trusted Node.js process. `@onpoint-dev-tools/crewcoder-client` is the browser-safe companion for controlling authenticated runners from renderers, webviews, and web applications. The SDK keeps re-exporting the remote client for backward compatibility. Package version `0.6.0` requires Node.js 22 or newer. Its API is intentionally narrower than `crewcoder-agent/src` so internals can continue to evolve.

Version constants are available at runtime:

```ts
import {
  CREWCODER_FLEET_PROTOCOL_VERSION,
  CREWCODER_MINIMUM_NODE_VERSION,
  CREWCODER_SDK_API_VERSION,
  CREWCODER_SDK_VERSION
} from "@onpoint-dev-tools/crewcoder-sdk";
```

## Current scope

The first supported SDK version provides:

- in-process agent sessions
- typed event subscriptions, including assistant and thinking deltas
- durable sessions or conversation state kept in memory
- multi-prompt continuation
- custom tools and custom model clients
- built-in provider/model selection
- approval decisions, queued follow-ups, extension UI responses, and abort
- host-provided text file reads and writes
- trusted Node administration for configuration, integration profiles, repository memory, durable sessions, and checkpoint rewind
- sequential worker crews, declarative worker teams, and transcript-preserving handoffs
- an authenticated `CrewCoderFleetClient` for remote HTTP/SSE/WebSocket runners

For process isolation, use `createCrewCoderProcess()`, which spawns and negotiates `crewcoder acp`. It supports typed ACP notifications, new and loaded sessions, cancellation, and deny-by-default permission callbacks. ACP 1.x does not provide CrewCoder's live follow-up or extension UI controls, so those remain in-process/fleet features. For remote runners in Node, use the compatibility `CrewCoderFleetClient` export. Browser and renderer applications should use `CrewCoderClient` from `@onpoint-dev-tools/crewcoder-client` through an SSH tunnel, encrypted private network, or HTTPS reverse proxy.

## Quick start

```ts
import { createCrewCoderSession } from "@onpoint-dev-tools/crewcoder-sdk";

const session = createCrewCoderSession({
  cwd: process.cwd(),
  provider: "codex",
  model: "gpt-5.6",
  approval: "review"
});

session.subscribe((event) => {
  if (event.type === "assistant_delta") process.stdout.write(event.text);
  if (event.type === "approval_required") {
    session.approve(event.approvalId, false, "This host does not allow mutations.");
  }
});

const result = await session.prompt("Explain the failing tests.");
console.log(result.sessionId, result.usage);
session.dispose();
```

`prompt()` resolves after the agent run, including tool calls and queued follow-ups, has stopped. Calling `prompt()` while the session is running throws; use `followUp()` to queue another instruction.

## Configuration and integration profiles

`CrewCoderAdmin` provides synchronous local administration in trusted Node hosts:

```ts
import { CrewCoderAdmin } from "@onpoint-dev-tools/crewcoder-sdk";

const admin = new CrewCoderAdmin({ cwd: "/workspace/project" });
const config = admin.config.get();
const profile = admin.profiles.get();

admin.config.set("autoCompact", "true");
admin.profiles.use("crewcode", "project");
console.log(admin.profiles.detect());
```

`admin.config` reads and updates the user configuration under `CREWCODER_HOME`. Its `set()` method uses the CLI's validated string-value contract. `admin.profiles` applies the normal `./crewcoder.json` over user-config precedence, supports `project` and `user` selection scopes, detects CrewCode markers, and can persist profile-prompt dismissal. Project writes preserve unrelated manifest fields. These APIs access the local filesystem and are not exported by the browser-safe client.

Repository memory is opt-in and scoped to the admin's `cwd`:

```ts
admin.memory.setEnabled(true);
const entry = admin.memory.remember("Use tabs", { topic: "formatting" });
console.log(admin.memory.status(), admin.memory.list(), admin.memory.context());
admin.memory.forget(entry.id);
```

Disabling memory preserves existing facts but prevents new writes and context injection. Memory files remain repo-shareable under `.crewcoder/memory`.

Durable session administration is available on the same object:

```ts
const projectSessions = await admin.sessions.list();
const allSessions = await admin.sessions.list({});
const record = await admin.sessions.get(projectSessions[0].id);
const branch = await admin.sessions.branch(record.id);
await admin.sessions.delete(branch.id);

const checkpoint = (await admin.sessions.checkpoints(record.id))[0];
const preview = await admin.sessions.previewRewind(record.id, checkpoint.id);
console.log(preview.restoreFiles, preview.deleteFiles);
await admin.sessions.rewind(record.id, checkpoint.id, { confirm: true });
```

`list()` defaults to the admin's resolved `cwd` and returns compact metadata rather than complete event/message history. Passing `{}` explicitly lists all workspaces. `get()` returns the full durable record. `branch()` copies the record under a fresh ID and records `parentSessionId`. `delete()` removes the session and its checkpoints, returns `false` when absent, and rejects traversal or symlink targets. Deletion is permanent and does not affect workspace files. Checkpoint rewind is different: it restores the snapshot into the admin's `cwd` and deletes workspace files absent from that snapshot. Call `previewRewind()` first; `rewind()` requires `{ confirm: true }`, validates session/checkpoint IDs, and appends a restore event and audit record to the durable session.

## Detached goals and extensions

`admin.goals` starts and controls detached durable supervisors. Starting resolves omitted provider/model/mode and goal limits from CrewCoder configuration. Only one active goal is allowed per workspace. Approval decisions are persisted for the detached worker to consume; `pause`, `resume`, and `cancel` signal the worker process through the existing goal runtime.

`admin.extensions` lists, inspects, installs, updates, removes, enables, and assigns trust tiers to CrewCoder extensions. It also searches and configures registries. Installation uses staged validation and always leaves new extensions prompt-only: acquisition never grants executable trust. Hosts must make a separate `setTrust(id, "sandboxed" | "trusted")` decision after inspecting capabilities.

## ACP subprocess client

```ts
const processClient = await createCrewCoderProcess({
  command: "crewcoder",
  cwd: "/workspace",
  permission(request) {
    return hostPolicy(request);
  }
});
processClient.subscribe((notification) => renderAcpUpdate(notification));
await processClient.prompt("Fix the failing tests");
processClient.dispose();
```

The command defaults to `crewcoder` with arguments `["acp"]` and is spawned with `shell: false`. Permission requests are cancelled by default. Pass `sessionId` to `prompt()` to load an existing durable session. The object rejects overlapping prompts, supports `abort()`, and must be disposed to terminate the child. ACP notifications are protocol-level events rather than CrewCoder's in-process `AgentEvent` union.

## Worker orchestration

```ts
import { createCrewCoderOrchestrator } from "@onpoint-dev-tools/crewcoder-sdk";

const orchestrator = createCrewCoderOrchestrator({
  cwd: "/workspace",
  provider: "codex",
  approval: "review"
});

orchestrator.subscribe((event) => {
  if (event.type === "approval_required") orchestrator.approve(event.approvalId, true);
});

const crew = await orchestrator.runCrew({
  prompt: "Review and implement checkout",
  workers: ["reviewer", "builder"]
});
const team = await orchestrator.runTeam({ teamId: "feature", prompt: "Ship checkout" });
const handoff = await orchestrator.handoff({
  sessionId: crew.workers[0].sessionId,
  worker: "reviewer",
  prompt: "Perform final review"
});
```

Crew workers execute sequentially in the supplied order and each receives a separate durable session. A terminal provider/stall result is reported through lifecycle events and later workers still run; a thrown runtime error stops the crew. `runTeam()` reads a normalized team from `crewcoder.json` and applies role prompts, handoff rules, and shared memory. `handoff()` creates a child session and inherits the source transcript, mutation log, usage, compactions, checkpoints, and extension entries. It is not a detached or parallel operation.

The orchestrator rejects overlapping operations. `approve()` and `abort()` are accepted only while it is running. Custom `modelClient` and `heuristic` options are supported for controlled hosts and tests.

## Session options

```ts
const session = createCrewCoderSession({
  cwd: "/workspace",
  externalDirectories: ["/shared/library"], // explicit session-scoped filesystem grants
  mode: "general",                  // general | plugin | extension
  provider: "codex",
  model: "gpt-5.6",
  effort: "high",
  approval: "review",              // defaults to never
  tokenBudget: 100_000,
  maxIterations: 0,                 // omitted/0 means unlimited
  persistSession: true,             // default
  sessionId: "session_...",        // resume on the first prompt
  systemPrompt: "stored-prompt-name",
  worker: "Crew"
});
```

`externalDirectories` uses the same validated, session-scoped tool authorization as the CLI and
ACP adapter. Relative tool paths still resolve from `cwd`; use absolute paths for external files.
See `EXTERNAL_DIRECTORIES.md`.

With `persistSession: true`, runs use CrewCoder's normal durable session store. With `persistSession: false`, conversation continuation remains in the `CrewCoderSession` object and no session JSONL file or `session_saved` event is produced. Memory-only mode is not a side-effect-free sandbox: normal tools, extension loading, audit logging, configuration reads, and provider cost accounting still behave as they do in the agent runtime.

## Events and live controls

`subscribe(listener)` returns an unsubscribe function. Listeners receive the canonical `AgentEvent` union used by CrewCoder.

```ts
const unsubscribe = session.subscribe(async (event) => {
  switch (event.type) {
    case "thinking_delta":
      process.stderr.write(event.text);
      break;
    case "assistant_delta":
      process.stdout.write(event.text);
      break;
    case "approval_required":
      session.approve(event.approvalId, true, "Approved by the host UI");
      break;
    case "extension_ui_request":
      session.respondToUi(event.requestId, null);
      break;
  }
});

session.followUp("Also update the documentation."); // only accepted while running
session.abort();                                    // abort the active operation
unsubscribe();
```

Hosts must resolve approval and extension UI requests while the prompt is active. Ignoring an approval request leaves the agent waiting until it is aborted. Use an explicit approval policy appropriate for the embedding application; `full-access` bypasses interactive protection and should not be a casual default.

## Custom tools

```ts
import { createCrewCoderSession, type CrewCoderTool } from "@onpoint-dev-tools/crewcoder-sdk";

const lookup: CrewCoderTool<{ key: string }> = {
  name: "lookup",
  description: "Look up a value in the host application.",
  parameters: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false
  },
  parse(args) {
    if (typeof args.key !== "string") throw new Error("key is required");
    return { key: args.key };
  },
  async execute({ key }) {
    return { content: [{ type: "text", text: `Value for ${key}` }] };
  }
};

const session = createCrewCoderSession({ customTools: [lookup] });
```

Custom tools are added to CrewCoder's built-ins and trusted extension tools. Set `isMutation: true` when a tool changes state so approval policy and checkpoints treat it honestly. A custom tool can create another `CrewCoderSession` to implement host-controlled sub-agents.

## Custom model clients and testing

Pass a `ModelClient` to replace provider resolution programmatically, or set `heuristic: true` for CrewCoder's deterministic built-in test model.

```ts
const session = createCrewCoderSession({
  persistSession: false,
  modelClient: {
    async complete() {
      return {
        role: "assistant",
        content: [{ type: "text", text: "deterministic response" }],
        stopReason: "end",
        timestamp: Date.now()
      };
    }
  }
});
```

Call `dispose()` when the host no longer needs a session. It aborts active work, clears listeners and pending controls, and permanently prevents further prompts or subscriptions on that object.

## Error contract

SDK validation and lifecycle failures use `CrewCoderError` with a stable `code`:

```ts
import { CrewCoderError } from "@onpoint-dev-tools/crewcoder-sdk";

try {
  await session.prompt("");
} catch (error) {
  if (error instanceof CrewCoderError && error.code === "INVALID_ARGUMENT") {
    console.error(error.message);
  }
}
```

Fleet HTTP failures use `CrewCoderFleetRequestError`, exposing `status`, `responseBody`, and `retryable`. Malformed server JSON/events use `CrewCoderFleetProtocolError`. Provider, custom model, custom tool, host callback, and event-listener errors are host-owned and may propagate without being rewritten.

## Remote fleet client

```ts
import { CrewCoderFleetClient } from "@onpoint-dev-tools/crewcoder-sdk";

const client = new CrewCoderFleetClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.CREWCODER_FLEET_TOKEN ?? ""
});

const run = await client.createRun({
  prompt: "Fix the failing tests",
  approval: "review",
  cwd: "/workspace/project"
});

const streamAbort = new AbortController();
try {
  await client.streamEvents(run.runId, async (event) => {
    if (event.type === "assistant_delta") process.stdout.write(event.text);
    if (event.type === "approval_required") {
      await client.control(run.runId, {
        type: "control",
        action: "approval",
        approvalId: event.approvalId,
        approved: true,
        reason: "Approved by the host application"
      });
    }
    if (event.type === "fleet_run_status") streamAbort.abort();
  }, { signal: streamAbort.signal });
} catch (error) {
  if (!streamAbort.signal.aborted) throw error;
}

const summary = await client.getRun(run.runId);
console.log(summary.status, summary.sessionId, summary.lastEventId);
```

Send other live controls with the same typed method:

```ts
await client.control(run.runId, {
  type: "control",
  action: "follow_up",
  message: "Also update the documentation."
});
await client.control(run.runId, { type: "control", action: "compact" });
await client.control(run.runId, { type: "control", action: "abort" });
```

List durable run history, wait for completion, or replay after a cursor:

```ts
const runs = await client.listRuns();
const completed = await client.waitForRun(run.runId, { timeoutMs: 60_000 });

await client.streamEvents(
  run.runId,
  (event) => console.log(event.fleetEventId, event.type),
  { replay: true, afterEventId: Math.max(0, completed.lastEventId - 10) }
);
```

Live streams reconnect automatically up to three times with bounded exponential backoff. Override or disable it per client or stream:

```ts
const clientWithPolicy = new CrewCoderFleetClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.CREWCODER_FLEET_TOKEN ?? "",
  reconnect: { maxAttempts: 5, initialDelayMs: 250, maxDelayMs: 5_000 }
});

await clientWithPolicy.streamEvents(run.runId, (event) => console.log(event.type), {
  afterEventId: lastSavedEventId,
  onReconnect: (attempt, cursor) => console.log("reconnecting", attempt, cursor)
});
```

The server persists run metadata and append-only events under `<CREWCODER_HOME>/fleet-runs`. Completed history survives restart. A run active during server process death is recovered as `failed` and emits a terminal fleet event with `interrupted: true`; use detached goals when execution itself must survive restarts.

Connect a browser-style WebSocket without putting the token in the URL:

```ts
const connection = client.webSocketConnection(run.runId);
const socket = new WebSocket(connection.url, connection.protocols);

socket.addEventListener("message", (message) => {
  console.log(JSON.parse(String(message.data)));
});
```

The client sends bearer authentication for run, status, control, and SSE requests. `webSocketConnection(runId)` returns a URL plus WebSocket subprotocols; the credential is carried in a subprotocol rather than the URL.

See [`FLEET_MODE.md`](./FLEET_MODE.md) for the complete build/deploy/tunnel example, token-safe curl setup, token retrieval and rotation, every raw control request, Python usage, recovery, troubleshooting, and HTTPS requirements.

## Architecture boundary

`crewcoder-agent/src/sdk-runtime.ts` is the narrow adapter between the SDK and CrewCoder's internal loop. The SDK must not import arbitrary `crewcoder-agent/src/*` files. Add supported behavior through this adapter and cover it in `crewcoder-sdk/src/tests` so provider, session, approval, and event semantics stay aligned with the CLI.
