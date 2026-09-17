import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("package manifest", () => {
  it("maps crew to the CLI entrypoint without claiming the system cc command", () => {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const manifest: unknown = JSON.parse(fs.readFileSync(packagePath, "utf8"));

    expect(manifest).toMatchObject({
      bin: {
        crewcoder: "./dist/cli.js",
        crew: "./dist/cli.js"
      }
    });
    expect(manifest).not.toMatchObject({ bin: { cc: expect.anything() } });
  });
});
