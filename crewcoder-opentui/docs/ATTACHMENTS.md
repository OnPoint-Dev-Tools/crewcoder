# Image attachments and composer shortcuts

## Images

Ported from the legacy composer (`crewcoder-tui/docs/IMAGE_ATTACHMENTS.md`):

- **Ctrl+V** (`pasteClipboard`, also Meta+V) takes an image off the system clipboard
  (`wl-paste`/`xclip` on Linux, `pngpaste` on macOS, PowerShell on Windows). If there is
  no image but the clipboard text names image files, those attach. Otherwise the text is
  inserted into the composer. Terminal paste (Ctrl+Shift+V) still pastes text as usual.
- **Image paths in the prompt** attach when it is sent: absolute, `~/`, `./`, `../`, or
  `file://` paths ending in `.png .jpg .jpeg .gif .webp .bmp`. Dropping a file on the
  terminal types its path, so dropped screenshots attach. The prompt text keeps the path.
- Pending images show as one row above the composer: `IMG 1 800×600 · 34.1 KB` and the
  clear hint. **Ctrl+X** (`clearAttachments`) drops them; with no images, Ctrl+X does
  nothing here.
- Enter sends the images with the prompt, or alone. The transcript shows the prompt
  (`(image attached)` when there is no text) and one `IMAGE` block per file: name,
  dimensions, size, the pixels, and the cache path. Tool-result images read `TOOL IMAGE`
  (see [Inline pixels](#inline-pixels)).
- Images go to the agent as `--image <path>` on a **new run or resume**. A follow-up to a
  running turn is text only (the control channel carries no files), so pending images
  wait for the next prompt.
- Every attachment is copied into `$CREWCODER_HOME/cache/images` (`persistImageBuffer` /
  `persistImageFile` in tui-core). Attaching the same file twice is a no-op: file
  attachments record `sourcePath`, and the check runs before copying.
- **Remote mode** attaches nothing: local files cannot reach the SSH host yet. Ctrl+V
  still pastes clipboard text, and an image on the clipboard gets a warning.

Shared code in `crewcoder-tui-core`: `state/clipboard.ts` (moved from the legacy UI,
which re-exports it), and `imagePathsFromText` / `attachedSources` in
`state/image-attachment.ts`. OpenTUI wiring: `src/attachments.ts` (an injectable
`ClipboardSource`, the sixth `SessionController` argument), `SessionController.pasteClipboard`
/ `clearAttachments`, and `components/AttachmentRow.tsx`.

## Inline pixels

Image blocks (sent attachments and `details.images` from tools, which the shared reducer
turns into `image` blocks) draw their pixels with OpenTUI's native `<image>`
(`ImageView` in `components/Transcript.tsx`). Legacy's post-frame escape pass is not
ported: this package never writes raw escapes, and OpenTUI already handles placement,
clipping, and cleanup.

- **Protocol.** `auto` (default) follows OpenTUI's terminal probe: kitty graphics
  (kitty, Ghostty), sixel when the terminal reports it and its pixel size, otherwise
  half-block cells (`▀` with two colors per cell). Under tmux it is always half-blocks.
  `CREWCODER_TUI_IMAGE_PROTOCOL=kitty|sixel|blocks|none|auto` overrides (`off` = `none`);
  `none` keeps the caption only. Legacy's `iterm` value is not a protocol OpenTUI speaks
  and means `auto`: iTerm2 gets sixel when it reports support.
- **Size** (`imageBox` in `src/image-view.ts`), same caps as legacy: at most 80 columns
  (and the transcript's width), at most 35% of the screen height between 4 and 18 rows,
  keeping the image's shape for cells twice as tall as wide. OpenTUI fits the pixels
  inside the box with the real cell shape. The box follows terminal resizes.
- **Clipping.** In kitty mode OpenTUI sends the image once, then places it with a source
  crop when the transcript edge cuts it (checked: a 7-row image at the bottom edge was
  placed as `r=5` rows / 115 of 160 source pixels), below text (`z` < 0), and deletes the
  placement when it scrolls away or the UI exits. Images never draw over the composer.
- **Errors.** The source is a `file:` URL (OpenTUI fetches plain strings that look like
  `http(s)://`). A file that cannot be read or decoded keeps the caption and adds
  `(image could not be drawn)`; it never fails the render.
- **Remote mode** draws no pixels: a tool image path names a file on the SSH host.
  Note that the shared reducer still sniffs that path on the local disk to build the
  caption, so a remote tool image only shows when the same path exists locally
  (tui-core behavior shared with legacy, not changed here).

## Shortcuts

| Action | Default | Does |
|---|---|---|
| `pasteClipboard` | Ctrl+V, Meta+V | clipboard image, else clipboard text |
| `clearAttachments` | Ctrl+X | drop pending images |
| `togglePalette` | Ctrl+P | open the command palette, or close it |
| `openModes` | Tab, Ctrl+I | the modes and saved workers picker (legacy "agents overlay") |

Legacy terminals send Tab and Ctrl+I as the same byte. While the `@` list is open, Tab
picks a path instead (`mentionSelect` runs first). Ctrl+P and Tab keep the composer draft:
the picker unmounts the composer, and the draft comes back when it closes. Ctrl+B
toggles the right sidebar (`docs/SIDEBAR.md`).
