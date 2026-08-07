# CrewCoder Client

Browser-safe TypeScript client for controlling authenticated CrewCoder runners from web apps, Electron renderers, Tauri webviews, and other thin frontends.

```ts
import { CrewCoderClient } from "@onpoint-dev-tools/crewcoder-client";

const client = new CrewCoderClient({
  baseUrl: "https://runner.example.com",
  token
});

const run = await client.createRun({ prompt: "Fix the failing tests", cwd: "/workspace/project" });
await client.streamEvents(run.runId, (event) => {
  if (event.type === "assistant_delta" && typeof event.text === "string") output.append(event.text);
});
```

The package uses web-platform APIs only: `fetch`, Web Streams, `Headers`, `URL`, `AbortController`, and WebSocket connection metadata. It does not import Node.js modules, access local files, execute tools, or store provider credentials.

Supported today:

- health checks and authenticated run creation;
- durable run listing/status and completion polling;
- SSE event streaming with cursor replay and bounded reconnect;
- approvals, follow-ups, extension UI responses, compaction, and abort controls;
- token-safe WebSocket URL/subprotocol construction;
- typed request, status, control, protocol, and error contracts.

`CrewCoderFleetClient` remains as a compatibility alias for applications migrating from `@onpoint-dev-tools/crewcoder-sdk`.
