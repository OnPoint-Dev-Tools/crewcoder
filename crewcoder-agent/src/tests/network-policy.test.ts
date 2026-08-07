import { describe, expect, it } from "vitest";
import { hostFromUrl, hostMatchesPattern, isHostAllowed, normalizeAllowedHosts } from "../core/network-policy.js";

describe("network policy host matching", () => {
  it("extracts hostnames from urls and bare hosts", () => {
    expect(hostFromUrl("https://api.example.com/v1")).toBe("api.example.com");
    expect(hostFromUrl("api.example.com")).toBe("api.example.com");
    expect(hostFromUrl("HTTP://Example.COM")).toBe("example.com");
    expect(hostFromUrl("   ")).toBeUndefined();
  });

  it("matches exact, wildcard, and apex hosts", () => {
    expect(hostMatchesPattern("api.example.com", "api.example.com")).toBe(true);
    expect(hostMatchesPattern("api.example.com", "*.example.com")).toBe(true);
    expect(hostMatchesPattern("example.com", "*.example.com")).toBe(true);
    expect(hostMatchesPattern("evil.com", "*.example.com")).toBe(false);
    expect(hostMatchesPattern("anything.io", "*")).toBe(true);
  });

  it("denies by default with an empty allowlist", () => {
    expect(isHostAllowed("api.example.com", [])).toBe(false);
    expect(isHostAllowed("api.example.com", ["*.example.com"])).toBe(true);
    expect(isHostAllowed("api.other.com", ["*.example.com"])).toBe(false);
  });

  it("normalizes allowlists (trim, lowercase, dedupe, sort)", () => {
    expect(normalizeAllowedHosts([" API.Example.com ", "api.example.com", "", 5, "b.com"])).toEqual(["api.example.com", "b.com"]);
    expect(normalizeAllowedHosts(undefined)).toEqual([]);
  });
});
