# Hosted text tool policy

ACP clients may request a restrictive per-session tool policy for management agents. CrewCoder advertises:

```json
{
  "crewcoder/sessionToolPolicy": {
    "method": "session/set_tool_policy",
    "version": 1,
    "policies": ["hosted-text-only"]
  }
}
```

After new/load, call `session/set_tool_policy` with `sessionId`, `policy: "hosted-text-only"`, and `version: 1`. Success returns the same policy/version and `applied: true`. Both client filesystem capabilities are required. Unsupported policies and changes during active prompts are rejected. The policy is held in memory, so clients must reapply it after load or process restart before sending a prompt.

Restricted prompts use only supplied hosted text read/write tools, plus any client-hosted tools the client registered (see [Client-hosted tools](CLIENT_TOOLS.md)), which the client executes. These directly call ACP filesystem methods without local fallback, image decoding, checkpoints, executable extension hooks, native worker delegation, project discovery, or verification commands. General mode is selected internally so a user's coding workflow mode cannot add mutation or planning tools. The client host is responsible for validating paths and authorizing each virtual operation. Ordinary CLI, SDK, and unrestricted ACP sessions retain their existing behavior.

The agent loop sets provider-native file tools off. Codex app-server then yields to the tool-routed Responses path. Direct Codex requests use `reasoning.summary: "auto"`; the app-server setting `summary: "none"` must not be forwarded as that wire value. Tool-routed HTTP/Responses and WebSocket providers are supported. External process/model-command/ACP agent providers and Claude Agent SDK are rejected for restricted prompts because their native execution and project hooks are outside this boundary. The check also applies to manual compaction; compaction is tool-free and skips executable extension hooks.

This policy does not sandbox the CrewCoder process, protect against malicious host code, or grant access to any client resource. The host must reject ordinary filesystem fallback and forbidden connector/management commands independently. It must also fail closed if capability negotiation or policy acknowledgment fails.

CrewMate uses this policy for Supervisors while preserving ordinary Crew Member execution sessions. Profile text, enabled skill instructions, approval modes, and prior session transcripts cannot add a missing tool.

Tests: `test/hosted-text-policy.test.ts` covers new/resumed restrictions, host-only I/O, absent native tools, unknown-tool failures, and missing host capabilities. The existing ACP adapter suite verifies advertised wire metadata. Run agent typecheck and package tests, then build the agent before using it through a local ACP client.
