import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { ensureCrewCoderHome } from "./crewcoder-home.js";

const FLEET_TOKEN_FILE = "fleet-token";
const FLEET_TOKEN_BYTES = 32;
export const FLEET_WEBSOCKET_PROTOCOL = "crewcoder.v1";
export const FLEET_WEBSOCKET_AUTH_PREFIX = "crewcoder.auth.";

export function getFleetTokenPath(): string {
  return path.join(ensureCrewCoderHome().root, FLEET_TOKEN_FILE);
}

export function getOrCreateFleetToken(): string {
  const tokenPath = getFleetTokenPath();
  const existing = readFleetTokenFile(tokenPath);
  if (existing) return existing;

  const token = generateFleetToken();
  try {
    const fd = fs.openSync(tokenPath, "wx", 0o600);
    try { fs.writeFileSync(fd, `${token}\n`, "utf8"); }
    finally { fs.closeSync(fd); }
    enforcePrivateMode(tokenPath);
    return token;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const raced = readFleetTokenFile(tokenPath);
    if (!raced) throw new Error(`Fleet token file is empty or invalid: ${tokenPath}`);
    return raced;
  }
}

export function rotateFleetToken(): string {
  const tokenPath = getFleetTokenPath();
  const token = generateFleetToken();
  const temporaryPath = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  enforcePrivateMode(temporaryPath);
  fs.renameSync(temporaryPath, tokenPath);
  enforcePrivateMode(tokenPath);
  return token;
}

export function readFleetToken(): string | undefined {
  return readFleetTokenFile(getFleetTokenPath());
}

export function isFleetRequestAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const headerToken = bearerToken(req.headers.authorization);
  return headerToken !== undefined && fleetTokensEqual(expectedToken, headerToken);
}

export function isFleetWebSocketAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  if (isFleetRequestAuthorized(req, expectedToken)) return true;
  const protocolToken = websocketProtocolToken(req.headers["sec-websocket-protocol"]);
  return protocolToken !== undefined && fleetTokensEqual(expectedToken, protocolToken);
}

export function requestedFleetWebSocketProtocol(req: IncomingMessage): boolean {
  return headerValues(req.headers["sec-websocket-protocol"]).includes(FLEET_WEBSOCKET_PROTOCOL);
}

export function fleetWebSocketProtocols(token: string): string[] {
  validateFleetToken(token);
  return [FLEET_WEBSOCKET_PROTOCOL, `${FLEET_WEBSOCKET_AUTH_PREFIX}${token}`];
}

export function validateFleetToken(token: string): string {
  const normalized = token.trim();
  if (normalized.length < 32 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error("Fleet token must be at least 32 URL-safe characters.");
  }
  return normalized;
}

function generateFleetToken(): string {
  return crypto.randomBytes(FLEET_TOKEN_BYTES).toString("base64url");
}

function readFleetTokenFile(tokenPath: string): string | undefined {
  if (!fs.existsSync(tokenPath)) return undefined;
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token) return undefined;
  enforcePrivateMode(tokenPath);
  return validateFleetToken(token);
}

function enforcePrivateMode(tokenPath: string): void {
  try { fs.chmodSync(tokenPath, 0o600); } catch {}
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value.trim());
  return match?.[1];
}

function websocketProtocolToken(value: string | string[] | undefined): string | undefined {
  const credential = headerValues(value).find((item) => item.startsWith(FLEET_WEBSOCKET_AUTH_PREFIX));
  return credential?.slice(FLEET_WEBSOCKET_AUTH_PREFIX.length);
}

function headerValues(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value ?? "";
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function fleetTokensEqual(expected: string, candidate: string): boolean {
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  const candidateHash = crypto.createHash("sha256").update(candidate).digest();
  return crypto.timingSafeEqual(expectedHash, candidateHash);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
