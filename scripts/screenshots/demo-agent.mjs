#!/usr/bin/env node
// Scripted CrewCoder agent for the README screenshots (see shoot.sh). It answers
// `run` and `session resume` with a fixed, realistic JSON event stream and edits the
// demo project so the inline diff gets real line numbers. Other commands print nothing.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => ({ role: "toolResult", content: [{ type: "text", text: t }] });
const usage = (input, output, cost, turns) => emit({ type: "usage_update", usage: {}, summary: {
  inputTokens: input, outputTokens: output, totalTokens: input + output, lastInputTokens: input,
  contextWindow: 200000, costUsd: cost, turns } });

if (args[0] !== "run" && !(args[0] === "session" && args[1] === "resume")) process.exit(0);
const resumed = args[0] === "session";
const cwd = process.cwd();
const file = path.join(cwd, "src/routes/todos.ts");

async function stream(chunks, type) {
  for (const chunk of chunks) { emit({ type, text: chunk }); await sleep(15); }
}

async function firstTurn() {
  emit({ type: "agent_start", sessionId: "demo-session" });
  emit({ type: "session_saved", sessionId: "demo-session" });
  await stream([
    "The handler trusts `page` and `limit` straight from the query string. ",
    "`Number(\"abc\")` is `NaN` and nothing caps `limit`, so one request can ask for every row. ",
    "I'll read the route, check how other routes validate input, then add bounds and tests."
  ], "thinking_delta");

  const original = fs.readFileSync(file, "utf8");
  emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "src/routes/todos.ts" } });
  await sleep(40);
  emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", isError: false,
    result: text(original.trimEnd().split("\n").map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join("\n")) });

  emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "grep", args: { pattern: "z\\.coerce", path: "src" } });
  await sleep(40);
  emit({ type: "tool_execution_end", toolCallId: "t2", toolName: "grep", isError: false, result: text("No matches found.") });

  const find = `  const page = Number(req.query.page ?? 1);\n  const limit = Number(req.query.limit ?? 20);\n`;
  const replace = `  const page = clampInt(req.query.page, 1, 1, 10_000);\n  const limit = clampInt(req.query.limit, 20, 1, MAX_LIMIT);\n`;
  emit({ type: "tool_execution_start", toolCallId: "t3", toolName: "edit", args: { path: "src/routes/todos.ts", find, replace } });
  fs.writeFileSync(file, original.replace(find, replace));
  emit({ type: "file_changed", path: "src/routes/todos.ts" });
  await sleep(40);
  emit({ type: "tool_execution_end", toolCallId: "t3", toolName: "edit", isError: false, result: text("Edited src/routes/todos.ts (1 replacement).") });

  emit({ type: "file_changed", path: "src/routes/todos.test.ts" });
  emit({ type: "tool_execution_start", toolCallId: "t4", toolName: "bash", args: { command: "npm test -- todos" } });
  await sleep(40);
  emit({ type: "tool_execution_end", toolCallId: "t4", toolName: "bash", isError: false, result: text([
    " ✓ src/routes/todos.test.ts (6 tests) 41ms",
    "",
    " Test Files  1 passed (1)",
    "      Tests  6 passed (6)",
    "   Duration  612ms"
  ].join("\n")) });
  usage(18234, 2140, 0.21, 4);

  const reply = [
    "Pagination on `GET /todos` is now bounded.\n\n",
    "- **`page`** must be a whole number from 1 to 10,000 and defaults to 1.\n",
    "- **`limit`** must be from 1 to `MAX_LIMIT` (100) and defaults to 20.\n",
    "- Values like `abc` or `-5` fall back to the default instead of reaching the store as `NaN`.\n\n",
    "| Request | Before | After |\n|---|---|---|\n",
    "| `?limit=100000` | 100,000 rows | 100 rows |\n",
    "| `?page=abc` | `NaN` offset | page 1 |\n\n",
    "All 6 tests in `todos.test.ts` pass."
  ];
  await stream(reply, "assistant_delta");
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply.join("") }] }, durationMs: 6400, outputTokens: 640 });
  emit({ type: "agent_end" });
}

async function secondTurn() {
  emit({ type: "agent_start", sessionId: "demo-session" });
  await stream(["Both files are ready. Committing needs approval in Review mode, so I'll ask first."], "thinking_delta");
  const command = "git commit -am \"fix(todos): bound page and limit query params\"";
  emit({ type: "tool_execution_start", toolCallId: "t5", toolName: "bash", args: { command } });
  emit({ type: "approval_required", approvalId: "a1", toolCallId: "t5", toolName: "bash", risk: "review",
    reason: "Create a git commit on feature/pagination", args: { command } });
  usage(21890, 2410, 0.24, 5);
  // Wait for the user's decision on stdin, like the real agent.
  await new Promise(() => setInterval(() => {}, 1 << 30));
}

await (resumed ? secondTurn() : firstTurn());
