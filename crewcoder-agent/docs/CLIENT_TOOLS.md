# Client-hosted tools

An ACP client can give CrewCoder typed tools that the client executes. The model sees them as ordinary function tools; each call is sent back to the client over the same ACP connection, and the client's answer becomes the tool result. This replaces virtual-file command protocols (write a command file, then read a result file) with one call per action. It also crosses any transport that carries the ACP stream, because it adds no port or listener.

## Capability

CrewCoder advertises on `initialize._meta`:

```json
{
  "crewcoder/clientTools": {
    "method": "session/set_client_tools",
    "callMethod": "crewcoder/client_tool/call",
    "version": 1,
    "maxTools": 32
  }
}
```

## Registering tools

After `session/new` or `session/load`, call `session/set_client_tools`:

```json
{ "sessionId": "...", "version": 1, "tools": [{ "name": "crew_workspace_action", "description": "...", "inputSchema": { "type": "object", "properties": {}, "required": [] } }] }
```

- Success returns `{ "applied": true, "version": 1, "count": <n> }`. An empty list clears the tools.
- Tools are held in memory per session. Clients must register them again after a load or process restart.
- Changing tools during an active prompt is rejected.
- Names match `^[a-z][a-z0-9_]{2,63}$`, must be unique, and may not match any built-in CrewCoder tool in any mode.
- `inputSchema` must be an object schema in the subset every provider adapter can translate: `type` (object, array, string, number, integer, boolean), `description`, `properties`, `required`, `additionalProperties` (boolean), `items`, string `enum`, `minLength`, `maxLength`, `minimum`, `maximum`. Anything else (`oneOf`, `$ref`, null types) is rejected, because the Claude Agent SDK path converts schemas to zod and would silently drop unsupported parts.
- The Claude Agent SDK path builds top-level arguments as a strict object, so free-form fields belong in a nested object property, where unknown keys pass through.

## Calls

When the model calls a client tool, CrewCoder sends a JSON-RPC request to the client:

```json
{ "method": "crewcoder/client_tool/call", "params": { "sessionId": "...", "name": "crew_workspace_action", "arguments": { } } }
```

The client answers `{ "content": [{ "type": "text", "text": "..." }], "isError": false }`. A string `content` is also accepted. `isError: true` is reported to the model as a failed tool result with the text as the error. Results are capped at 50,000 characters.

- Client tools run sequentially, because the client may wait on a human approval.
- CrewCoder does not approve, checkpoint, or audit client tool calls. The client is the authority and must check its own grants on every call.
- There is no request timeout on the CrewCoder side, so a client may hold a call open while a user decides.

## Hosted text policy

Client tools stay available under the `hosted-text-only` policy alongside the hosted `read` and `write` tools. They add no local execution, because the client executes them. See [Hosted text tool policy](HOSTED_TOOL_POLICY.md).

## Tests

`src/tests/acp-adapter.test.ts` (`acp client tools`) covers the advertised capability, a full model-to-host round trip, host errors, availability under the hosted policy, and rejected definitions.
