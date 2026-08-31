import { spawn } from "node:child_process";
import readline from "node:readline";

const UMBRELLA_PACKAGE = "crewcoder";

export type SelfUpdateOptions = { yes?: boolean };

type ConfirmationInput = Pick<NodeJS.ReadStream, "isTTY" | "on" | "off" | "resume" | "pause"> & {
  setRawMode?: (mode: boolean) => void;
};

export type SelfUpdateDependencies = {
  currentVersion: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stdin?: ConfirmationInput;
  getLatestVersion?: () => Promise<string>;
  installLatest?: () => Promise<void>;
  confirm?: (message: string) => Promise<boolean>;
};

export type SelfUpdateResult = "up-to-date" | "declined" | "updated";

export async function runSelfUpdate(options: SelfUpdateOptions, dependencies: SelfUpdateDependencies): Promise<SelfUpdateResult> {
  const output = dependencies.stdout ?? process.stdout;
  const getLatestVersion = dependencies.getLatestVersion ?? fetchLatestVersion;
  const installLatest = dependencies.installLatest ?? installLatestVersion;
  const latestVersion = validateVersion(await getLatestVersion(), "npm latest version");
  const currentVersion = validateVersion(dependencies.currentVersion, "installed CrewCoder version");

  if (compareVersions(currentVersion, latestVersion) >= 0) {
    output.write("current version is up to date\n");
    return "up-to-date";
  }

  output.write(`CrewCoder update available: ${currentVersion} -> ${latestVersion}\n`);
  const confirmed = options.yes || await (dependencies.confirm ?? ((message) => confirmWithArrowKeys(message, dependencies.stdin, output)))(
    `Install ${UMBRELLA_PACKAGE}@latest globally?`
  );
  if (!confirmed) {
    output.write("Update cancelled.\n");
    return "declined";
  }

  output.write(`Installing ${UMBRELLA_PACKAGE}@latest...\n`);
  await installLatest();
  output.write(`CrewCoder updated to ${latestVersion}.\n`);
  return "updated";
}

export function compareVersions(left: string, right: string): number {
  const leftParts = stableVersionParts(validateVersion(left, "version"));
  const rightParts = stableVersionParts(validateVersion(right, "version"));
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function confirmWithArrowKeys(
  message: string,
  input: ConfirmationInput = process.stdin,
  output: Pick<NodeJS.WriteStream, "write"> = process.stdout
): Promise<boolean> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive update confirmation requires a TTY. Re-run with --yes.");
  }

  readline.emitKeypressEvents(input as NodeJS.ReadStream);
  input.setRawMode(true);
  input.resume();
  let selected = true;

  const render = (): void => {
    output.write(`\r\u001b[2K${message}  ${selected ? "❯ Yes   No" : "  Yes ❯ No"}`);
  };

  return new Promise<boolean>((resolve) => {
    const finish = (answer: boolean): void => {
      input.off("keypress", onKeypress);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      resolve(answer);
    };
    const onKeypress = (character: string | undefined, key: readline.Key): void => {
      if (key.name === "left" || key.name === "up") selected = true;
      else if (key.name === "right" || key.name === "down") selected = false;
      else if (key.name === "return") { finish(selected); return; }
      else if (key.name === "y") { finish(true); return; }
      else if (key.name === "n" || key.name === "escape") { finish(false); return; }
      else if (key.ctrl && key.name === "c") { finish(false); return; }
      else if (character !== undefined) return;
      render();
    };
    input.on("keypress", onKeypress);
    render();
  });
}

function validateVersion(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^\d+\.\d+\.\d+$/.test(trimmed)) throw new Error(`Invalid ${label}: ${JSON.stringify(trimmed)}.`);
  return trimmed;
}

function stableVersionParts(version: string): [number, number, number] {
  const [major, minor, patch] = version.split(".").map(Number);
  return [major!, minor!, patch!];
}

async function fetchLatestVersion(): Promise<string> {
  const output = await runNpm(["view", `${UMBRELLA_PACKAGE}@latest`, "version", "--json"], "check the npm registry");
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`npm returned an invalid latest version response: ${output.trim() || "(empty)"}`, { cause: error });
  }
  if (typeof parsed !== "string") throw new Error("npm returned an invalid latest version response.");
  return parsed;
}

async function installLatestVersion(): Promise<void> {
  await runNpm(["install", "--global", `${UMBRELLA_PACKAGE}@latest`], "install the CrewCoder update", "inherit");
}

function runNpm(args: string[], purpose: string, stdio: "pipe" | "inherit" = "pipe"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, { shell: false, stdio });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    if (child.stderr) child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => reject(new Error(`Unable to ${purpose}: ${error.message}`, { cause: error })));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Unable to ${purpose}: npm exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}
