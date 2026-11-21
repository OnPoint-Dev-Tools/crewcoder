import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCrewName, type CrewCoderCrewTarget } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";

/**
 * Crews in tmux (`docs/CREWS.md#tmux`): `/crew` and `/team` can run in a second
 * CrewCoder UI inside tmux, so the crew keeps going after this UI closes. The
 * user attaches to watch it and answer approvals there.
 *
 * Everything the second UI needs goes in a private handoff file, never on the
 * command line: argv is visible to every user through `ps`, and `CREWCODER_*`
 * variables can hold credentials. The tmux server also has its own environment
 * (not this process's), so the variables travel in the file too.
 */

/** What the second UI runs, plus the settings and environment it starts with. */
export type CrewHandoff = {
  version: 1;
  target: CrewCoderCrewTarget;
  task: string;
  /** What the user typed, shown as their message in the second UI. */
  command: string;
  cwd: string;
  provider: string;
  model: string;
  effort: string;
  mode: string;
  systemPrompt?: string;
  fullAccess: boolean;
  /** `CREWCODER_*` variables (agent binary, home, task override, theme, ...) and PATH. */
  env: Record<string, string>;
};

/** Where the crew went: a new window in the user's tmux, or a detached session. */
export type TmuxPlacement = { kind: "window"; name: string } | { kind: "session"; name: string };

export type TmuxLauncher = {
  /** Start `command` (argv, no shell) in tmux, in `cwd`, named after `label`. */
  launch(command: readonly string[], cwd: string, label: string): Promise<TmuxPlacement>;
};

const HANDOFF_PREFIX = "crewcoder-crew-";

/** Variables the second UI needs from this one. */
export function handoffEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && (key.startsWith("CREWCODER_") || key === "PATH")) picked[key] = value;
  }
  return picked;
}

/** tmux names: the label's safe characters plus a short unique suffix (names are tmux targets). */
export function tmuxName(label: string, suffix: string): string {
  const base = label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "crew";
  return `crew-${base}-${suffix}`;
}

/**
 * Arguments for `tmux`. Inside tmux ($TMUX set) the crew opens as a new window in
 * the user's session; outside, as a detached session to attach to. The command
 * follows `--` as separate arguments, so tmux runs it without a shell.
 */
export function tmuxLaunchArgs(command: readonly string[], cwd: string, name: string, inside: boolean): string[] {
  return inside
    ? ["new-window", "-d", "-n", name, "-c", cwd, "--", ...command]
    : ["new-session", "-d", "-s", name, "-c", cwd, "--", ...command];
}

/** How the user reaches the crew. */
export function tmuxAttachHint(placement: TmuxPlacement): string {
  return placement.kind === "window"
    ? `Opened tmux window ${placement.name}. Switch to it with your tmux prefix + w.`
    : `Started tmux session ${placement.name}. Attach with: tmux attach -t ${placement.name}`;
}

/** Write the handoff file (owner-only) and return its path. */
export function writeCrewHandoff(handoff: CrewHandoff, dir = os.tmpdir()): string {
  const file = path.join(dir, `${HANDOFF_PREFIX}${crypto.randomBytes(8).toString("hex")}.json`);
  // `wx`: never follow or overwrite something already at that path.
  fs.writeFileSync(file, JSON.stringify(handoff), { mode: 0o600, flag: "wx" });
  return file;
}

/**
 * Read and delete a handoff file. It is our own file, but it sits in a shared temp
 * directory, so it is checked like input: owned by this user, not readable by
 * others, and every field the crew uses is validated.
 */
export function readCrewHandoff(file: string): CrewHandoff {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error(`Crew handoff is not a file: ${file}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`Crew handoff is owned by another user: ${file}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Crew handoff is readable by other users: ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } finally {
    fs.rmSync(file, { force: true });
  }
  return parseCrewHandoff(raw);
}

export function parseCrewHandoff(raw: unknown): CrewHandoff {
  const value = raw as Partial<CrewHandoff> | null;
  const text = (key: keyof CrewHandoff): string => {
    const field = value?.[key];
    if (typeof field !== "string" || !field) throw new Error(`Crew handoff has no ${key}`);
    return field;
  };
  if (!value || value.version !== 1) throw new Error("Unsupported crew handoff");
  const target = value.target;
  const validTarget = target?.kind === "workers"
    ? Array.isArray(target.workers) && target.workers.length > 0 && target.workers.every((name) => typeof name === "string" && isCrewName(name))
    : target?.kind === "team" && typeof target.team === "string" && isCrewName(target.team);
  if (!target || !validTarget) throw new Error("Crew handoff has an invalid worker or team");
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.env ?? {})) {
    if (typeof entry === "string" && (key.startsWith("CREWCODER_") || key === "PATH")) env[key] = entry;
  }
  return {
    version: 1,
    target,
    task: text("task"),
    command: text("command"),
    cwd: text("cwd"),
    provider: text("provider"),
    model: text("model"),
    effort: text("effort"),
    mode: text("mode"),
    systemPrompt: typeof value.systemPrompt === "string" && value.systemPrompt ? value.systemPrompt : undefined,
    fullAccess: value.fullAccess === true,
    env
  };
}

/** Delete handoff files nobody picked up (the second UI failed to start). */
export function removeCrewHandoff(file: string): void {
  if (path.basename(file).startsWith(HANDOFF_PREFIX)) fs.rmSync(file, { force: true });
}

/**
 * The real launcher, or undefined when tmux is not installed. Called once at
 * startup (a quick `tmux -V`).
 */
export function systemTmux(env: NodeJS.ProcessEnv = process.env): TmuxLauncher | undefined {
  const probe = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 2_000 });
  if (probe.error || probe.status !== 0) return undefined;
  const inside = Boolean(env.TMUX);
  return {
    launch(command, cwd, label) {
      const name = tmuxName(label, crypto.randomBytes(2).toString("hex"));
      return new Promise((resolve, reject) => {
        const child = spawn("tmux", tmuxLaunchArgs(command, cwd, name, inside), { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve(inside ? { kind: "window", name } : { kind: "session", name });
          else reject(new Error(stderr.trim() || `tmux exited with ${code ?? "a signal"}`));
        });
      });
    }
  };
}
