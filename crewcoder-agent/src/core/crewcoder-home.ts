import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CrewCoderHomeInfo = {
  root: string;
  configPath: string;
  sessionsDir: string;
  goalsDir: string;
  extensionsDir: string;
  systemPromptsDir: string;
  commandsDir: string;
  cacheDir: string;
  logsDir: string;
  source: "env" | "root" | "home-fallback";
};

export function getCrewCoderHome(): CrewCoderHomeInfo {
  const envHome = process.env.CREWCODER_HOME;
  if (envHome && envHome.trim()) return buildHome(path.resolve(envHome), "env");

  const rootHome = path.resolve("/.crewcoder");
  try {
    fs.mkdirSync(rootHome, { recursive: true });
    return buildHome(rootHome, "root");
  } catch {
    return buildHome(path.join(os.homedir(), ".crewcoder"), "home-fallback");
  }
}

export function ensureCrewCoderHome(): CrewCoderHomeInfo {
  const home = getCrewCoderHome();
  for (const dir of [home.root, home.sessionsDir, home.goalsDir, home.extensionsDir, home.systemPromptsDir, home.commandsDir, home.cacheDir, home.logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return home;
}

export function resolveCrewCoderHome(): CrewCoderHomeInfo {
  return ensureCrewCoderHome();
}

function buildHome(root: string, source: CrewCoderHomeInfo["source"]): CrewCoderHomeInfo {
  return {
    root,
    configPath: path.join(root, "config.json"),
    sessionsDir: path.join(root, "sessions"),
    goalsDir: path.join(root, "goals"),
    extensionsDir: path.join(root, "extensions"),
    systemPromptsDir: path.join(root, "system-prompts"),
    commandsDir: path.join(root, "commands"),
    cacheDir: path.join(root, "cache"),
    logsDir: path.join(root, "logs"),
    source
  };
}
