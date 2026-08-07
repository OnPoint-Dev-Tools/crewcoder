import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invokePluginCapability, isAlwaysDeniedMethod, isPluginInvokeMethod, isSafePathUnder, METHOD_PERMISSIONS } from "../core/plugin-host-contract.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-plugin-host-"));
  fs.writeFileSync(path.join(root, "a.txt"), "hello", "utf8");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "junk.js"), "noise", "utf8");
});

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true });
});

function invoke(method: string, permissions: string[], params?: Record<string, unknown>) {
  return invokePluginCapability({ method, permissions, workspaceRoot: root, ...(params ? { params } : {}) });
}

describe("permission gating", () => {
  it("denies workspace reads without workspace:read, using the host's exact message", () => {
    expect(invoke("workspace:listFiles", [])).toEqual({ ok: false, error: "plugin capability denied: workspace:listFiles requires workspace:read" });
    expect(invoke("workspace:readFile", [], { sub: "a.txt" })).toEqual({ ok: false, error: "plugin capability denied: workspace:readFile requires workspace:read" });
  });

  it("denies writes without workspace:write even when the plugin can read", () => {
    expect(invoke("workspace:writeFile", ["workspace:read"], { sub: "b.txt", text: "x" })).toEqual({
      ok: false,
      error: "plugin capability denied: workspace:writeFile requires workspace:write"
    });
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);
  });

  it("allows what the manifest declares", () => {
    const listed = invoke("workspace:listFiles", ["workspace:read"]);
    expect(listed.ok).toBe(true);
    expect((listed as { result: { files: string[] } }).result.files).toContain("a.txt");

    expect(invoke("workspace:readFile", ["workspace:read"], { sub: "a.txt" })).toEqual({ ok: true, result: { text: "hello", rel: "a.txt", size: 5 } });
    expect(invoke("workspace:writeFile", ["workspace:write"], { sub: "nested/b.txt", text: "x" })).toEqual({ ok: true, result: { rel: "nested/b.txt" } });
    expect(fs.readFileSync(path.join(root, "nested", "b.txt"), "utf8")).toBe("x");
  });

  it("hides ignored directories from listFiles the way the host does", () => {
    const listed = invoke("workspace:listFiles", ["workspace:read"]);
    expect((listed as { result: { files: string[] } }).result.files.some((file) => file.includes("node_modules"))).toBe(false);
  });
});

describe("always-denied v0 methods", () => {
  it("denies network:fetch and secrets:get even when the manifest declares them", () => {
    // Declaring the permission must not unlock these: v0 denies them outright.
    expect(invoke("network:fetch", ["network:fetch"])).toEqual({
      ok: false,
      error: "plugin capability denied: network:fetch is reserved for future audited host networking; provider runtimes are the v0 network path"
    });
    expect(invoke("secrets:get", ["secrets:read"])).toEqual({
      ok: false,
      error: "plugin capability denied: secrets:get is reserved until first-class plugin secret storage exists"
    });
    expect(isAlwaysDeniedMethod("network:fetch")).toBe(true);
    expect(isAlwaysDeniedMethod("workspace:readFile")).toBe(false);
  });

  it("rejects methods that are not part of the v0 surface", () => {
    expect(invoke("totally:madeup", ["workspace:read"])).toEqual({ ok: false, error: "unsupported plugin method: totally:madeup" });
    expect(isPluginInvokeMethod("totally:madeup")).toBe(false);
  });
});

describe("path containment", () => {
  it("refuses to read or write outside the workspace root", () => {
    expect(invoke("workspace:readFile", ["workspace:read"], { sub: "../../../etc/passwd" })).toEqual({ ok: false, error: "path escapes workspace" });
    expect(invoke("workspace:writeFile", ["workspace:write"], { sub: "../escaped.txt", text: "x" })).toEqual({ ok: false, error: "path escapes workspace" });
    expect(fs.existsSync(path.join(path.dirname(root), "escaped.txt"))).toBe(false);
  });

  it("does not treat a sibling directory with a shared prefix as inside the root", () => {
    expect(isSafePathUnder("/tmp/work", "/tmp/work-other/file")).toBe(false);
    expect(isSafePathUnder("/tmp/work", "/tmp/work/file")).toBe(true);
    expect(isSafePathUnder("/tmp/work", "/tmp/work")).toBe(true);
  });

  it("validates required params before touching the filesystem", () => {
    expect(invoke("workspace:readFile", ["workspace:read"], {})).toEqual({ ok: false, error: "params.sub required" });
    expect(invoke("workspace:writeFile", ["workspace:write"], { sub: "x.txt" })).toEqual({ ok: false, error: "params.text required" });
  });

  it("reports a missing file and a directory distinctly", () => {
    fs.mkdirSync(path.join(root, "adir"));
    expect(invoke("workspace:readFile", ["workspace:read"], { sub: "nope.txt" })).toEqual({ ok: false, error: "file missing" });
    expect(invoke("workspace:readFile", ["workspace:read"], { sub: "adir" })).toEqual({ ok: false, error: "is a directory" });
  });

  it("requires an absolute workspace root", () => {
    expect(invokePluginCapability({ method: "workspace:listFiles", permissions: ["workspace:read"], workspaceRoot: "relative/path" })).toEqual({
      ok: false,
      error: "absolute workspace root required"
    });
  });
});

describe("method permission table", () => {
  it("maps every method, with null meaning always denied", () => {
    expect(METHOD_PERMISSIONS).toEqual({
      "workspace:listFiles": "workspace:read",
      "workspace:readFile": "workspace:read",
      "workspace:writeFile": "workspace:write",
      "network:fetch": null,
      "secrets:get": null
    });
  });
});
