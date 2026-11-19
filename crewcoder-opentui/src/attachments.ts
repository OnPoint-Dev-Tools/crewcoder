import { readClipboard, readClipboardImage, type ClipboardImage } from "@onpoint-dev-tools/crewcoder-tui-core/state/clipboard";
import path from "node:path";
import { attachedSources, imagePathsFromText, persistImageBuffer, persistImageFile, sniffImage, type ImageAttachment } from "@onpoint-dev-tools/crewcoder-tui-core/state/image-attachment";

/**
 * Image attachments for the next prompt, ported from the legacy composer:
 * Ctrl+V takes a screenshot off the clipboard, image paths in the prompt
 * (a file dropped on the terminal pastes its path) attach when it is sent, and
 * Ctrl+X clears them. Files are copied into the CrewCoder image cache
 * (`persistImageBuffer` / `persistImageFile` in tui-core) and reach the agent
 * as `--image <path>`.
 */
export type ClipboardSource = {
  image(): ClipboardImage | undefined;
  text(): string | undefined;
};

/** The system clipboard through platform tools (tui-core `state/clipboard`). */
export const systemClipboard: ClipboardSource = { image: readClipboardImage, text: readClipboard };

/** What Ctrl+V did: attached images, or text for the composer, or nothing. */
export type PasteResult = { attached: ImageAttachment[]; text?: string };

/**
 * Prefer an image on the clipboard; otherwise clipboard text that names image
 * files attaches those files; otherwise the text is returned for the composer.
 */
export function pasteFromClipboard(clipboard: ClipboardSource, existing: readonly ImageAttachment[]): PasteResult {
  const image = clipboard.image();
  if (image) {
    const info = sniffImage(image.data) ?? { mime: "image/png" as const };
    return { attached: [persistImageBuffer(image.data, info, "clipboard")] };
  }
  const text = clipboard.text();
  if (!text) return { attached: [] };
  const attached = attachImagePaths(text, existing);
  return attached.length > 0 ? { attached } : { attached: [], text };
}

/** Image files named in `text` that exist and are not attached yet; unreadable paths are skipped. */
export function attachImagePaths(text: string, existing: readonly ImageAttachment[]): ImageAttachment[] {
  // Checked before copying: each attach writes a new cache file.
  const seen = attachedSources(existing);
  const attached: ImageAttachment[] = [];
  for (const filePath of imagePathsFromText(text)) {
    if (seen.has(path.resolve(filePath))) continue;
    const attachment = persistImageFile(filePath);
    if (!attachment) continue;
    seen.add(attachment.sourcePath ?? attachment.path);
    attached.push(attachment);
  }
  return attached;
}
