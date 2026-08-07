// Filtering forward proxy for sandboxed network egress (Feature 2, enforced).
//
// When a sandboxed command declares a non-empty host allowlist we start a small
// HTTP/HTTPS forward proxy bound to loopback and hand the child process
// HTTP(S)_PROXY env vars pointing at it. The proxy permits connections only to
// allowlisted hosts (exact / *.wildcard / *) and rejects everything else.
//
// Enforcement scope: this constrains proxy-respecting clients (curl, wget, npm,
// git, Node fetch/undici, most SDKs). It is not a kernel-level firewall — a
// process that opens raw sockets and ignores the proxy env can still reach the
// network when the net namespace is shared. Full containment needs slirp/veth
// routing (a later backend). For now this is the honest, testable middle ground:
// real filtering for cooperating clients, documented limits for hostile binaries.

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { isHostAllowed } from "./network-policy.js";

export type NetworkProxy = {
  host: string;
  port: number;
  url: string;
  allowedHosts: string[];
  /** Hosts that were rejected during this proxy's lifetime (observability). */
  deniedHosts: () => string[];
  close: () => Promise<void>;
};

function splitHostPort(target: string, fallbackPort: number): { host: string; port: number } {
  const trimmed = target.trim();
  // IPv6 literal form [::1]:443
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : fallbackPort;
    return { host, port: Number.isFinite(port) ? port : fallbackPort };
  }
  const idx = trimmed.lastIndexOf(":");
  if (idx === -1) return { host: trimmed, port: fallbackPort };
  const host = trimmed.slice(0, idx);
  const port = Number(trimmed.slice(idx + 1));
  return { host, port: Number.isFinite(port) ? port : fallbackPort };
}

export function startEgressProxy(allowedHosts: string[], host = "127.0.0.1"): Promise<NetworkProxy> {
  const denied = new Set<string>();
  const sockets = new Set<Duplex>();

  const server = http.createServer((req, res) => {
    let targetHost = "";
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? "");
      targetHost = url.hostname;
    } catch {
      res.writeHead(400).end("Bad proxied request");
      return;
    }
    if (!isHostAllowed(targetHost, allowedHosts)) {
      denied.add(targetHost);
      res.writeHead(403, { "content-type": "text/plain" }).end(`Egress to ${targetHost} denied by sandbox allowlist`);
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    const proxyReq = http.request({ host: targetHost, port, method: req.method, path: `${url.pathname}${url.search}`, headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Upstream error"); });
    req.pipe(proxyReq);
  });

  // HTTPS (and any TLS) tunneling via CONNECT.
  server.on("connect", (req, clientSocket, head) => {
    const { host: targetHost, port } = splitHostPort(req.url ?? "", 443);
    if (!isHostAllowed(targetHost, allowedHosts)) {
      denied.add(targetHost);
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, targetHost, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    sockets.add(clientSocket);
    const cleanup = () => { upstream.destroy(); clientSocket.destroy(); sockets.delete(upstream); sockets.delete(clientSocket); };
    upstream.on("error", cleanup);
    clientSocket.on("error", cleanup);
    upstream.on("close", cleanup);
    clientSocket.on("close", cleanup);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind egress proxy"));
        return;
      }
      resolve({
        host,
        port: address.port,
        url: `http://${host}:${address.port}`,
        allowedHosts,
        deniedHosts: () => [...denied].sort(),
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          server.close(() => done());
        })
      });
    });
  });
}
