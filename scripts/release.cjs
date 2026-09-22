#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const releaseFiles = [
  "package.json",
  "crewcoder-agent/package.json",
  "crewcoder-client/package.json",
  "crewcoder-sdk/package.json",
  "crewcoder-agent/src/core/version.ts",
  "crewcoder-client/src/version.ts",
  "crewcoder-client/api/version.d.ts",
  "crewcoder-sdk/src/version.ts",
  "crewcoder-sdk/api/version.d.ts",
  "package-lock.json"
];
const releasePackageFiles = [
  "package.json",
  "crewcoder-agent/package.json",
  "crewcoder-client/package.json",
  "crewcoder-sdk/package.json"
];

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout || "").trim() : "";
    fail(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function stableVersionParts(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) fail(`Invalid version "${version}". Use a stable semantic version such as 0.2.3 (without a leading v).`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const leftParts = stableVersionParts(left);
  const rightParts = stableVersionParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function writeJson(filePath, value, original) {
  const indentation = original.match(/\n([ \t]+)"/)?.[1] || "  ";
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, indentation)}\n`);
}

function replaceVersionConstant(filePath, constantName, version) {
  const source = fs.readFileSync(filePath, "utf8");
  const pattern = new RegExp(`(export const ${constantName} = ")[^"]+(" as const;)`);
  if (!pattern.test(source)) fail(`Could not find ${constantName} in ${path.relative(root, filePath)}.`);
  fs.writeFileSync(filePath, source.replace(pattern, `$1${version}$2`));
}

function updateReleaseMetadata(repositoryRoot, version, codexVersion) {
  stableVersionParts(codexVersion);
  const manifests = new Map();
  for (const relativePath of releasePackageFiles) {
    const filePath = path.join(repositoryRoot, relativePath);
    const original = fs.readFileSync(filePath, "utf8");
    const manifest = JSON.parse(original);
    manifest.version = version;
    manifests.set(relativePath, { filePath, manifest, original });
  }

  manifests.get("package.json").manifest.dependencies["@onpoint-dev-tools/crewcoder-agent"] = version;
  manifests.get("crewcoder-agent/package.json").manifest.dependencies["@openai/codex"] = codexVersion;
  manifests.get("crewcoder-sdk/package.json").manifest.dependencies["@onpoint-dev-tools/crewcoder-agent"] = version;
  manifests.get("crewcoder-sdk/package.json").manifest.dependencies["@onpoint-dev-tools/crewcoder-client"] = version;

  for (const { filePath, manifest, original } of manifests.values()) writeJson(filePath, manifest, original);
  replaceVersionConstant(path.join(repositoryRoot, "crewcoder-agent/src/core/version.ts"), "CREWCODER_VERSION", version);
  replaceVersionConstant(path.join(repositoryRoot, "crewcoder-client/src/version.ts"), "CREWCODER_CLIENT_VERSION", version);
  replaceVersionConstant(path.join(repositoryRoot, "crewcoder-sdk/src/version.ts"), "CREWCODER_SDK_VERSION", version);
}

function resolveLatestCodexVersion() {
  const version = run("npm", ["view", "@openai/codex", "dist-tags.latest"], { capture: true });
  stableVersionParts(version);
  return version;
}

function resolveRemote(branch) {
  const configured = spawnSync("git", ["config", "--get", `branch.${branch}.remote`], { cwd: root, encoding: "utf8" });
  const remote = configured.status === 0 ? configured.stdout.trim() : "origin";
  if (!remote || remote === ".") fail(`Branch ${branch} does not have a pushable Git remote.`);
  run("git", ["remote", "get-url", remote], { capture: true });
  return remote;
}

function main(args) {
  const dryRun = args.includes("--dry-run");
  const positional = args.filter((argument) => argument !== "--dry-run");
  if (positional.length !== 1) {
    fail("Usage: npm run release -- <version> [--dry-run]");
  }

  const version = positional[0];
  stableVersionParts(version);
  if (run("git", ["rev-parse", "--show-toplevel"], { capture: true }) !== root) {
    fail(`Release script must run from the CrewCoder repository at ${root}.`);
  }
  if (run("git", ["status", "--porcelain", "--untracked-files=all"], { capture: true })) {
    fail("The worktree must be completely clean so release checks match the tagged commit.");
  }
  const codexVersion = resolveLatestCodexVersion();

  const branch = run("git", ["branch", "--show-current"], { capture: true });
  if (!branch) fail("Releases cannot be created from a detached HEAD.");
  const remote = resolveRemote(branch);
  const tag = `v${version}`;
  const localTag = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { cwd: root });
  if (localTag.status === 0) fail(`Tag ${tag} already exists locally.`);
  if (localTag.status !== 1) fail(`Could not check whether tag ${tag} exists locally.`);

  const currentVersions = releasePackageFiles.map((relativePath) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
    stableVersionParts(manifest.version);
    return `${manifest.name}@${manifest.version}`;
  });
  for (const packageVersion of currentVersions) {
    const currentVersion = packageVersion.slice(packageVersion.lastIndexOf("@") + 1);
    if (compareVersions(version, currentVersion) <= 0) {
      fail(`Target ${version} must be newer than every package; ${packageVersion} is not older.`);
    }
  }

  console.log(`Preparing ${tag} from ${branch} for ${remote}.`);
  console.log(`Packages: ${currentVersions.join(", ")} -> ${version}`);
  console.log(`Codex runtime: @openai/codex@${codexVersion}`);
  if (dryRun) {
    console.log("Dry run passed; no files, commits, tags, or Git remotes were changed.");
    return;
  }

  if (run("git", ["ls-remote", "--tags", remote, `refs/tags/${tag}`], { capture: true })) {
    fail(`Tag ${tag} already exists on ${remote}.`);
  }
  run("git", ["fetch", "--quiet", remote, `refs/heads/${branch}`]);
  run("git", ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"], { capture: true });

  updateReleaseMetadata(root, version, codexVersion);
  run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
  run("npm", ["run", "api:update", "-w", "@onpoint-dev-tools/crewcoder-client"]);
  run("npm", ["run", "api:update", "-w", "@onpoint-dev-tools/crewcoder-sdk"]);

  const changedFiles = run("git", ["diff", "--name-only"], { capture: true }).split("\n").filter(Boolean).sort();
  const unexpectedFiles = changedFiles.filter((file) => !releaseFiles.includes(file));
  const missingFiles = releaseFiles.filter((file) => !changedFiles.includes(file));
  if (unexpectedFiles.length || missingFiles.length) {
    const details = [
      unexpectedFiles.length ? `unexpected changes: ${unexpectedFiles.join(", ")}` : "",
      missingFiles.length ? `expected changes missing: ${missingFiles.join(", ")}` : ""
    ].filter(Boolean).join("; ");
    fail(`Release metadata update was incomplete (${details}).`);
  }
  run("git", ["diff", "--check"]);
  run("npm", ["run", "release:check:sdk"]);

  run("git", ["add", "--", ...releaseFiles]);
  const stagedFiles = run("git", ["diff", "--cached", "--name-only"], { capture: true }).split("\n").filter(Boolean).sort();
  if (stagedFiles.join("\n") !== [...releaseFiles].sort().join("\n")) {
    fail(`Refusing to commit unexpected staged files: ${stagedFiles.join(", ")}`);
  }
  run("git", ["commit", "-m", `chore(release): ${tag}`]);
  if (run("git", ["status", "--porcelain", "--untracked-files=all"], { capture: true })) {
    fail("The release commit was created, but the worktree is no longer clean. No tag was created.");
  }

  run("git", ["tag", "--annotate", tag, "--message", `CrewCoder ${tag}`]);
  console.log(`Pushing ${branch} and ${tag} atomically to ${remote}.`);
  run("git", ["push", "--atomic", remote, `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`]);
  console.log(`Released ${tag}.`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Release failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = { compareVersions, releaseFiles, resolveLatestCodexVersion, stableVersionParts, updateReleaseMetadata };
