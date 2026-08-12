import type { SessionRecord } from "./session-store.js";
import type { AgentMessage, MessageContent, ToolCallPart } from "./messages.js";
import { getText } from "./messages.js";
import type { ModelUsageBreakdown, UsageSummary } from "./usage.js";

/**
 * Render a durable session as a single self-contained HTML document: transcript,
 * reconstructed file diffs (from recorded write/edit tool calls), and a token
 * usage rollup. No external assets — inline CSS only — so the file is portable.
 */
export function renderSessionMarkdown(record: SessionRecord): string {
  const lines = [
    "# CrewCoder Conversation",
    "",
    `- Session: ${record.id}`,
    `- Started: ${record.startedAt}`,
    `- Working directory: ${record.cwd}`,
    `- Mode: ${record.requestedMode} → ${record.resolvedMode}`,
    ...(record.provider ? [`- Provider: ${record.provider}`] : []),
    ...(record.model ? [`- Model: ${record.model}`] : []),
    "",
  ];

  for (const message of record.messages) {
    if (message.role === "toolResult") {
      lines.push(`## Tool result: ${message.toolName}${message.isError ? " (error)" : ""}`, "");
      const output = message.content.map((part) => part.text).join("\n").trimEnd();
      lines.push(output ? fencedBlock(output) : "_(no output)_", "");
      continue;
    }

    lines.push(message.role === "user" ? "## User" : "## Assistant", "");
    const text = getText(message).trimEnd();
    lines.push(text ? escapeMarkdownHtml(text) : "_(no text)_", "");

    if (message.role === "assistant") {
      for (const call of message.content.filter((part): part is ToolCallPart => part.type === "toolCall")) {
        lines.push(`### Tool call: ${call.name}`, "", fencedBlock(JSON.stringify(call.arguments ?? {}, null, 2), "json"), "");
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderSessionHtml(record: SessionRecord): string {
  const title = `CrewCoder session ${record.id}`;
  const parts = [
    "<!DOCTYPE html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLES}</style>`,
    "</head>",
    "<body>",
    renderHeader(record),
    renderUsageRollup(record.usage),
    renderDiffs(record.messages),
    renderTranscript(record.messages),
    "</body>",
    "</html>"
  ];
  return parts.join("\n");
}

function renderHeader(record: SessionRecord): string {
  const rows: Array<[string, string | undefined]> = [
    ["Session", record.id],
    ["Started", record.startedAt],
    ["Working dir", record.cwd],
    ["External dirs", record.externalDirectories?.join("\n")],
    ["Provider sessions", record.providerSessionIds ? Object.entries(record.providerSessionIds).map(([provider, id]) => `${provider}: ${id}`).join("\n") : undefined],
    ["Mode", `${record.requestedMode} → ${record.resolvedMode}`],
    ["Provider", record.provider],
    ["Model", record.model],
    ["Prompt", record.prompt]
  ];
  const body = rows
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(String(value))}</td></tr>`)
    .join("");
  return `<header><h1>CrewCoder Session Transcript</h1><table class="meta">${body}</table></header>`;
}

function renderUsageRollup(usage: UsageSummary | undefined): string {
  if (!usage) return "<section><h2>Token usage</h2><p class=\"muted\">No usage recorded.</p></section>";
  const byModel = usage.byModel ?? {};
  const modelRows = Object.entries(byModel)
    .map(([key, breakdown]) => modelRow(key, breakdown))
    .join("");
  const totalRow = `<tr class="total"><td>Total</td><td>${usage.turns}</td><td>${num(usage.inputTokens)}</td><td>${num(usage.outputTokens)}</td><td>${num(usage.totalTokens)}</td></tr>`;
  const table = `<table class="usage"><thead><tr><th>Model</th><th>Turns</th><th>Input</th><th>Output</th><th>Total</th></tr></thead><tbody>${modelRows}${totalRow}</tbody></table>`;
  const budget = typeof usage.tokenBudget === "number"
    ? `<p class="muted">Token budget: ${num(usage.totalTokens)} / ${num(usage.tokenBudget)}${usage.budgetExceeded ? " (exceeded)" : ""}</p>`
    : "";
  return `<section><h2>Token usage</h2>${table}${budget}</section>`;
}

function modelRow(key: string, breakdown: ModelUsageBreakdown): string {
  return `<tr><td>${escapeHtml(key)}</td><td>${breakdown.turns}</td><td>${num(breakdown.inputTokens)}</td><td>${num(breakdown.outputTokens)}</td><td>${num(breakdown.totalTokens)}</td></tr>`;
}

function renderDiffs(messages: AgentMessage[]): string {
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      const diff = diffForToolCall(part);
      if (diff) blocks.push(diff);
    }
  }
  if (!blocks.length) return "<section><h2>File changes</h2><p class=\"muted\">No file-writing tool calls recorded.</p></section>";
  return `<section><h2>File changes</h2>${blocks.join("")}</section>`;
}

function diffForToolCall(part: ToolCallPart): string | undefined {
  const args = part.arguments ?? {};
  const filePath = typeof args.path === "string" ? args.path : undefined;
  if (part.name === "write" && typeof args.content === "string") {
    const lines = args.content.split("\n").map((line) => diffLine("+", line)).join("");
    return diffBlock(`write ${filePath ?? "(unknown)"}`, lines);
  }
  if (part.name === "edit" && typeof args.find === "string" && typeof args.replace === "string") {
    const removed = args.find.split("\n").map((line) => diffLine("-", line)).join("");
    const added = args.replace.split("\n").map((line) => diffLine("+", line)).join("");
    return diffBlock(`edit ${filePath ?? "(unknown)"}`, removed + added);
  }
  return undefined;
}

function diffBlock(heading: string, lines: string): string {
  return `<div class="diff"><h3>${escapeHtml(heading)}</h3><pre class="diff-body">${lines}</pre></div>`;
}

function diffLine(marker: "+" | "-", text: string): string {
  const cls = marker === "+" ? "add" : "del";
  return `<span class="line ${cls}">${escapeHtml(marker + " " + text)}</span>\n`;
}

function renderTranscript(messages: AgentMessage[]): string {
  const blocks = messages.map((message) => renderMessage(message)).join("");
  return `<section><h2>Transcript</h2><div class="transcript">${blocks}</div></section>`;
}

function renderMessage(message: AgentMessage): string {
  if (message.role === "toolResult") {
    const text = message.content.map((part) => part.text).join("\n");
    const cls = message.isError ? "msg toolResult error" : "msg toolResult";
    return `<article class="${cls}"><div class="role">tool result · ${escapeHtml(message.toolName)}${message.isError ? " · error" : ""}</div><pre>${escapeHtml(text)}</pre></article>`;
  }
  const roleLabel = message.role === "user" ? "user" : "assistant";
  const text = getText(message);
  const bodyParts: string[] = [];
  if (text.trim()) bodyParts.push(`<pre>${escapeHtml(text)}</pre>`);
  if (message.role === "user" && message.background?.length) {
    bodyParts.push(`<pre class="background">${escapeHtml(message.background.join("\n\n"))}</pre>`);
  }
  const toolCalls = renderToolCalls(message.content);
  if (toolCalls) bodyParts.push(toolCalls);
  const stop = message.role === "assistant" && message.stopReason !== "end" ? ` · ${escapeHtml(message.stopReason)}` : "";
  return `<article class="msg ${roleLabel}"><div class="role">${roleLabel}${stop}</div>${bodyParts.join("")}</article>`;
}

function renderToolCalls(content: MessageContent[]): string {
  const calls = content.filter((part): part is ToolCallPart => part.type === "toolCall");
  if (!calls.length) return "";
  const items = calls.map((call) => {
    const args = escapeHtml(JSON.stringify(call.arguments ?? {}, null, 2));
    return `<details class="toolcall"><summary>${escapeHtml(call.name)}</summary><pre>${args}</pre></details>`;
  });
  return items.join("");
}

function escapeMarkdownHtml(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fencedBlock(text: string, language = "text"): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function num(value: number | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "—";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2rem; line-height: 1.5; color: #1a1a1a; background: #fafafa; }
h1 { font-size: 1.6rem; margin: 0 0 1rem; }
h2 { font-size: 1.2rem; border-bottom: 1px solid #ddd; padding-bottom: .3rem; margin-top: 2rem; }
h3 { font-size: .95rem; margin: 1rem 0 .3rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
header { max-width: 960px; margin: 0 auto; }
section { max-width: 960px; margin: 0 auto; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
table.meta th { text-align: left; width: 140px; color: #555; vertical-align: top; padding: .2rem .5rem .2rem 0; }
table.meta td { padding: .2rem 0; word-break: break-word; }
table.usage th, table.usage td { border: 1px solid #ddd; padding: .35rem .6rem; text-align: right; }
table.usage th:first-child, table.usage td:first-child { text-align: left; }
table.usage tr.total td { font-weight: 600; background: #f0f0f0; }
.muted { color: #888; font-size: .9rem; }
.transcript { display: flex; flex-direction: column; gap: 1rem; }
.msg { border: 1px solid #e0e0e0; border-radius: 8px; padding: .75rem 1rem; background: #fff; }
.msg .role { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: #666; margin-bottom: .4rem; }
.msg.user { border-left: 3px solid #3b82f6; }
.msg.assistant { border-left: 3px solid #10b981; }
.msg.toolResult { border-left: 3px solid #a855f7; }
.msg.toolResult.error { border-left-color: #ef4444; }
.msg pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
pre.background { color: #777; font-size: .8rem; margin-top: .5rem; border-top: 1px dashed #ddd; padding-top: .5rem; }
.toolcall { margin-top: .5rem; }
.toolcall summary { cursor: pointer; font-family: ui-monospace, monospace; font-size: .8rem; color: #444; }
.diff { margin-bottom: 1rem; }
.diff-body { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; border: 1px solid #ddd; border-radius: 6px; overflow: hidden; }
.line { display: block; padding: 0 .5rem; }
.line.add { background: #e6ffed; color: #04630a; }
.line.del { background: #ffeef0; color: #82071e; }
@media (prefers-color-scheme: dark) {
  body { color: #e0e0e0; background: #1a1a1a; }
  .msg { background: #242424; border-color: #333; }
  h2 { border-color: #333; }
  table.usage tr.total td { background: #2a2a2a; }
  .line.add { background: #0f2f16; color: #7ee787; }
  .line.del { background: #331416; color: #ffa198; }
}
`;
