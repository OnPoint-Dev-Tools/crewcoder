# Artifacts over ACP

CrewCoder stores model-generated source documents and exposes them to embedding apps over
ACP. Your app owns its artifact browser, preview sandbox, source editor, and download UI.
CrewCoder never renders or executes artifact content and does not start a preview server.

This is a CrewCoder ACP extension, not a standard ACP capability or a provider-native
artifact format. It is implemented by CrewCoder as the ACP **agent** (`crewcoder acp`).
HTTP model providers, Claude's CrewCoder MCP tools, and Codex's dynamic tools use the same
artifact tools when running through this adapter. Nested external ACP providers such as
Grok CLI own their tools and do not receive CrewCoder's artifact tools.

## Discover support

Read `initialize.result._meta["crewcoder/artifacts"]`:

```json
{
  "version": 1,
  "listMethod": "session/artifacts/list",
  "readMethod": "session/artifacts/read",
  "writeMethod": "session/artifacts/write",
  "notification": "_crewcoder/artifact_updated",
  "formats": ["html", "svg", "mermaid", "markdown"],
  "maxContentBytes": 524288,
  "maxArtifacts": 100,
  "maxSessionBytes": 16777216
}
```

Use the advertised method names. Every request requires `sessionId` and `version: 1`.
The session must have been opened through `session/new` or `session/load` on the current
connection. Knowing another session's artifact ID does not grant access to its content.

## App integration

1. Initialize ACP and check the advertised artifact version.
2. Open or load a session, then call `session/artifacts/list` to populate your browser.
3. Listen for `_crewcoder/artifact_updated` JSON-RPC notifications; upsert the metadata by
   session and artifact ID. Fetch the latest source when opening or refreshing a preview.
4. Use `session/artifacts/read` to retrieve the complete document. Route its `format`
   to your renderer; HTML includes self-contained interactive charts and apps.
5. Save source edits with `session/artifacts/write`, supplying the revision you read.
   On a conflict, fetch the latest source and let the user reconcile it.
6. For downloads, encode the returned `content` as UTF-8 with the returned `mimeType`
   and an app-chosen safe filename. There is no public file URL or HTTP download endpoint.

Example requests (JSON-RPC envelope omitted):

```json
{ "method": "session/artifacts/list", "params": { "sessionId": "SESSION", "version": 1 } }
```

Returns `{ artifacts: ArtifactMetadata[] }`, without source content.

```json
{
  "method": "session/artifacts/write",
  "params": {
    "sessionId": "SESSION",
    "version": 1,
    "title": "Counter",
    "format": "html",
    "content": "<!doctype html><button onclick=\"this.textContent=Number(this.textContent)+1\">0</button>"
  }
}
```

Omit `id` and `expectedRevision` to create. The result is `{ artifact: Artifact }`.

```json
{
  "method": "session/artifacts/read",
  "params": { "sessionId": "SESSION", "version": 1, "id": "ARTIFACT_ID" }
}
```

Returns `{ artifact: Artifact }`, including the complete `content`.

```json
{
  "method": "session/artifacts/write",
  "params": {
    "sessionId": "SESSION",
    "version": 1,
    "id": "ARTIFACT_ID",
    "expectedRevision": 1,
    "title": "Counter",
    "format": "html",
    "content": "<!doctype html><button onclick=\"this.textContent=Number(this.textContent)+2\">0</button>"
  }
}
```

Updates replace the entire source, title, and format. They retain the ID and creation time
and increment `revision`. Only the latest source is retained; revision numbers provide
conflict detection, not historical source retrieval.

### Artifact shape

```ts
type ArtifactFormat = "html" | "svg" | "mermaid" | "markdown";

type ArtifactMetadata = {
  id: string;            // CrewCoder-generated opaque ID
  title: string;         // 1–200 characters, no control characters
  format: ArtifactFormat;
  mimeType: string;
  revision: number;      // starts at 1
  byteSize: number;      // UTF-8 content bytes
  createdAt: string;     // ISO timestamp
  updatedAt: string;     // ISO timestamp
};

type Artifact = ArtifactMetadata & { content: string };
```

| Format | MIME type | Suggested download extension |
| --- | --- | --- |
| html | text/html | .html |
| svg | image/svg+xml | .svg |
| mermaid | text/vnd.mermaid | .mmd |
| markdown | text/markdown | .md |

### Notifications and recovery

A successful write stores the source before sending this notification:

```json
{
  "jsonrpc": "2.0",
  "method": "_crewcoder/artifact_updated",
  "params": {
    "sessionId": "SESSION",
    "version": 1,
    "action": "created",
    "artifact": {
      "id": "ARTIFACT_ID",
      "title": "Counter",
      "format": "html",
      "mimeType": "text/html",
      "revision": 1,
      "byteSize": 95,
      "createdAt": "2026-10-27T12:00:00.000Z",
      "updatedAt": "2026-10-27T12:00:00.000Z"
    }
  }
}
```

`action` is `created` or `updated`. Notifications contain metadata only. They are live
hints, not a replay log: re-list after reconnect or load. A disconnected client can miss
a notification even though the write committed. After an uncertain update outcome, read
the artifact before retrying; after an uncertain create outcome, list before creating again.

Artifact validation errors use JSON-RPC code `-32602` with `error.data.artifactCode`:
`invalid`, `not_found`, `conflict`, `limit`, or `busy`. Storage/transport failures retain
the normal ACP internal error path. A conflicting write leaves the stored source unchanged.
A concurrent writer receives `busy` and may retry after re-reading.

## Model behavior and permissions

Normal ACP sessions expose `artifact_write`, `artifact_read`, and `artifact_list` in
the model's tool catalog. Ask the model to create an artifact rather than merely write
HTML into a chat code fence. The write tool accepts the same document fields as the app
endpoint and requires the latest `expectedRevision` on updates.

Model writes use the existing approval, cancellation, workflow, and tool-event paths.
They are mutations, so review mode requests permission and deliberate CrewCoder mode
requires its normal plan approval. App-initiated writes are explicit host operations
and do not prompt the model's approval channel.

The `hosted-text-only` policy excludes these model tools and refuses artifact write RPCs.
Hosts using that policy can supply their own artifact tools with distinct names through
[client-hosted tools](CLIENT_TOOLS.md); the existing host authority stays intact.
The three CrewCoder artifact tool names are reserved and cannot be shadowed by host tools.

Virtual workspace sessions may use artifact storage: these are explicitly owned CrewCoder
state documents, never reads/writes of the host's workspace. Source documents contain no
workspace paths and cannot cause CrewCoder to fetch files or run commands.

## Storage and limitations

Artifacts live at `<CREWCODER_HOME>/artifacts/<sessionId>/<artifactId>.json`, outside
workspace directories and session-prune's disposable files. New artifact directories use
mode `0700`; source records use `0600`. Writes use an atomic rename under a per-session
writer lock. Source is limited to 512 KiB per artifact, 100 artifacts and 16 MiB of current
source per session. UTF-8 bytes determine these limits.

A crash can leave a `.write-lock` directory. Writes fail closed with `busy`; an operator
must confirm no writer is active and clear the stale lock before retrying. Limits and
symlink checks also apply when reading persisted records.

The ordinary ACP session lifecycle still applies: `session/new` allocates an ID, and
the first prompt saves the durable transcript. To reconnect with `session/load`, that
transcript must already exist. Artifacts survive normal process restarts and compaction
under the same session ID. They are not copied by session branching, export, or bundles,
and session deletion/pruning does not automatically remove this separate artifact store.
There is currently no artifact delete RPC or revision-history API.

Only single text documents are supported. Multi-file bundles, binary images, React/TSX
compilation, package installation, external asset resolution, and rendering are not provided.
For charts or apps, models should produce self-contained HTML with inline CSS/JavaScript.

## Preview trust boundary

Treat all source and metadata as untrusted. Your app must render HTML/SVG in an isolated
preview that has no Node/Electron integration, app privileges, filesystem access, credentials,
or privileged IPC bridge. Keep script execution out of the app's origin, deny navigation and
network access by default, and expose only narrowly defined preview capabilities. Sanitize
Markdown and configure diagram rendering safely. Display titles as text.

CrewCoder stores source exactly as supplied; it does not sanitize it or certify that it is
safe to execute. The preview renderer and its security tests belong to the embedding app.
