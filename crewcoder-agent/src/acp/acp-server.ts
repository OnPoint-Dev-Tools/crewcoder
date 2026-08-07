/**
 * Entry point for `crewcoder acp`.
 *
 * Wires the ACP agent to a bidirectional message stream. The stream is injected
 * rather than read from `process` directly so tests can drive the server over
 * in-memory streams with no subprocess.
 */
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { CrewCoderAcpAgent, type AcpAgentOptions } from "./acp-agent.js";
import { claimStdout } from "./stdio.js";

export type AcpServerOptions = AcpAgentOptions & {
  output: WritableStream<Uint8Array>;
  input: ReadableStream<Uint8Array>;
};

export function createAcpServer(options: AcpServerOptions): AgentSideConnection {
  const { output, input, ...agentOptions } = options;
  return new AgentSideConnection(
    (conn) => new CrewCoderAcpAgent(conn, agentOptions),
    ndJsonStream(output, input)
  );
}

/** Runs the ACP server over stdio until stdin closes. */
export async function runAcpStdioServer(options: AcpAgentOptions = {}): Promise<void> {
  const { output, input, release } = claimStdout();
  createAcpServer({ ...options, output, input });
  try {
    await new Promise<void>((resolve) => {
      process.stdin.once("end", resolve);
      process.stdin.once("close", resolve);
    });
  } finally {
    release();
  }
}
