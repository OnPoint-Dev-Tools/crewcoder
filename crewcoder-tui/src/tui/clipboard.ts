import { spawnSync } from "node:child_process";

export type ClipboardImage = { mime: string; data: Buffer };

/**
 * Read an image off the system clipboard as raw bytes. Returns undefined when the
 * clipboard holds no image (or no image tool is installed) so callers can fall
 * back to text paste. Buffers are read with `encoding: "buffer"` — never utf8 —
 * because PNG/JPEG bytes are not valid text and utf8 decoding corrupts them.
 */
export function readClipboardImage(): ClipboardImage | undefined {
  for (const command of imageReadCommands()) {
    const result = spawnSync(command.cmd, command.args, { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    if (result.error || result.status !== 0) continue;
    const data = result.stdout;
    if (!Buffer.isBuffer(data) || data.length === 0) continue;
    return { mime: command.mime, data };
  }
  return undefined;
}

export function writeClipboard(text: string): boolean {
  if (!text) return false;
  for (const command of writeCommands()) {
    const result = spawnSync(command.cmd, command.args, { input: text, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

export function readClipboard(): string | undefined {
  for (const command of readCommands()) {
    const result = spawnSync(command.cmd, command.args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (!result.error && result.status === 0 && typeof result.stdout === "string") return result.stdout;
  }
  return undefined;
}

type ClipboardCommand = { cmd: string; args: string[] };
type ClipboardImageCommand = ClipboardCommand & { mime: string };

export function imageReadCommands(): ClipboardImageCommand[] {
  if (process.platform === "darwin") {
    // pngpaste is the de-facto tool; `-` streams PNG bytes to stdout.
    return [{ cmd: "pngpaste", args: ["-"], mime: "image/png" }];
  }
  if (process.platform === "win32") {
    const script = "Add-Type -AssemblyName System.Windows.Forms;$i=[System.Windows.Forms.Clipboard]::GetImage();if($i){$m=New-Object IO.MemoryStream;$i.Save($m,[System.Drawing.Imaging.ImageFormat]::Png);$o=[Console]::OpenStandardOutput();$b=$m.ToArray();$o.Write($b,0,$b.Length)}";
    return [{ cmd: "powershell.exe", args: ["-NoProfile", "-Command", script], mime: "image/png" }];
  }
  // Wayland (wl-paste) and X11 (xclip) both expose the MIME-typed clipboard target.
  return [
    { cmd: "wl-paste", args: ["--type", "image/png"], mime: "image/png" },
    { cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"], mime: "image/png" }
  ];
}

function writeCommands(): ClipboardCommand[] {
  if (process.platform === "darwin") return [{ cmd: "pbcopy", args: [] }];
  if (process.platform === "win32") return [{ cmd: "clip.exe", args: [] }];
  return [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] }
  ];
}

function readCommands(): ClipboardCommand[] {
  if (process.platform === "darwin") return [{ cmd: "pbpaste", args: [] }];
  if (process.platform === "win32") return [{ cmd: "powershell.exe", args: ["-NoProfile", "-Command", "Get-Clipboard"] }];
  return [
    { cmd: "wl-paste", args: ["--no-newline"] },
    { cmd: "xclip", args: ["-selection", "clipboard", "-out"] },
    { cmd: "xsel", args: ["--clipboard", "--output"] }
  ];
}
