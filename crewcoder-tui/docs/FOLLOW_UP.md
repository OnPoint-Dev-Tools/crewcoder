# Follow-up command

The TUI supports adding more context to an active CrewCoder run without aborting it. While the backend provider process is running, submit ordinary text directly in the composer and the TUI automatically treats it as a follow-up. The explicit forms remain available:

```txt
/follow-up <message>
/followup <message>
```

Automatic and explicit follow-ups are only valid while the backend process is running. Slash-prefixed input continues through normal command handling. A follow-up sends a newline-delimited JSON control message to the backend stdin pipe:

```json
{"type":"control","action":"follow_up","message":"..."}
```

The coding-agent queues the message and injects it as a user message at the next safe point between provider/tool steps. It does **not** cancel or restart the in-flight provider request.

If the current provider response finishes without tool calls after a follow-up was queued, the loop continues for one more iteration when `maxIterations` allows it so the model can answer the follow-up.

Related backend contract: `../../crewcoder-agent/docs/contributor/TUI_BACKEND_CONTRACT.md`.
