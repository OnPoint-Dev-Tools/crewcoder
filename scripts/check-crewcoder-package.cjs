#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const requiredDependencies = [
  "@onpoint-dev-tools/crewcoder-agent",
  "@onpoint-dev-tools/crewcoder-tui",
  // The published agent currently imports the TypeScript compiler at runtime.
  "typescript"
];

for (const dependency of requiredDependencies) {
  if (typeof manifest.dependencies?.[dependency] !== "string") {
    console.error(`Missing runtime dependency: ${dependency}`);
    process.exit(1);
  }
}
if (manifest.bin?.crewcoder !== "./bin/crewcoder.js" || manifest.bin?.cc !== "./bin/crewcoder.js") {
  console.error("The crewcoder and cc bins must point to ./bin/crewcoder.js.");
  process.exit(1);
}

const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, npm_config_loglevel: "silent" }
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status || 1);
}

let report;
try {
  const parsed = JSON.parse(result.stdout);
  report = Array.isArray(parsed) ? parsed[0] : parsed;
} catch {
  console.error("npm pack did not return valid JSON.");
  process.stderr.write(result.stdout);
  process.exit(1);
}

const files = Array.isArray(report?.files) ? report.files.map((entry) => entry.path) : [];
const required = ["LICENSE", "README.md", "bin/crewcoder.js", "lib/launcher.js", "package.json"];
const missing = required.filter((file) => !files.includes(file));
if (missing.length) {
  console.error(`Missing package files: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`${report.name}@${report.version} package dry-run passed (${files.length} files, ${report.size} bytes).`);
