import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CrewCoderProcessBridge, resolveCrewCoderInvocation } from "../bridge/crewcoder-process.js";
import {
  buildRemoteCrewCoderCommand,
  readCrewCoderRemoteConnection,
  validateCrewCoderRemoteConnection
} from "../bridge/remote-connection.js";
import type { CrewCoderJsonEvent } from "../bridge/event-parser.js";

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of ["CREWCODER_REMOTE", "CREWCODER_REMOTE_CWD", "CREWCODER_REMOTE_BIN", "CREWCODER_BIN", "CREWCODER_TASKS_ENABLED", "PATH", "SSH_ARGS_FILE"]) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("remote CrewCoder connection", () => {
  it("loads defaults and rejects SSH option injection", () => {
    const connection = readCrewCoderRemoteConnection({ CREWCODER_REMOTE: "dev@example.com" });
    expect(connection).toEqual({
      target: "dev@example.com",
      cwd: "~",
      binary: "~/crewcoder-runner/crewcoder"
    });
    expect(() => validateCrewCoderRemoteConnection({ target: "-oProxyCommand=bad", cwd: "~", binary: "crewcoder" })).toThrow("without whitespace or leading options");
    expect(() => validateCrewCoderRemoteConnection({ target: "dev@example.com\nmalicious", cwd: "~", binary: "crewcoder" })).toThrow();
  });

  it("quotes remote paths and arguments as data", () => {
    const command = buildRemoteCrewCoderCommand(
      { target: "dev@example.com", cwd: "~/work tree", binary: "~/runner/crewcoder" },
      ["run", "it's safe", "$(touch /tmp/must-not-run)"]
    );
    expect(command).toContain('cd "$HOME"/\'work tree\'');
    expect(command).toContain('exec "$HOME"/\'runner/crewcoder\'');
    expect(command).toContain("'it'\"'\"'s safe'");
    expect(command).toContain("'$(touch /tmp/must-not-run)'");
  });

  it("forwards only a normalized instance-local task override", () => {
    process.env.CREWCODER_TASKS_ENABLED = "on";
    expect(buildRemoteCrewCoderCommand({ target: "host", cwd: "/workspace", binary: "crewcoder" }, ["task", "status"]))
      .toContain("CREWCODER_TASKS_ENABLED=true");
    process.env.CREWCODER_TASKS_ENABLED = "not-a-boolean";
    expect(buildRemoteCrewCoderCommand({ target: "host", cwd: "/workspace", binary: "crewcoder" }, ["task", "status"]))
      .not.toContain("CREWCODER_TASKS_ENABLED");
  });

  it("builds SSH invocations without changing local mode", () => {
    process.env.CREWCODER_REMOTE = "dev@example.com";
    process.env.CREWCODER_REMOTE_CWD = "/srv/project";
    process.env.CREWCODER_REMOTE_BIN = "/opt/crewcoder";

    const remote = resolveCrewCoderInvocation(["providers", "--json"], "/local/project");
    expect(remote.command).toBe("ssh");
    expect(remote.args.slice(0, 2)).toEqual(["-T", "dev@example.com"]);
    expect(remote.args[2]).toContain("cd '/srv/project' && exec '/opt/crewcoder' 'providers' '--json'");

    delete process.env.CREWCODER_REMOTE;
    delete process.env.CREWCODER_REMOTE_CWD;
    delete process.env.CREWCODER_REMOTE_BIN;
    process.env.CREWCODER_BIN = "/opt/local-crewcoder";
    expect(resolveCrewCoderInvocation(["providers"], "/local/project")).toEqual({
      command: "/opt/local-crewcoder",
      args: ["providers"],
      cwd: "/local/project"
    });
  });

  it("streams events and controls through an SSH subprocess", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-tui-remote-"));
    const sshArgsFile = path.join(root, "ssh-args.txt");
    const remoteBinary = path.join(root, "remote-crewcoder");
    const sshBinary = path.join(root, "ssh");
    fs.writeFileSync(remoteBinary, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"agent_start\",\"sessionId\":\"remote_session\"}'",
      "IFS= read -r control",
      "printf '%s\\n' '{\"type\":\"assistant_delta\",\"text\":\"remote control received\"}'"
    ].join("\n"), { mode: 0o700 });
    fs.writeFileSync(sshBinary, [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" > \"$SSH_ARGS_FILE\"",
      "shift",
      "shift",
      "exec /bin/sh -c \"$1\""
    ].join("\n"), { mode: 0o700 });
    process.env.PATH = `${root}:${originalEnv.PATH ?? ""}`;
    process.env.SSH_ARGS_FILE = sshArgsFile;
    process.env.CREWCODER_REMOTE = "dev@example.com";
    process.env.CREWCODER_REMOTE_CWD = root;
    process.env.CREWCODER_REMOTE_BIN = remoteBinary;

    const bridge = new CrewCoderProcessBridge();
    const events: CrewCoderJsonEvent[] = [];
    const completed = new Promise<void>((resolve) => {
      bridge.run({ prompt: "hello", provider: "codex", mode: "general" }, (event) => {
        events.push(event);
        if (event.type === "agent_start") bridge.followUp("continue remotely");
        if (event.type === "process_exit") resolve();
      });
    });
    await completed;

    expect(events.some((event) => event.type === "assistant_delta" && event.text === "remote control received")).toBe(true);
    expect(fs.readFileSync(sshArgsFile, "utf8").split("\n").slice(0, 2)).toEqual(["-T", "dev@example.com"]);
  });

  it("rejects local image paths before opening SSH", () => {
    process.env.CREWCODER_REMOTE = "dev@example.com";
    const events: CrewCoderJsonEvent[] = [];
    const bridge = new CrewCoderProcessBridge();
    bridge.run({ prompt: "image", provider: "codex", mode: "general", images: ["/tmp/local.png"] }, (event) => events.push(event));
    expect(events).toEqual([expect.objectContaining({ type: "process_error", message: expect.stringContaining("not available") })]);
    expect(bridge.running).toBe(false);
  });
});
