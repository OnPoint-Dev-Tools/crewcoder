export const DEFAULT_TOOL_OUTPUT_BYTES = 50 * 1024;
export const DEFAULT_TOOL_OUTPUT_LINES = 2_000;

export type ToolOutputTruncation = {
  text: string;
  truncated: boolean;
  totalBytes: number;
  totalLines: number;
  outputBytes: number;
  outputLines: number;
  truncatedBy?: "bytes" | "lines";
};

export function truncateToolOutputHead(
  text: string,
  options: { maxBytes?: number; maxLines?: number } = {}
): ToolOutputTruncation {
  return truncateToolOutput(text, "head", options);
}

export function truncateToolOutputTail(
  text: string,
  options: { maxBytes?: number; maxLines?: number } = {}
): ToolOutputTruncation {
  return truncateToolOutput(text, "tail", options);
}

function truncateToolOutput(
  text: string,
  direction: "head" | "tail",
  options: { maxBytes?: number; maxLines?: number }
): ToolOutputTruncation {
  const maxBytes = options.maxBytes ?? DEFAULT_TOOL_OUTPUT_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_TOOL_OUTPUT_LINES;
  const totalBytes = Buffer.byteLength(text, "utf8");
  const lines = text ? text.split("\n") : [];
  const totalLines = lines.length;
  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    return { text, truncated: false, totalBytes, totalLines, outputBytes: totalBytes, outputLines: totalLines };
  }

  const output: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "bytes" | "lines" = totalLines > maxLines ? "lines" : "bytes";
  const indexes = direction === "head"
    ? Array.from({ length: Math.min(lines.length, maxLines) }, (_, index) => index)
    : Array.from({ length: Math.min(lines.length, maxLines) }, (_, index) => lines.length - 1 - index);

  for (const index of indexes) {
    const line = lines[index] ?? "";
    const separatorBytes = output.length ? 1 : 0;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (outputBytes + separatorBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (output.length === 0) output.push(direction === "head" ? utf8Prefix(line, maxBytes) : utf8Suffix(line, maxBytes));
      break;
    }
    if (direction === "head") output.push(line);
    else output.unshift(line);
    outputBytes += separatorBytes + lineBytes;
  }

  const outputText = output.join("\n");
  return {
    text: outputText,
    truncated: true,
    totalBytes,
    totalLines,
    outputBytes: Buffer.byteLength(outputText, "utf8"),
    outputLines: output.length,
    truncatedBy
  };
}

function utf8Prefix(text: string, maxBytes: number): string {
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}

function utf8Suffix(text: string, maxBytes: number): string {
  return Buffer.from(text, "utf8").subarray(-maxBytes).toString("utf8").replace(/^\uFFFD+/u, "");
}
