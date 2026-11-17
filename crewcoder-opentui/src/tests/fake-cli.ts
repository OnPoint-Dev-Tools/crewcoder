import type { ProviderRecord, SessionRecord } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import type { CliResult, CrewCoderCli } from "../crewcoder-cli.js";

/** Scripted CLI: responses keyed by the joined argument list; every call is recorded. */
export class FakeCli implements CrewCoderCli {
  calls: string[][] = [];
  responses = new Map<string, CliResult>();
  providerList: ProviderRecord[] = [];
  sessionList: SessionRecord[] = [];
  branches: string[] = [];
  branchResult = "branch-1";

  json(args: string, value: unknown): this {
    this.responses.set(args, { stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
    return this;
  }

  fail(args: string, stderr: string): this {
    this.responses.set(args, { stdout: "", stderr, exitCode: 1 });
    return this;
  }

  async exec(args: string[]): Promise<CliResult> {
    this.calls.push(args);
    return this.responses.get(args.join(" ")) ?? { stdout: "", stderr: `unscripted: ${args.join(" ")}`, exitCode: 1 };
  }

  async providers(): Promise<ProviderRecord[]> {
    return this.providerList;
  }

  async sessions(): Promise<SessionRecord[]> {
    return this.sessionList;
  }

  async branch(sessionId: string): Promise<string> {
    this.branches.push(sessionId);
    return this.branchResult;
  }

  ran(args: string): boolean {
    return this.calls.some((call) => call.join(" ") === args);
  }
}

/** Let pending CLI promises and their `.then` handlers settle. */
export async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
