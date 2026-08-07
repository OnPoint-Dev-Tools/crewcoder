/**
 * Stdio plumbing for the ACP server.
 *
 * ACP reserves stdout exclusively for JSON-RPC frames. A single stray
 * `console.log` anywhere in CrewCoder — or in a provider adapter, or a
 * dependency — corrupts the stream and the client silently stops parsing.
 *
 * `claimStdout()` therefore captures the real writer up front, hands it to the
 * protocol, and then redirects `process.stdout.write` to stderr so accidental
 * writes are loud and harmless instead of silent and fatal.
 */
import { Readable } from "node:stream";

export type ClaimedStdout = {
  /** Web writable wired directly to the real stdout, bypassing the redirect. */
  output: WritableStream<Uint8Array>;
  input: ReadableStream<Uint8Array>;
  /** Restores the original `process.stdout.write`. */
  release: () => void;
};

export function claimStdout(): ClaimedStdout {
  const realWrite = process.stdout.write.bind(process.stdout);

  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      realWrite(Buffer.from(chunk));
    }
  });

  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  // Anything that still targets stdout is a bug; surface it on stderr instead
  // of letting it interleave with JSON-RPC frames.
  const patched = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    process.stderr.write(`[acp] suppressed stdout write: ${text}`);
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") (done as () => void)();
    return true;
  }) as typeof process.stdout.write;

  process.stdout.write = patched;

  return {
    output,
    input,
    release: () => {
      process.stdout.write = realWrite;
    }
  };
}
