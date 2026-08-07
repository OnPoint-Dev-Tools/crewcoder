import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractScripts, isFrameworkMountFailure, missingBrowserApi, runPluginTest, type PluginTestReport } from "../core/plugin-test-runner.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-plugin-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true });
});

/** Minimal plugin that speaks the real crewcode postMessage protocol. */
const PROTOCOL_PRELUDE = `
const pending = new Map(); let seq = 0;
function request(method, params) {
  const id = 'req-' + (++seq);
  window.parent.postMessage({ type: 'crewcode:request', id, method, params }, '*');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'crewcode:response' && pending.has(msg.id)) {
    const cb = pending.get(msg.id); pending.delete(msg.id);
    if (msg.ok) cb.resolve(msg.result); else cb.reject(new Error(msg.error));
  }
});
`;

function writePlugin(input: { permissions?: string[]; script: string; html?: string; manifestExtra?: Record<string, unknown> }): void {
  fs.writeFileSync(path.join(dir, "crewcode.plugin.json"), JSON.stringify({
    id: "fixture-plugin",
    name: "Fixture Plugin",
    version: "0.1.0",
    crewcode: { apiVersion: "0.1" },
    permissions: input.permissions ?? [],
    contributes: { tabs: [{ id: "main", title: "Fixture", entry: "panel.html" }] },
    ...(input.manifestExtra ?? {})
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "panel.html"), input.html ?? `<!doctype html><html><body><button id="go">go</button><script src="plugin.js"></script></body></html>`, "utf8");
  fs.writeFileSync(path.join(dir, "plugin.js"), PROTOCOL_PRELUDE + input.script, "utf8");
}

function run(): Promise<PluginTestReport> {
  return runPluginTest({ pluginDir: dir, workspaceRoot: dir, timeoutMs: 8000 });
}

function findingCodes(report: PluginTestReport): string[] {
  return report.entries.flatMap((entry) => entry.findings.map((finding) => finding.code));
}

describe("plugin test runner", () => {
  it("loads a plugin, delivers context, and reports a clean pass", async () => {
    writePlugin({
      permissions: ["workspace:read"],
      script: `
        window.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'crewcode:context') {
            document.getElementById('go').textContent = 'ctx:' + event.data.pluginId;
          }
        });
        document.getElementById('go').addEventListener('click', () => { request('workspace:listFiles').catch(() => {}); });
      `
    });

    const report = await run();

    expect(report.ok).toBe(true);
    expect(report.pluginId).toBe("fixture-plugin");
    expect(report.entries[0]?.loaded).toBe(true);
    expect(report.entries[0]?.calls.map((call) => call.method)).toContain("workspace:listFiles");
    expect(report.entries[0]?.calls.every((call) => call.ok)).toBe(true);
  }, 20_000);

  it("catches a runtime permission mismatch that static validation cannot see", async () => {
    // The manifest is statically valid; only running it reveals the write call.
    writePlugin({
      permissions: ["workspace:read"],
      script: `document.getElementById('go').addEventListener('click', () => { request('workspace:writeFile', { sub: 'out.txt', text: 'x' }).catch(() => {}); });`
    });

    const report = await run();

    expect(report.ok).toBe(false);
    expect(findingCodes(report)).toContain("missing-permission");
    const call = report.entries[0]?.calls.find((entry) => entry.method === "workspace:writeFile");
    expect(call).toMatchObject({ ok: false, missingPermission: "workspace:write" });
    expect(fs.existsSync(path.join(dir, "out.txt"))).toBe(false);
  }, 20_000);

  it("flags a reserved v0 method as always-failing rather than as a permission problem", async () => {
    writePlugin({
      permissions: ["network:fetch"],
      script: `document.getElementById('go').addEventListener('click', () => { request('network:fetch', { input: 'https://example.com' }).catch(() => {}); });`
    });

    const report = await run();

    expect(findingCodes(report)).toContain("reserved-method");
    expect(findingCodes(report)).not.toContain("missing-permission");
  }, 20_000);

  it("flags a method outside the v0 surface", async () => {
    writePlugin({
      permissions: ["workspace:read"],
      script: `document.getElementById('go').addEventListener('click', () => { request('totally:madeup').catch(() => {}); });`
    });

    const report = await run();

    expect(report.ok).toBe(false);
    expect(findingCodes(report)).toContain("unsupported-method");
  }, 20_000);

  it("reports a genuine load-time throw as an error", async () => {
    writePlugin({ permissions: [], script: `throw new Error('plugin blew up on load');` });

    const report = await run();

    expect(report.ok).toBe(false);
    expect(report.entries[0]?.runtimeErrors[0]?.message).toContain("plugin blew up on load");
    expect(findingCodes(report)).toContain("runtime-error");
  }, 20_000);

  it("does not copy or write outside the workspace when a plugin tries to escape", async () => {
    writePlugin({
      permissions: ["workspace:write"],
      script: `document.getElementById('go').addEventListener('click', () => { request('workspace:writeFile', { sub: '../escaped.txt', text: 'x' }).catch(() => {}); });`
    });

    const report = await run();

    expect(report.entries[0]?.calls[0]).toMatchObject({ ok: false, error: "path escapes workspace" });
    expect(fs.existsSync(path.join(path.dirname(dir), "escaped.txt"))).toBe(false);
  }, 20_000);

  it("only clicks controls that actually bound a handler", async () => {
    writePlugin({
      permissions: [],
      html: `<!doctype html><html><body><span id="label">x</span><button id="go">go</button><script src="plugin.js"></script></body></html>`,
      script: `
        document.getElementById('label').textContent = 'display only';
        document.getElementById('go').addEventListener('click', () => {});
      `
    });

    const report = await run();

    // 'label' is a display node; clicking it would produce a bogus dead-control finding.
    expect(report.entries[0]?.interactions.map((interaction) => interaction.target)).toEqual(["go"]);
    expect(report.entries[0]?.interactions.every((interaction) => interaction.dispatched)).toBe(true);
  }, 20_000);

  it("reports a plugin with no UI entries instead of failing", async () => {
    fs.writeFileSync(path.join(dir, "crewcode.plugin.json"), JSON.stringify({
      id: "headless", name: "Headless", version: "0.1.0", crewcode: { apiVersion: "0.1" },
      permissions: ["mcp:server"], contributes: { mcpServers: [{ id: "x", command: "node" }] }
    }), "utf8");

    const report = await run();

    expect(report.ok).toBe(true);
    expect(report.findings.map((finding) => finding.code)).toContain("no-ui-entries");
  }, 20_000);

  it("always states its limitations so a pass is never read as full coverage", async () => {
    writePlugin({ permissions: [], script: `` });
    const report = await run();
    expect(report.limitations.length).toBeGreaterThan(0);
    expect(report.limitations.join(" ")).toContain("not a browser");
  }, 20_000);

  it("rejects a manifest that is missing or malformed", async () => {
    await expect(runPluginTest({ pluginDir: dir })).rejects.toThrow(/Missing crewcode.plugin.json/);
    fs.writeFileSync(path.join(dir, "crewcode.plugin.json"), "{ not json", "utf8");
    await expect(runPluginTest({ pluginDir: dir })).rejects.toThrow(/not valid JSON/);
  });
});

describe("extractScripts", () => {
  it("collects inline and local scripts in document order and skips remote ones", () => {
    fs.writeFileSync(path.join(dir, "a.js"), "var a = 1;", "utf8");
    fs.writeFileSync(path.join(dir, "panel.html"), [
      "<html><body>",
      `<script src="https://cdn.example.com/x.js"></script>`,
      `<script src="a.js"></script>`,
      `<script>var inline = 2;</script>`,
      "</body></html>"
    ].join("\n"), "utf8");

    const scripts = extractScripts(path.join(dir, "panel.html"), dir);

    expect(scripts.map((script) => script.name)).toEqual(["a.js", "panel.html#inline-2"]);
    expect(scripts[1]?.code).toContain("var inline = 2;");
  });

  it("refuses a script src that escapes the plugin folder", () => {
    fs.writeFileSync(path.join(dir, "panel.html"), `<script src="../../outside.js"></script>`, "utf8");
    expect(() => extractScripts(path.join(dir, "panel.html"), dir)).toThrow(/escapes the plugin folder/);
  });

  it("reports a missing local script instead of silently skipping it", () => {
    fs.writeFileSync(path.join(dir, "panel.html"), `<script src="gone.js"></script>`, "utf8");
    expect(() => extractScripts(path.join(dir, "panel.html"), dir)).toThrow(/does not exist/);
  });
});

describe("harness-limitation classification", () => {
  it("recognizes unstubbed browser APIs so healthy plugins are not failed", () => {
    expect(missingBrowserApi("ReferenceError: MutationObserver is not defined")).toBe("MutationObserver");
    expect(missingBrowserApi("TypeError: Cannot read properties of undefined (reading 'clipboard')")).toBe("clipboard");
  });

  it("does not launder a real plugin bug into a limitation", () => {
    expect(missingBrowserApi("ReferenceError: myTypoedHelper is not defined")).toBeUndefined();
    expect(missingBrowserApi("TypeError: Cannot read properties of undefined (reading 'userTodos')")).toBeUndefined();
  });

  it("recognizes a framework refusing to mount into the stub DOM", () => {
    expect(isFrameworkMountFailure("Minified React error #299; visit https://reactjs.org/...")).toBe(true);
    expect(isFrameworkMountFailure("Target container is not a DOM element")).toBe(true);
    expect(isFrameworkMountFailure("TypeError: user.name is undefined")).toBe(false);
  });
});
