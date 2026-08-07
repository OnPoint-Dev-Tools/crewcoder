const { chmodSync, mkdirSync, rmSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..");
const outputDir = path.join(packageRoot, "dist-bin");
const output = path.join(outputDir, "crewcoder-linux-x64");

mkdirSync(outputDir, { recursive: true });
rmSync(output, { force: true });

const result = spawnSync("bun", [
  "build",
  "--compile",
  "--target=bun-linux-x64-baseline",
  "--no-compile-autoload-dotenv",
  `--outfile=${output}`,
  path.join(packageRoot, "src", "cli.ts")
], {
  cwd: packageRoot,
  stdio: "inherit"
});

if (result.error) {
  if (result.error.code === "ENOENT") {
    console.error("Bun is required to build the standalone CrewCoder executable: https://bun.sh");
  } else {
    console.error(result.error.message);
  }
  process.exitCode = 1;
} else if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  chmodSync(output, 0o755);
  console.log(`[crewcoder] standalone Linux x64 executable: ${output}`);
}
