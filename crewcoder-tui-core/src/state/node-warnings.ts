/**
 * Node.js process warnings (`process.emitWarning`) that the agent or a library it loads
 * writes to stderr, e.g. `(node:123) [CODE] Warning: ...` and Node's
 * `(Use \`node --trace-warnings ...\`...)` hint. They are diagnostics, not failures, so the
 * UI logs them instead of drawing an error block.
 */
const NODE_WARNING_LINE = /^\(node:\d+\) (?:\[[\w.-]+\] )?\w*Warning: /;
const NODE_TRACE_HINT_LINE = /^\(Use `node --trace-[\w-]+ \.\.\.` to show where the warning was created\)$/;

export type SplitStderr = {
  /** Node warning lines, without the trace hint. */
  warnings: string[];
  /** Everything else, unchanged; empty when the chunk held only warnings. */
  rest: string;
};

export function splitNodeWarnings(text: string): SplitStderr {
  const warnings: string[] = [];
  const rest: string[] = [];
  for (const line of text.split("\n")) {
    if (NODE_WARNING_LINE.test(line)) warnings.push(line);
    else if (!NODE_TRACE_HINT_LINE.test(line)) rest.push(line);
  }
  const remaining = rest.join("\n");
  return { warnings, rest: remaining.trim() ? remaining : "" };
}
