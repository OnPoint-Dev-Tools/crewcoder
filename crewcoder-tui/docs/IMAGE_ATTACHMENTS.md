# Image Attachments

Paste screenshots or local image file paths into the composer and preview them in the conversation viewport.

## Status

Phase 1 (shipped): clipboard image paste, attachment persistence, composer chip,
and a viewport preview block with real terminal pixels on supported terminals
(Kitty/Ghostty/iTerm2) plus a metadata fallback everywhere else.

Phase 2 (shipped): the model actually receives the pixels on vision-capable
providers. `crewcoder-agent/src/core/messages.ts` has an `ImagePart` (carries the
on-disk `path` + `mime`), the TUI bridge ships attachment paths as repeatable
`--image <path>` args, and provider adapters read + base64-encode the bytes at
request time.

Provider vision support:

| Runtime                          | Providers          | Encoding                                    | Vision |
|----------------------------------|--------------------|---------------------------------------------|--------|
| `anthropic-messages`             | anthropic, opencode | `image` block, `source.type=base64`         | adapter support |
| `anthropic-messages` (OpenAI Go) | opencode-go (Kimi) | OpenAI chat `image_url` data URI             | adapter support |
| `openai-chat-completions`        | OpenRouter, xAI, DeepSeek, Mistral | `image_url` data URI             | adapter support |
| `openai-responses`               | openai             | `input_image` data URI                       | adapter support |
| `openai-codex-responses`         | codex (ChatGPT OAuth) | `input_image` data URI                    | adapter support |

Adapter support does not guarantee that every selectable model accepts images.
The selected provider model must support vision. Codex image encoding is additive
to the user turn and does not touch sensitive ChatGPT OAuth headers.

## Flow

```
Ctrl+V
  -> readClipboardImage()            tui/clipboard.ts      (binary, MIME-typed)
  -> sniffImage(buffer)              state/image-attachment.ts (header-only dims)
  -> persistImageBuffer(...)         -> ~/.crewcoder/cache/images/<id>.<ext>
  -> state.attachments.push(...)     Composer chip row
  -> if no binary image exists, pasted text is scanned for local image paths
Enter
  -> submitted text is scanned for local image paths as a fallback
  -> App.runPrompt                   pushes user block + one `image` block each
  -> bridge.run/resume ship each attachment path as `--image <path>`
  -> crewcoder-agent builds ImageParts on the user message; vision-capable
     providers read + base64-encode the bytes at request time
  -> clears state.attachments
```

Backend transport: `--image` (repeatable) on `crewcoder run` / `crewcoder session
resume` -> `AgentRequest.images` -> `withImageParts()` on the user message
(`core/messages.ts`) -> provider adapters (`providers/http-provider.ts`,
`providers/openai-responses-provider.ts`).

`Ctrl+X` clears pending attachments before sending. Submit is allowed with an
image and no text. Local image paths may be plain paths, `~/...`, relative paths,
or `file://...` URIs ending in `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, or
`.bmp`.

## Modules

- `state/image-attachment.ts` — `ImageAttachment`, `sniffImage` (PNG/JPEG/GIF/
  WebP/BMP dimensions from header bytes, no pixel decode), `persistImageBuffer`,
  `persistImageFile`, `describeAttachment`, `formatBytes`.
- `tui/clipboard.ts` — `readClipboardImage()` and `imageReadCommands()`
  (`wl-paste --type image/png`, `xclip -t image/png -o`, `pngpaste -`,
  PowerShell on Windows). Buffers are read as bytes, never utf8.
- `tui/image-protocol.ts` — `detectImageProtocol(env)` (kitty/iterm/none),
  `encodeKittyImage`, `encodeItermImage`, `encodeKittyDeleteVisibleImages`,
  `fitPlacement`. Pure, unit-tested.
- `tui/renderer.ts` — post-frame graphics pass. The viewport reserves a visible
  cell rectangle for each fully visible image block, then the renderer moves the
  cursor back to that row/column and emits the terminal image escape.

## Images in tool results

Images do not only come from the composer. Any tool can declare images on its
result and the TUI blits them inline underneath that tool's output, through the
exact same `image` block and graphics layer as a pasted screenshot.

```
tool returns ToolResult.details.images = [{ path, displayPath, mime, byteSize }]
  -> agent-loop merges details into the `tool_execution_end` event `metadata`
  -> event-reducer: toolImageAttachments(metadata) -> state.blocks `image` entries
  -> MainViewport.renderImage -> reserved cell rectangle -> renderer graphics pass
```

Contract notes:

- **The bytes are the fact, the payload is a claim.** `attachmentFromToolImage`
  re-sniffs mime and pixel dimensions from the file on disk and ignores what the
  tool reported. A payload that does not resolve to a readable image on disk is
  dropped and the tool output renders normally — a broken or stale path must never
  blank out real output.
- **Nothing is copied.** Pasted screenshots are persisted into
  `~/.crewcoder/cache/images` because the clipboard is ephemeral; a tool image
  already lives in the workspace, so it is referenced in place. Copying every image
  a tool touches would grow the cache without bound.
- **Only header bytes are read** (first 64 KB) to measure the image, so a 40 MB
  screenshot is never loaded into memory to be sized.
- **Failed tool calls render no image.** Error output is what matters there.
- Blocks are deduped by attachment id (a stable hash of the absolute path), so a
  tool reporting the same file more than once yields one placement.
- The block is labelled `TOOL IMAGE`, not `IMAGE`, so the transcript never implies
  the user attached something the agent produced.

### Producer side (`crewcoder-agent`)

`core/tool-images.ts` provides `detectImageMime` (magic bytes only — extensions
lie), `describeToolImage(absolutePath, cwd)`, and `describeToolImageForModel`.

The built-in `read` tool is the first producer: reading an image now returns a
short description plus `details.images` instead of reinterpreting the binary as
UTF-8. That old behavior filled the model's context with garbage it could not use
and charged real tokens for it — reading a 215 KB PNG cost ~220 KB of context and
told the model nothing.

Extension tools get this for free by putting the same shape on `details.images`.

## Terminal support

| Terminal            | Protocol | Detection                                   |
|---------------------|----------|---------------------------------------------|
| kitty               | kitty    | `KITTY_WINDOW_ID` / `TERM` contains `kitty` |
| Ghostty             | kitty    | `TERM_PROGRAM=ghostty`                       |
| iTerm2              | iterm    | `TERM_PROGRAM=iTerm.app` / `LC_TERMINAL`     |
| everything else     | none     | metadata chip fallback                       |

Override with `CREWCODER_TUI_IMAGE_PROTOCOL=kitty|iterm|none|auto`.

## Graphics rendering

The viewport `image` block always renders metadata (filename, dimensions, byte
size, mime, path). When the detected protocol is `kitty` or `iterm`, it also
reserves a bounded cell rectangle and registers a per-frame placement with the
renderer. The renderer draws images after the text frame so the normal line-diff
renderer remains text-first and copy/select-safe.

Only fully visible image blocks are drawn. Scrolling a block partially off-screen
falls back to text for that frame instead of drawing clipped pixels. Kitty/Ghostty
placements are cleared before repainting or stopping the TUI; iTerm2 images are
redrawn from cached file bytes. During scroll/diff renders, pixel redraw is
briefly debounced so the transcript stays smooth and images settle back in after
about 100ms of idle time.

Conversation view has no persistent header, so `MainViewport` image placement
rows already match absolute terminal rows. `App.renderNormal` forwards those
placements without an offset, keeping pixels inside the blank rows reserved by
the image block.

Opaque modal boxes suppress any graphics placement that intersects their cell
rectangle. Terminal graphics render above text and cannot be clipped by painted
cells, so an intersecting image is removed while the modal is open and restored
on the frame after it closes. Images outside the modal remain visible.

A diff render only erases and redraws graphics when a placement actually moved
(the image signature changed) or when a repainted text row overlaps the image's
reserved rectangle. Any other change — most importantly the 90ms working spinner
against the 120ms render tick — repaints just its own rows and leaves the pixels
on screen. Erasing on every frame made a settled image blink on and off for the
duration of a run. `Renderer.drawnImageSignature` tracks what is currently painted
so the untouched path can re-arm the debounced pass if a prior frame left the
images undrawn. Guarded by `src/tests/renderer.test.ts`.
