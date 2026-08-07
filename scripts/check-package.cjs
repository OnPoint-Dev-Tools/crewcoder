#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const packageDirectory = path.resolve(process.argv[2] || "");
if (!process.argv[2]) {
  console.error("Usage: node scripts/check-package.cjs <package-directory>");
  process.exit(1);
}

const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: packageDirectory,
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
const required = ["LICENSE", "README.md", "package.json", "dist/index.js", "dist/index.d.ts"];
const forbidden = files.filter((file) => file.startsWith("src/") || file.includes("/tests/") || file === ".env" || file.startsWith(".env."));
const missing = required.filter((file) => !files.includes(file));
if (missing.length || forbidden.length) {
  if (missing.length) console.error(`Missing package files: ${missing.join(", ")}`);
  if (forbidden.length) console.error(`Forbidden package files: ${forbidden.join(", ")}`);
  process.exit(1);
}

console.log(`${report.name}@${report.version} package dry-run passed (${files.length} files, ${report.size} bytes).`);
