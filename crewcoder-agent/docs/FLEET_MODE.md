# Fleet Mode / Remote Runners

Fleet mode exposes CrewCoder's authenticated JSON event protocol over HTTP, Server-Sent Events, and WebSocket so a host UI or client can attach to a headless runner. A browser is not required on the runner.

Start with one of these sections:

- [Five-minute VPS example](#five-minute-end-to-end-example)
- [Local development](#run-locally-without-deployment)
- [Token lifecycle and rotation](#fleet-token-lifecycle)
- [Raw HTTP and SSE cookbook](#raw-http-and-sse-cookbook)
- [TypeScript client](#typescript-fleet-client)
- [Python client](#python-http-example)
- [Troubleshooting](#troubleshooting)

## Recommended VPS architecture

Keep the runner bound to loopback and reach it through SSH:

```txt
local terminal/editor -> SSH -> standalone CrewCoder on VPS
                                  127.0.0.1:8787
                                  bearer authentication
```

Fleet bearer authentication is mandatory, including on loopback. SSH encrypts the connection and authenticates the machine/user; the fleet token separately authorizes access to CrewCoder's agent API.

Do not expose plain HTTP fleet mode directly to the public internet. Bearer authentication does not encrypt credentials or traffic. Public access requires HTTPS through a correctly configured reverse proxy in addition to CrewCoder authentication.

## Five-minute end-to-end example

This complete example builds CrewCoder, deploys it to a Linux x64 VPS, opens an SSH tunnel, retrieves the generated token, and starts a run.

On the development machine:

```sh
npm run build:standalone -w @crewcode/crewcoder-agent

crewcoder deploy user@vps \
  --binary crewcoder-agent/dist-bin/crewcoder-linux-x64 \
  --execute
```

Keep this tunnel running in a separate terminal:

```sh
ssh -N -L 8787:127.0.0.1:8787 user@vps
```

In the client terminal, retrieve the token and create a private temporary curl configuration. The configuration keeps the token out of curl's process arguments:

```sh
export CREWCODER_FLEET_TOKEN="$(
  ssh user@vps 'cat ~/crewcoder-runner/.crewcoder/fleet-token'
)"

FLEET_CURL_CONFIG="$(mktemp)"
chmod 600 "$FLEET_CURL_CONFIG"
printf 'header = "Authorization: Bearer %s"\n' \
  "$CREWCODER_FLEET_TOKEN" > "$FLEET_CURL_CONFIG"
trap 'rm -f "$FLEET_CURL_CONFIG"' EXIT
```

Check health, then create a run:

```sh
curl --silent --show-error http://127.0.0.1:8787/health

RUN_RESPONSE="$(
  curl --silent --show-error \
    --config "$FLEET_CURL_CONFIG" \
    --json '{"prompt":"fix the failing tests","mode":"general","approval":"review"}' \
    http://127.0.0.1:8787/runs
)"
printf '%s\n' "$RUN_RESPONSE"

# jq is used only to make the remaining examples convenient.
RUN_ID="$(printf '%s' "$RUN_RESPONSE" | jq -r '.runId')"
```

Watch live events. The server closes the stream after the terminal `fleet_run_status` event:

```sh
curl --no-buffer --silent --show-error \
  --config "$FLEET_CURL_CONFIG" \
  "http://127.0.0.1:8787/runs/$RUN_ID/events"
```

If `jq` is unavailable, copy the `runId` from `RUN_RESPONSE` manually.

## Run locally without deployment

For local development, use one CrewCoder home for both the server and token command.

Terminal 1:

```sh
export CREWCODER_HOME="$HOME/.crewcoder-local-fleet"
crewcoder serve --host 127.0.0.1 --port 8787
```

Terminal 2:

```sh
export CREWCODER_HOME="$HOME/.crewcoder-local-fleet"
export CREWCODER_FLEET_TOKEN="$(crewcoder fleet token)"
crewcoder fleet token --path
curl --silent --show-error http://127.0.0.1:8787/health
```

Use the private curl configuration from the five-minute example or construct `CrewCoderFleetClient` from the environment variable. The provider credentials and target workspace must be available to the server process.

## Build the standalone Linux x64 executable

The build machine needs Bun. The resulting Linux x64 baseline executable embeds the Bun runtime; the VPS does not need Node.js, npm, or Bun.

```sh
npm run build:standalone -w @crewcode/crewcoder-agent
ls -lh crewcoder-agent/dist-bin/crewcoder-linux-x64
```

The build disables automatic `.env` loading so a copied binary does not silently ingest secrets from an unrelated working directory.

Supported first-release target:

```txt
OS:           Linux
Architecture: x86_64 / amd64 baseline
Artifact:     crewcoder-agent/dist-bin/crewcoder-linux-x64
```

This is the headless agent CLI, not the separately packaged CrewCoder TUI. Running the standalone executable without arguments prints CLI help. Commands such as `run`, `serve`, `acp`, `session`, and detached `goal` workers run from the binary.

## Fleet token lifecycle

On first use, CrewCoder generates a 256-bit URL-safe token and stores it at:

```txt
<CREWCODER_HOME>/fleet-token
```

The file is created with mode `0600`; deployment creates its parent state directory with mode `0700`. `crewcoder serve` prints the path, never the token.

Explicit token commands:

```sh
crewcoder fleet token          # print token
crewcoder fleet token --path   # print token file path
crewcoder fleet token --rotate # replace token and print the new value
```

Token commands operate on the current `CREWCODER_HOME`. For a deployed runner, use the deployment home explicitly:

```sh
CREWCODER_HOME=~/crewcoder-runner/.crewcoder \
  ~/crewcoder-runner/crewcoder fleet token --rotate
```

After rotation, restart the fleet server. A running process keeps the token it loaded at startup, so the new file value becomes authoritative only after restart. Rotation immediately invalidates prior clients once the new server starts.

For a deployed runner, rotate remotely and run deployment again to perform the restart:

```sh
ssh user@vps \
  'CREWCODER_HOME="$HOME/crewcoder-runner/.crewcoder" \
   "$HOME/crewcoder-runner/crewcoder" fleet token --rotate'

crewcoder deploy user@vps \
  --binary crewcoder-agent/dist-bin/crewcoder-linux-x64 \
  --execute

export CREWCODER_FLEET_TOKEN="$(
  ssh user@vps 'cat ~/crewcoder-runner/.crewcoder/fleet-token'
)"

# If using the five-minute curl setup, replace its stored header too.
printf 'header = "Authorization: Bearer %s"\n' \
  "$CREWCODER_FLEET_TOKEN" > "$FLEET_CURL_CONFIG"
```

Recreate any SDK client that contains the previous token. Existing clients receive `401 Unauthorized` after the restarted server activates the replacement.

Treat the token like a password:

- do not put it in URLs, repository files, command arguments, screenshots, or logs;
- inject it into clients through secret storage or a short-lived environment variable;
- never commit the token file;
- use separate CrewCoder homes/tokens for separate trust boundaries.

## Deploy the executable over SSH

First inspect the dry-run plan:

```sh
crewcoder deploy user@vps \
  --binary crewcoder-agent/dist-bin/crewcoder-linux-x64
```

Execute it explicitly:

```sh
crewcoder deploy user@vps \
  --binary crewcoder-agent/dist-bin/crewcoder-linux-x64 \
  --execute
```

Binary deployment:

1. verifies that the local artifact is executable;
2. creates `~/crewcoder-runner` and its private `.crewcoder` state directory;
3. uploads it as `~/crewcoder-runner/crewcoder`;
4. replaces the prior PID-tracked runner when present;
5. starts authenticated `crewcoder serve` on `127.0.0.1:8787` with `nohup`;
6. writes `crewcoder.pid` and `crewcoder-serve.log` beside the binary;
7. persists the token at `~/crewcoder-runner/.crewcoder/fleet-token`.

Standalone deployment intentionally rejects non-loopback bind addresses. Authentication is defense-in-depth for this SSH-only profile, not permission to expose plaintext HTTP publicly.

Inspect the remote runner and retrieve its token:

```sh
ssh user@vps 'cat ~/crewcoder-runner/crewcoder-serve.log'
ssh user@vps 'kill -0 "$(cat ~/crewcoder-runner/crewcoder.pid)" && echo running'

TOKEN=$(ssh user@vps 'cat ~/crewcoder-runner/.crewcoder/fleet-token')
```

The deployment command prints that retrieval command, not the secret value.

## Browser-free connection options

### 1. Work directly in the VPS terminal

```sh
ssh user@vps
cd /path/to/project
~/crewcoder-runner/crewcoder run --provider codex \
  "Inspect this project and fix the failing tests"
```

This path is authenticated by SSH and does not use the fleet token. Provider credentials still need to exist on the VPS. API-key providers work entirely from the terminal. OAuth/device flows may print a URL and code that you open on another device; the VPS itself does not need a browser.

### 2. Connect an ACP editor over SSH stdio

An ACP-capable editor can use SSH itself as the subprocess transport:

```sh
ssh -T user@vps \
  'cd /path/to/project && ~/crewcoder-runner/crewcoder acp --approval review'
```

This path is authenticated and encrypted by SSH and does not use fleet HTTP authentication. CrewCoder's ACP frames use stdout exclusively; SSH diagnostics and remote shell startup scripts must not print to stdout. Use a non-interactive shell configuration for this command.

### 3. Run the TUI locally and the agent remotely over SSH

Install the TUI on your local PC, then point every backend CLI operation at the deployed agent and remote workspace:

```sh
crewcoder-tui \
  --remote user@vps \
  --remote-cwd /srv/projects/my-project
```

This is the recommended way to use CrewCoder's full terminal UI from your PC against another PC or VPS. SSH carries JSON events and live controls directly; the agent, tools, sessions, goals, and files remain remote. It does not require the fleet HTTP server, tunnel, or bearer token.

See [`../../crewcoder-tui/docs/REMOTE_AGENTS.md`](../../crewcoder-tui/docs/REMOTE_AGENTS.md) for setup, custom binary paths, SSH aliases, supported features, and local-file limitations.

### 4. Connect to fleet mode through an SSH tunnel

Create the tunnel from your local machine:

```sh
ssh -N -L 8787:127.0.0.1:8787 user@vps
```

Retrieve the token in another local terminal:

```sh
export CREWCODER_FLEET_TOKEN="$(
  ssh user@vps 'cat ~/crewcoder-runner/.crewcoder/fleet-token'
)"
```

The remote service is then available through local port `8787`. See the five-minute example above for a token-safe curl configuration and a complete run.

Endpoints:

- `GET /health` — unauthenticated liveness and auth-capability response.
- `GET /runs` — list current and recovered durable run records.
- `POST /runs` — start a run or resume an existing session.
- `GET /runs/:runId` — inspect run status and latest event cursor.
- `GET /runs/:runId/events` — replay events and continue streaming SSE until terminal status.
- `GET /runs/:runId/events?replay=1` — replay current events and close.
- `GET /runs/:runId/events?after=N` — send only events after cursor `N`.
- `WS /runs/:runId/ws?after=N` — replay after a cursor, stream events, and accept controls.
- `POST /runs/:runId/control` — send control messages.

Every endpoint after `/health` requires `Authorization: Bearer <token>`. Native browser `EventSource` cannot set authorization headers; use `fetch()` streaming or `CrewCoderFleetClient.streamEvents()` instead. SSE records include `id: N`; clients may also send `Last-Event-ID: N` when reconnecting.

Run metadata and append-only events are persisted under `<CREWCODER_HOME>/fleet-runs/` with private permissions. These files contain prompts, paths, tool data, and model output and must be treated as sensitive. Completed history survives server restart. A run active during process death is recovered as failed/interrupted; detached goals remain the mechanism for execution that itself survives restarts.

## Raw HTTP and SSE cookbook

The following examples assume `RUN_ID` and the private `FLEET_CURL_CONFIG` were created by the five-minute example.

List durable runs or check one run's status and `lastEventId`:

```sh
curl --silent --show-error \
  --config "$FLEET_CURL_CONFIG" \
  http://127.0.0.1:8787/runs

curl --silent --show-error \
  --config "$FLEET_CURL_CONFIG" \
  "http://127.0.0.1:8787/runs/$RUN_ID"
```

Replay all events currently held by the runner, or resume after a saved cursor, then close:

```sh
curl --silent --show-error \
  --config "$FLEET_CURL_CONFIG" \
  "http://127.0.0.1:8787/runs/$RUN_ID/events?replay=1"

LAST_EVENT_ID=42
curl --silent --show-error \
  --config "$FLEET_CURL_CONFIG" \
  "http://127.0.0.1:8787/runs/$RUN_ID/events?replay=1&after=$LAST_EVENT_ID"
```

Follow the live SSE stream:

```sh
curl --no-buffer --silent --show-error \
  --config "$FLEET_CURL_CONFIG" \
  "http://127.0.0.1:8787/runs/$RUN_ID/events"
```

Queue a follow-up while the run is active:

```sh
curl --silent --show-error \
  --config "$FLEET_CURL_CONFIG" \
  --json '{"type":"control","action":"follow_up","message":"Also update the documentation."}' \
  "http://127.0.0.1:8787/runs/$RUN_ID/control"
```

Request compaction:

```sh
curl --silent --show-error \
  --config "$FLEET_CURL_CONFIG" \
  --json '{"type":"control","action":"compact"}' \
  "http://127.0.0.1:8787/runs/$RUN_ID/control"
```

Resolve an approval after reading `approvalId` from an `approval_required` event:

```sh
APPROVAL_ID="approval_..."

curl --silent --show-error \
  --config "$FLEET_CURL_CONFIG" \
  --json "{\"type\":\"control\",\"action\":\"approval\",\"approvalId\":\"$APPROVAL_ID\",\"approved\":true,\"reason\":\"Approved by operator\"}" \
  "http://127.0.0.1:8787/runs/$RUN_ID/control"
```

Respond to an extension UI request after reading `requestId` from an `extension_ui_request` event:

```sh
REQUEST_ID="ui_request_..."

curl --silent --show-error \
  --config "$FLEET_CURL_CONFIG" \
  --json "{\"type\":\"control\",\"action\":\"ui_response\",\"requestId\":\"$REQUEST_ID\",\"value\":\"selected-value\"}" \
  "http://127.0.0.1:8787/runs/$RUN_ID/control"
```

Abort a run:

```sh
curl --silent --show-error \
  --config "$FLEET_CURL_CONFIG" \
  --json '{"type":"control","action":"abort"}' \
  "http://127.0.0.1:8787/runs/$RUN_ID/control"
```

An unauthenticated protected request returns `401` and a `WWW-Authenticate: Bearer` header:

```sh
curl --include --request POST \
  --json '{"prompt":"this request must not start"}' \
  http://127.0.0.1:8787/runs
```

## TypeScript fleet client

`@onpoint-dev-tools/crewcoder-sdk` provides the supported authenticated client:

```ts
import { CrewCoderFleetClient } from "@onpoint-dev-tools/crewcoder-sdk";

const client = new CrewCoderFleetClient({
  baseUrl: "http://127.0.0.1:8787",
  token: process.env.CREWCODER_FLEET_TOKEN ?? ""
});

const run = await client.createRun({
  prompt: "Fix the failing tests",
  mode: "general",
  approval: "review",
  cwd: "/workspace/project"
});

console.log(`Started ${run.runId}`);

await client.streamEvents(run.runId, async (event) => {
  console.log(event.fleetEventId, event.type);
  if (event.type === "thinking_delta") process.stderr.write(event.text);
  if (event.type === "assistant_delta") process.stdout.write(event.text);

  if (event.type === "approval_required") {
    await client.control(run.runId, {
      type: "control",
      action: "approval",
      approvalId: event.approvalId,
      approved: false,
      reason: "This automation is read-only."
    });
  }
});

const summary = await client.waitForRun(run.runId);
console.log(summary.status, summary.sessionId, summary.eventCount);
```

Queue a follow-up or stop an active run from the host application:

```ts
await client.control(run.runId, {
  type: "control",
  action: "follow_up",
  message: "Also update the documentation."
});

await client.control(run.runId, { type: "control", action: "abort" });
```

Replay after a persisted cursor without keeping a live stream open:

```ts
await client.streamEvents(
  run.runId,
  (event) => console.log(event.fleetEventId, event.type),
  { replay: true, afterEventId: 42 }
);
```

Live SDK streams reconnect automatically with bounded exponential backoff and send the last delivered cursor. Configure `reconnect` on the client/stream or set it to `false` when the host owns retry policy.

For a browser or runtime with a standard `WebSocket` implementation:

```ts
const connection = client.webSocketConnection(run.runId);
const socket = new WebSocket(connection.url, connection.protocols);

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({
    type: "control",
    action: "follow_up",
    message: "Run the focused tests too."
  }));
});

socket.addEventListener("message", (message) => {
  const event = JSON.parse(String(message.data));
  console.log(event.type);
});
```

The protocols are `crewcoder.v1` and `crewcoder.auth.<token>`. This keeps credentials out of URLs and common URL logs. The server selects only `crewcoder.v1` in its response. WebSocket headers still require encrypted transport on untrusted networks.

## Python HTTP example

Fleet mode is language-independent. This standard-library example starts a run without placing the token in the URL:

```py
import json
import os
import urllib.request

base_url = "http://127.0.0.1:8787"
token = os.environ["CREWCODER_FLEET_TOKEN"]
body = json.dumps({
    "prompt": "Fix the failing tests",
    "mode": "general",
    "approval": "review",
}).encode()

request = urllib.request.Request(
    f"{base_url}/runs",
    data=body,
    method="POST",
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    },
)

with urllib.request.urlopen(request) as response:
    run = json.load(response)

print(run["runId"], run["eventUrl"])
```

Go, Rust, .NET, and other HTTP clients use the same bearer header. For WebSockets, non-browser clients may send the bearer `Authorization` header directly; browser-style clients should offer the two subprotocol values described above.

## Existing npm deployment

The original Node/npm deployment remains available when `--binary` is omitted:

```sh
crewcoder deploy user@vps
crewcoder deploy user@vps --execute
```

It packs `@crewcode/crewcoder-agent`, uploads the tarball, and installs it globally with npm on the remote host. It uses the same private deployment state directory and mandatory fleet token. Use standalone binary deployment when Node/npm are unavailable.

## Troubleshooting

### `/health` works but `/runs` returns `401`

`/health` is intentionally public. Protected endpoints require the exact token loaded when the server started.

```sh
# Deployed runner: inspect the authoritative token file.
ssh user@vps 'stat -c "%a %n" ~/crewcoder-runner/.crewcoder/fleet-token'
ssh user@vps 'cat ~/crewcoder-runner/.crewcoder/fleet-token'
```

The expected file mode is `600`. Recreate the local curl configuration or SDK client after retrieving the token. If the token was rotated, restart the server.

### `crewcoder fleet token` prints a different token

The token command and server are using different CrewCoder homes. Set the same home explicitly:

```sh
CREWCODER_HOME=~/crewcoder-runner/.crewcoder \
  ~/crewcoder-runner/crewcoder fleet token --path
```

### The SSH tunnel reports connection refused

Confirm the remote process and listening log:

```sh
ssh user@vps \
  'kill -0 "$(cat ~/crewcoder-runner/crewcoder.pid)" && \
   tail -n 50 ~/crewcoder-runner/crewcoder-serve.log'
```

Then recreate the tunnel:

```sh
ssh -N -L 8787:127.0.0.1:8787 user@vps
```

### WebSocket upgrade returns `401`

Browser-style clients must offer both protocols in this order:

```ts
const socket = new WebSocket(url, [
  "crewcoder.v1",
  `crewcoder.auth.${token}`
]);
```

Do not append the token to the WebSocket URL. Verify that a proxy forwards `Upgrade`, `Connection`, and `Sec-WebSocket-Protocol` headers.

### The run starts but provider calls fail

Fleet authentication only authorizes the CrewCoder API. Provider credentials must separately exist in the server's environment or CrewCoder auth store. Inspect `crewcoder-serve.log` without copying credentials into issue reports.

## Runtime dependencies and limitations

A standalone executable removes the Node/Bun installation requirement; it does not bundle every external program an agent may call.

- `bash` and ordinary shell utilities must exist on the VPS.
- Git tools and extension installation require `git`.
- Code-intelligence tools require their configured language servers.
- Process-based providers and extension tools require their declared commands.
- Trusted JavaScript extension modules are loaded from disk at runtime and must be compatible with the embedded Bun runtime.
- The first artifact targets Linux x64 baseline only; ARM64, musl/Alpine, macOS, and Windows are not yet supported artifacts.
- Fleet run metadata/events are durable, but ordinary in-flight execution is recovered as interrupted after a server process restart. Use detached goals for restart-surviving execution.
- Fleet run history currently has no automatic retention limit; operators must protect and manage `<CREWCODER_HOME>/fleet-runs` as sensitive state.
- Fleet authentication currently uses one runner-wide bearer token; per-user identities, scoped permissions, expiry, and revocation lists are not implemented.

For stronger unattended operation, the next infrastructure step is a user-level systemd unit. For public network access, add HTTPS, origin policy, request limits, and operational monitoring; bearer authentication alone is not sufficient transport security.
