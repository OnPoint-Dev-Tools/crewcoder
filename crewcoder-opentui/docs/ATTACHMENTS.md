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
  (`(image attached)` when there is no text) and one `IMAGE` row per file, with name,
  dimensions, size, and cache path. Tool-result images read `TOOL IMAGE`. Pixels are not
  drawn yet (terminal graphics are a separate port item).
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
