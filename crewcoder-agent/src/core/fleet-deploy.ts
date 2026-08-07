import { spawn } from "node:child_process";

export type FleetDeployPlan = {
  target: string;
  remoteDir: string;
  archiveName: string;
  format: "npm" | "binary";
  artifactPath?: string;
  tokenPath: string;
  commands: string[];
};

export type FleetDeployOptions = {
  remoteDir?: string;
  port?: number;
  host?: string;
  /** Local standalone executable to upload instead of installing an npm package. */
  binaryPath?: string;
};

export function createFleetDeployPlan(target: string, options: FleetDeployOptions = {}): FleetDeployPlan {
  const trimmed = target.trim();
  if (!trimmed) throw new Error("Deploy target is required, e.g. user@host.");
  const remoteDir = options.remoteDir?.trim() || "~/crewcoder-runner";
  const archiveName = "crewcoder-runner.tgz";
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const binaryPath = options.binaryPath?.trim();
  const tokenPath = `${remoteDir}/.crewcoder/fleet-token`;
  if (binaryPath && !isLoopbackHost(host)) {
    throw new Error("Standalone binary deployment is SSH-only and must bind to 127.0.0.1, localhost, or ::1.");
  }
  if (binaryPath) {
    return {
      target: trimmed,
      remoteDir,
      archiveName: "crewcoder",
      format: "binary",
      artifactPath: binaryPath,
      tokenPath,
      commands: [
        `test -x ${quoteShell(binaryPath)}`,
        `ssh ${trimmed} 'mkdir -p ${quoteShell(remoteDir)} ${quoteShell(`${remoteDir}/.crewcoder`)} && chmod 700 ${quoteShell(`${remoteDir}/.crewcoder`)}'`,
        `scp ${quoteShell(binaryPath)} ${trimmed}:${remoteDir}/crewcoder`,
        `ssh ${trimmed} 'chmod +x ${quoteShell(`${remoteDir}/crewcoder`)}'`,
        `ssh ${trimmed} 'cd ${quoteShell(remoteDir)} && if [ -f crewcoder.pid ] && kill -0 "$(cat crewcoder.pid)" 2>/dev/null; then kill "$(cat crewcoder.pid)"; fi; CREWCODER_HOME="$PWD/.crewcoder" nohup ./crewcoder serve --host ${quoteShell(host)} --port ${port} > crewcoder-serve.log 2>&1 & echo $! > crewcoder.pid'`
      ]
    };
  }
  return {
    target: trimmed,
    remoteDir,
    archiveName,
    format: "npm",
    tokenPath,
    commands: [
      `npm pack --silent --workspace @onpoint-dev-tools/crewcoder-agent`,
      `ssh ${trimmed} 'mkdir -p ${quoteShell(remoteDir)} ${quoteShell(`${remoteDir}/.crewcoder`)} && chmod 700 ${quoteShell(`${remoteDir}/.crewcoder`)}'`,
      `scp ${archiveName} ${trimmed}:${remoteDir}/${archiveName}`,
      `ssh ${trimmed} 'cd ${quoteShell(remoteDir)} && npm install -g ./${archiveName}'`,
      `ssh ${trimmed} 'cd ${quoteShell(remoteDir)} && CREWCODER_HOME="$PWD/.crewcoder" nohup crewcoder serve --host ${quoteShell(host)} --port ${port} > crewcoder-serve.log 2>&1 &'`
    ]
  };
}

export async function executeFleetDeployPlan(plan: FleetDeployPlan, cwd = process.cwd()): Promise<void> {
  for (const command of plan.commands) {
    await runShellCommand(command, cwd);
  }
}

function runShellCommand(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) { resolve(); return; }
      reject(new Error(`Command failed with exit code ${code}: ${command}`));
    });
  });
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function quoteShell(value: string): string {
  if (/^[A-Za-z0-9_./~:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
