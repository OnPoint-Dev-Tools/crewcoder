#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const packageName = process.argv[2];
const manifestPath = process.argv[3];
const attempts = Number(process.argv[4] || 36);
const delaySeconds = Number(process.argv[5] || 10);

if (!packageName || !manifestPath) {
  console.error("Usage: node scripts/wait-for-npm-package.cjs <package-name> <package.json> [attempts] [delaySeconds]");
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8")).version;
if (typeof version !== "string" || !version) {
  console.error(`No version in ${manifestPath}`);
  process.exit(1);
}

const spec = `${packageName}@${version}`;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const result = spawnSync("npm", ["view", spec, "version", "--loglevel", "error"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = (result.stdout || "").trim();
  if (result.status === 0 && output === version) {
    console.log(`${spec} is available on npm.`);
    process.exit(0);
  }
  console.log(`Waiting for npm registry propagation of ${spec} (${attempt}/${attempts})…`);
  spawnSync("sleep", [String(delaySeconds)], { stdio: "ignore" });
}

console.error(`${spec} was not available after ${attempts} attempts.`);
process.exit(1);
