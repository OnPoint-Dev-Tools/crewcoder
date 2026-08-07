import fs from "node:fs/promises";
import path from "node:path";
import { ensureCrewCoderHome } from "./crewcoder-home.js";
import type { ModelInput } from "./model-client.js";
import { redactSecrets } from "./secret-redaction.js";

export type ModelInputDumpMetadata = {
  sessionId: string;
  iteration: number;
  providerId?: string;
  model?: string;
};

export type ModelInputDump = ModelInputDumpMetadata & {
  dumpedAt: string;
  modelInput: ModelInput;
};

export async function dumpModelInput(input: ModelInput, metadata: ModelInputDumpMetadata): Promise<string> {
  const home = ensureCrewCoderHome();
  const file = path.join(home.logsDir, `model-input-${sanitize(metadata.sessionId)}-turn-${metadata.iteration}.json`);
  const payload: ModelInputDump = {
    dumpedAt: new Date().toISOString(),
    ...metadata,
    modelInput: input
  };
  await fs.writeFile(file, JSON.stringify(redactSecrets(payload), null, 2) + "\n", "utf8");
  return file;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}
