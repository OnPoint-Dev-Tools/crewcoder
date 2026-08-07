import { describe, expect, it } from "vitest";
import { redactSecrets } from "../core/secret-redaction.js";

describe("secret redaction", () => {
  it("redacts sensitive keys, env lines, AWS credentials, bearer tokens, and private keys", () => {
    const redacted = redactSecrets({
      apiKey: "sk-live-secret",
      nested: {
        text: [
          "SAFE=value",
          "OPENAI_API_KEY=sk-test-value",
          "AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF",
          "authorization: Bearer abcdefghijklmnopqrstuvwxyz",
          "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
        ].join("\n")
      },
      file: { path: ".env.local", content: "PASSWORD=hunter2" }
    });

    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.file.content).toBe("[REDACTED]");
    expect(redacted.nested.text).toContain("SAFE=value");
    expect(redacted.nested.text).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redacted.nested.text).not.toContain("sk-test-value");
    expect(redacted.nested.text).not.toContain("AKIA1234567890ABCDEF");
    expect(redacted.nested.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(redacted.nested.text).not.toContain("BEGIN PRIVATE KEY");
  });
});
