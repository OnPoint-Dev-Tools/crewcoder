# CrewCoder SDK

Supported TypeScript SDK for embedding CrewCoder in trusted Node.js applications. Version `0.6.0` requires Node.js 22 or newer and remains private until CrewCoder's public release.

Browser, renderer, webview, and thin frontend applications should use `@onpoint-dev-tools/crewcoder-client`. The SDK re-exports its remote client as `CrewCoderFleetClient` for backward compatibility, but new remote-only applications should import `CrewCoderClient` from the browser-safe package directly.

```ts
import { createCrewCoderSession } from "@onpoint-dev-tools/crewcoder-sdk";

const session = createCrewCoderSession({
  cwd: process.cwd(),
  provider: "codex",
  approval: "review"
});

session.subscribe((event) => {
  if (event.type === "assistant_delta") process.stdout.write(event.text);
  if (event.type === "approval_required") {
    session.approve(event.approvalId, false, "Host policy denied the mutation.");
  }
});

const result = await session.prompt("Inspect this project and explain the failing tests.", {
  images: ["/workspace/failure.png"]
});
console.log(session.sessionId, session.messages.length, result.usage);
session.dispose();
```

Supported today: typed events, durable or in-memory sessions, multi-prompt continuation, image inputs, optional verification and token budgets, custom tools and model clients, approvals, follow-ups, extension UI responses, cancellation, host text-file I/O, explicit external-directory grants, configuration and integration-profile administration, sequential worker crews, declarative teams, session handoffs, and an authenticated fleet client for remote runners.

```ts
import { CrewCoderAdmin } from "@onpoint-dev-tools/crewcoder-sdk";

const admin = new CrewCoderAdmin({ cwd: process.cwd() });
console.log(admin.config.get());
console.log(admin.profiles.get()); // effective profile plus project/user precedence
admin.config.set("defaultProvider", "codex");
admin.profiles.use("standalone", "project");

admin.memory.setEnabled(true);
const memory = admin.memory.remember("Use deterministic test fixtures", { topic: "testing" });
admin.memory.forget(memory.id);

const sessions = await admin.sessions.list(); // defaults to this admin's cwd
const record = await admin.sessions.get(sessions[0].id);
const branch = await admin.sessions.branch(record.id);
await admin.sessions.delete(branch.id);

const checkpoint = (await admin.sessions.checkpoints(record.id))[0];
const preview = await admin.sessions.previewRewind(record.id, checkpoint.id);
console.log(preview.restoreFiles, preview.deleteFiles);
await admin.sessions.rewind(record.id, checkpoint.id, { confirm: true });
```

`config` operates on the user-level CrewCoder configuration. `profiles` resolves the project override at `<cwd>/crewcoder.json`, can select either project or user scope, detects CrewCode project markers, and persists dismissal of the one-time profile prompt. The `memory` surface manages opt-in repository-local `.crewcoder/memory` facts. The `sessions` surface lists compact summaries, loads complete records, creates durable branches, deletes durable session directories, and previews or restores filesystem checkpoints. Pass `{}` to `sessions.list()` to list every workspace instead of the admin's `cwd`. Deletion returns `false` when the session does not exist and rejects unsafe IDs. Rewind is scoped to the admin's `cwd`, requires `{ confirm: true }`, and permanently overwrites or deletes files shown by `previewRewind()`.

This trusted Node API reads and writes local state; it is intentionally not part of the browser-safe client.

```ts
import { CrewCoderFleetClient } from "@onpoint-dev-tools/crewcoder-sdk";

const client = new CrewCoderFleetClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.CREWCODER_FLEET_TOKEN ?? ""
});
const run = await client.createRun({ prompt: "Explain the failing tests" });

await client.streamEvents(run.runId, (event) => {
  console.log(event.fleetEventId, event.type);
});

const summary = await client.waitForRun(run.runId);
console.log(summary.status, summary.lastEventId);
```

Worker orchestration uses a separate lifecycle object:

```ts
import { createCrewCoderOrchestrator } from "@onpoint-dev-tools/crewcoder-sdk";

const orchestrator = createCrewCoderOrchestrator({ cwd: process.cwd(), approval: "review" });
orchestrator.subscribe((event) => {
  if (event.type === "approval_required") orchestrator.approve(event.approvalId, true);
});

const crew = await orchestrator.runCrew({ prompt: "Ship checkout", workers: ["reviewer", "builder"] });
const team = await orchestrator.runTeam({ teamId: "feature", prompt: "Ship checkout" });
const handoff = await orchestrator.handoff({ sessionId: crew.workers[0].sessionId, worker: "reviewer" });
```

Crew and team workers run sequentially, not concurrently, with one durable session per worker. Teams are read from `<cwd>/crewcoder.json`; their role prompts, handoff rules, and shared memory are injected into each worker prompt. Handoff creates a new child session that inherits the source transcript and runtime history. The orchestrator rejects overlapping calls and supports event subscriptions, approvals, and abort.

`CrewCoderSession` exposes `isRunning`, `sessionId`, `messages`, and the latest `result`. During an active prompt, hosts can call `followUp()`, `approve()`, `respondToUi()`, or `abort()`; controls return `false` when no compatible operation is active. Set `verify: true` in session options to run configured verification after the agent turn, or `persistSession: false` for object-local continuation without session JSONL writes.

Live SSE streams reconnect automatically with bounded exponential backoff and continue after the last delivered event cursor. Completed run history and events survive fleet-server restarts; a run active during process death is recovered as failed with `interrupted: true`. Use detached goals when execution itself must continue durably across restarts.

SDK-owned failures use `CrewCoderError`, `CrewCoderFleetRequestError`, and `CrewCoderFleetProtocolError`. Provider, custom tool/model, host callback, and event-listener errors may propagate unchanged.

For process isolation, use the ACP-backed subprocess client:

```ts
import { createCrewCoderProcess } from "@onpoint-dev-tools/crewcoder-sdk";

const processClient = await createCrewCoderProcess({ command: "crewcoder", cwd: "/workspace" });
processClient.subscribe((notification) => console.log(notification.update));
await processClient.prompt("Inspect the failing tests");
processClient.dispose();
```

It starts `crewcoder acp` using argument-array spawning with `shell: false`, negotiates ACP, supports new or loaded sessions, streams typed ACP notifications, cancellation, and host permission decisions. Permission requests default to deny/cancel unless a callback is supplied. It intentionally does not expose `followUp()` because ACP 1.x has no compatible live follow-up method.

Detached goals and extension administration are available through `CrewCoderAdmin`: `admin.goals.start/list/get/current/pause/resume/approve/cancel` and `admin.extensions.list/inspect/install/update/remove/setEnabled/setTrust/search`. Extension installation never grants trust; newly acquired packages remain prompt-only. See the [SDK guide](../crewcoder-agent/docs/SDK.md) for the complete API and error contract, the [fleet runner guide](../crewcoder-agent/docs/FLEET_MODE.md) for deployment and recovery behavior, and the [release policy](../crewcoder-agent/docs/contributor/SDK_RELEASE.md) for compatibility guarantees.

## Development

```sh
npm run typecheck -w @onpoint-dev-tools/crewcoder-sdk
npm test -w @onpoint-dev-tools/crewcoder-sdk
npm run build -w @onpoint-dev-tools/crewcoder-sdk
npm run release:check:sdk
```
