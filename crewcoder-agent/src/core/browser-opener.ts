import { spawn } from "node:child_process";

type BrowserOpenCommand = {
  command: string;
  args: string[];
};

export async function openUrlInDefaultBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const target = url.trim();
  if (!target) return false;

  const opener = browserOpenCommand(target, platform);
  if (!opener) return false;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      resolve(opened);
    };

    const child = spawn(opener.command, opener.args, { detached: true, stdio: "ignore" });
    child.once("error", () => finish(false));
    child.once("spawn", () => {
      child.unref();
      finish(true);
    });
  });
}

export function browserOpenCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserOpenCommand | undefined {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") return { command: "xdg-open", args: [url] };
  return undefined;
}
