import fs from "node:fs";
import path from "node:path";
import type { CrewCoderLiveUiJsonValue } from "./live-ui-protocol.js";

export class LiveUiSessionStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  read(sessionId: string, extensionId: string, key: string): CrewCoderLiveUiJsonValue | undefined {
    const filePath = path.join(this.baseDir, sessionId, extensionId, `${key}.json`);
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as CrewCoderLiveUiJsonValue;
    } catch {
      return undefined;
    }
  }

  write(sessionId: string, extensionId: string, key: string, value: CrewCoderLiveUiJsonValue): void {
    const dir = path.join(this.baseDir, sessionId, extensionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(value, null, 2));
  }

  deleteSession(sessionId: string): void {
    const dir = path.join(this.baseDir, sessionId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Directory may not exist; that's fine.
    }
  }
}
