import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { startEgressProxy } from "../core/network-proxy.js";
import { prepareSandboxNetwork, type SandboxPolicy } from "../core/sandbox.js";

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    resolve(typeof addr === "object" && addr ? addr.port : 0);
  }));
}

function getThroughProxy(proxyPort: number, absoluteUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: absoluteUrl, headers: { host: new URL(absoluteUrl).host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function policy(allowedHosts: string[]): SandboxPolicy {
  return { enabled: true, workspaceDir: process.cwd(), network: { mode: allowedHosts.length ? "open" : "none", allowedHosts } };
}

describe("egress filtering proxy", () => {
  it("forwards HTTP to allowed hosts and blocks the rest", async () => {
    const target = http.createServer((_req, res) => res.end("upstream-ok"));
    const targetPort = await listen(target);
    const allowProxy = await startEgressProxy(["127.0.0.1"]);
    const denyProxy = await startEgressProxy(["example.com"]);
    try {
      const allowed = await getThroughProxy(allowProxy.port, `http://127.0.0.1:${targetPort}/`);
      expect(allowed.status).toBe(200);
      expect(allowed.body).toBe("upstream-ok");

      const denied = await getThroughProxy(denyProxy.port, `http://127.0.0.1:${targetPort}/`);
      expect(denied.status).toBe(403);
      expect(denyProxy.deniedHosts()).toContain("127.0.0.1");
    } finally {
      await allowProxy.close();
      await denyProxy.close();
      await new Promise<void>((r) => target.close(() => r()));
    }
  });

  it("tunnels CONNECT to allowed hosts", async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const proxy = await startEgressProxy(["127.0.0.1"]);
    try {
      const tunneled = await new Promise<string>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: proxy.port, method: "CONNECT", path: `127.0.0.1:${echoPort}` });
        req.on("connect", (_res, socket) => {
          socket.write("ping");
          socket.on("data", (chunk) => {
            resolve(chunk.toString());
            socket.destroy();
          });
        });
        req.on("error", reject);
        req.end();
      });
      expect(tunneled).toBe("ping");
    } finally {
      await proxy.close();
      await new Promise<void>((r) => echo.close(() => r()));
    }
  });

  it("rejects CONNECT to disallowed hosts", async () => {
    const proxy = await startEgressProxy(["example.com"]);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: proxy.port, method: "CONNECT", path: "blocked.internal:443" });
        req.on("connect", (res, socket) => { resolve(res.statusCode ?? 0); socket.destroy(); });
        req.on("response", (res) => resolve(res.statusCode ?? 0));
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(403);
      expect(proxy.deniedHosts()).toContain("blocked.internal");
    } finally {
      await proxy.close();
    }
  });
});

describe("prepareSandboxNetwork", () => {
  it("is a no-op with an empty allowlist", async () => {
    const setup = await prepareSandboxNetwork(policy([]), "bubblewrap");
    expect(setup.env).toEqual({});
    await setup.dispose();
  });

  it("starts a proxy and injects proxy env for an allowlist under bubblewrap", async () => {
    const setup = await prepareSandboxNetwork(policy(["api.example.com"]), "bubblewrap");
    try {
      expect(setup.proxy).toBeDefined();
      expect(setup.env.HTTP_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(setup.env.HTTPS_PROXY).toBe(setup.env.HTTP_PROXY);
      expect(setup.env.NO_PROXY).toContain("127.0.0.1");
    } finally {
      await setup.dispose();
    }
  });

  it("fails closed for per-host allowlists under docker", async () => {
    await expect(prepareSandboxNetwork(policy(["api.example.com"]), "docker")).rejects.toThrow(/docker/i);
  });
});
