import { describeAttachment, type ImageAttachment } from "@onpoint-dev-tools/crewcoder-tui-core/state/image-attachment";
import type { ReactNode } from "react";
import { useTheme } from "../hooks/use-theme.js";
import { actionLabel } from "../keybindings.js";

/**
 * Images waiting for the next prompt, one row above the composer (legacy
 * chip row): `IMG 1 800×600 · 34.1 KB`, and the clear shortcut pinned right.
 * One row tall, never wraps (`footerExtras().attachmentRows`).
 */
export function AttachmentRow({ attachments }: { attachments: readonly ImageAttachment[] }): ReactNode {
  const theme = useTheme();
  return (
    <box flexDirection="row" height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text height={1} wrapMode="none" flexGrow={1} flexShrink={1}>
        {attachments.flatMap((attachment, index) => [
          <span key={`${attachment.id}-chip`} bg={theme.colors.secondary} fg={theme.colors.accent}>{` IMG ${index + 1} `}</span>,
          <span key={`${attachment.id}-info`} fg={theme.colors.mutedForeground}>{` ${describeAttachment(attachment)}${index < attachments.length - 1 ? "  " : ""}`}</span>
        ])}
      </text>
      <text fg={theme.colors.mutedForeground} height={1} wrapMode="none" flexShrink={0}>{`  ${actionLabel("clearAttachments")} clear`}</text>
    </box>
  );
}
