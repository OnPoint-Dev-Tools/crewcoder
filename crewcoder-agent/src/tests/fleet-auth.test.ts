import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fleetWebSocketProtocols,
  getFleetTokenPath,
  getOrCreateFleetToken,
  readFleetToken,
  rotateFleetToken,
  validateFleetToken
} from "../core/fleet-auth.js";

const originalHome = process.env.CREWCODER_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalHome;
});

describe("fleet authentication", () => {
  it("creates and reuses a private persistent token", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-fleet-auth-"));
    process.env.CREWCODER_HOME = home;

    const first = getOrCreateFleetToken();
    const second = getOrCreateFleetToken();
    const tokenPath = getFleetTokenPath();

    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFleetToken()).toBe(first);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(tokenPath, "utf8")).toBe(`${first}\n`);
  });

  it("rotates the token atomically and keeps private permissions", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-fleet-auth-"));
    process.env.CREWCODER_HOME = home;
    const original = getOrCreateFleetToken();

    const rotated = rotateFleetToken();

    expect(rotated).not.toBe(original);
    expect(readFleetToken()).toBe(rotated);
    expect(fs.statSync(getFleetTokenPath()).mode & 0o777).toBe(0o600);
  });

  it("builds URL-safe WebSocket subprotocol credentials", () => {
    const token = "test_fleet_token_1234567890_abcdefghijklmno";
    expect(fleetWebSocketProtocols(token)).toEqual([
      "crewcoder.v1",
      `crewcoder.auth.${token}`
    ]);
    expect(() => validateFleetToken("short")).toThrow("at least 32");
  });
});
