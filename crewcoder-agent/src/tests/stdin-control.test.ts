import { describe, expect, it, vi } from "vitest";
import { attachStdinControlListener } from "../core/stdin-control.js";

describe("attachStdinControlListener", () => {
  it("invokes onCompact for a control:compact line and ignores noise", () => {
    const onCompact = vi.fn();
    const detach = attachStdinControlListener({ onCompact });
    try {
      process.stdin.emit("data", Buffer.from('not json\n'));
      process.stdin.emit("data", Buffer.from('{"type":"other","action":"compact"}\n'));
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"compact"}\n'));
      expect(onCompact).toHaveBeenCalledTimes(1);
    } finally {
      detach();
    }
  });

  it("passes the preview flag through onCompact", () => {
    const onCompact = vi.fn();
    const detach = attachStdinControlListener({ onCompact });
    try {
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"compact","preview":true}\n'));
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"compact"}\n'));
      expect(onCompact).toHaveBeenNthCalledWith(1, { preview: true });
      expect(onCompact).toHaveBeenNthCalledWith(2, { preview: false });
    } finally {
      detach();
    }
  });

  it("invokes onCompactPreviewDecision with an optional edited summary", () => {
    const onCompactPreviewDecision = vi.fn();
    const detach = attachStdinControlListener({ onCompactPreviewDecision });
    try {
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"compact_preview","previewId":"p1","approved":true,"summary":"edited"}\n'));
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"compact_preview","previewId":"p2","approved":false}\n'));
      // Missing approved boolean is ignored.
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"compact_preview","previewId":"p3"}\n'));
      expect(onCompactPreviewDecision).toHaveBeenNthCalledWith(1, { previewId: "p1", approved: true, summary: "edited" });
      expect(onCompactPreviewDecision).toHaveBeenNthCalledWith(2, { previewId: "p2", approved: false, summary: undefined });
      expect(onCompactPreviewDecision).toHaveBeenCalledTimes(2);
    } finally {
      detach();
    }
  });

  it("reassembles control messages split across chunks", () => {
    const onCompact = vi.fn();
    const detach = attachStdinControlListener({ onCompact });
    try {
      process.stdin.emit("data", Buffer.from('{"type":"control",'));
      process.stdin.emit("data", Buffer.from('"action":"compact"}\n'));
      expect(onCompact).toHaveBeenCalledTimes(1);
    } finally {
      detach();
    }
  });

  it("invokes onFollowUp with trimmed messages", () => {
    const onFollowUp = vi.fn();
    const detach = attachStdinControlListener({ onFollowUp });
    try {
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"follow_up","message":"  add tests  "}\n'));
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"follow_up","message":"   "}\n'));
      expect(onFollowUp).toHaveBeenCalledTimes(1);
      expect(onFollowUp).toHaveBeenCalledWith("add tests");
    } finally {
      detach();
    }
  });

  it("invokes onApprovalDecision for approval control messages", () => {
    const onApprovalDecision = vi.fn();
    const detach = attachStdinControlListener({ onApprovalDecision });
    try {
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"approval","approvalId":" approval_call_1 ","approved":true,"reason":" ok "}\n'));
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"approval","approvalId":"approval_call_2","approved":"yes"}\n'));
      expect(onApprovalDecision).toHaveBeenCalledTimes(1);
      expect(onApprovalDecision).toHaveBeenCalledWith({
        approvalId: "approval_call_1",
        approved: true,
        reason: "ok"
      });
    } finally {
      detach();
    }
  });

  it("invokes onUiResponse for ui_response control messages", () => {
    const onUiResponse = vi.fn();
    const detach = attachStdinControlListener({ onUiResponse });
    try {
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"ui_response","requestId":" extui_1 ","value":true}\n'));
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"ui_response","requestId":"extui_2","value":"blue"}\n'));
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"ui_response","requestId":"extui_3"}\n'));
      process.stdin.emit("data", Buffer.from('{"type":"control","action":"ui_response","requestId":"   "}\n'));
      expect(onUiResponse).toHaveBeenCalledTimes(3);
      expect(onUiResponse).toHaveBeenNthCalledWith(1, { requestId: "extui_1", value: true });
      expect(onUiResponse).toHaveBeenNthCalledWith(2, { requestId: "extui_2", value: "blue" });
      expect(onUiResponse).toHaveBeenNthCalledWith(3, { requestId: "extui_3", value: null });
    } finally {
      detach();
    }
  });

  it("stops listening after detach", () => {
    const onCompact = vi.fn();
    const detach = attachStdinControlListener({ onCompact });
    detach();
    process.stdin.emit("data", Buffer.from('{"type":"control","action":"compact"}\n'));
    expect(onCompact).not.toHaveBeenCalled();
  });
});
