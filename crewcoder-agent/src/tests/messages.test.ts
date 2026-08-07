import { describe, expect, it } from "vitest";
import { getText, imagePartFromPath, renderMessagesForModel, textMessage, withImageParts, type UserMessage } from "../core/messages.js";

describe("imagePartFromPath", () => {
  it("infers mime from the file extension", () => {
    expect(imagePartFromPath("/tmp/a.png")).toEqual({ type: "image", mime: "image/png", path: "/tmp/a.png" });
    expect(imagePartFromPath("/tmp/b.JPEG").mime).toBe("image/jpeg");
    expect(imagePartFromPath("/tmp/c.unknown").mime).toBe("image/png");
  });
});

describe("withImageParts", () => {
  it("appends image parts while keeping the text part", () => {
    const message = withImageParts(textMessage("user", "hello"), ["/tmp/a.png"]);
    expect(getText(message)).toBe("hello");
    expect(message.content.filter((part) => part.type === "image")).toHaveLength(1);
  });

  it("returns the message unchanged when there are no images", () => {
    const base = textMessage("user", "hello");
    expect(withImageParts(base, [])).toBe(base);
  });
});

describe("renderMessagesForModel", () => {
  it("preserves image parts when merging background context", () => {
    const message: UserMessage = {
      ...withImageParts(textMessage("user", "look"), ["/tmp/a.png"]),
      background: ["repo=crewcoder"]
    };

    const [rendered] = renderMessagesForModel([message]) as UserMessage[];
    expect(rendered.content.some((part) => part.type === "image" && part.path === "/tmp/a.png")).toBe(true);
    expect(getText(rendered)).toContain("Background:");
    expect(getText(rendered)).toContain("repo=crewcoder");
  });
});
