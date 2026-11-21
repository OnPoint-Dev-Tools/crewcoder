import { currentMention, MENTION_LIMIT, replaceMention, type MentionToken, type PathLister, type PathSuggestion } from "./path-suggestions.js";

/** The open `@` suggestion list: the token it answers, its paths, and the highlighted row. */
export type MentionState = { token: MentionToken; items: readonly PathSuggestion[]; cursor: number };

/** What the `@` list needs from its owner (`SessionController`). */
export type MentionHost = {
  cwd(): string;
  /** The list opened, moved, or closed: re-render. */
  changed(): void;
  /** Listing failed (shown as a footer alert). */
  failed(error: unknown): void;
};

/**
 * State and request ordering for `@` path suggestions (`docs/MENTIONS.md`).
 * Pure string work lives in `path-suggestions.ts`; this class owns the open
 * list, Esc dismissal, and dropping answers for tokens the user has left.
 */
export class Mentions {
  current: MentionState | undefined;
  /** Null disables listing (remote mode: the workspace is on the SSH host). */
  private readonly listPaths: PathLister | null;
  private readonly host: MentionHost;
  private request = 0;
  /** The composer text and cursor (JS index) the last update saw. */
  private input = { text: "", cursor: 0 };
  /** `start:query` of a token closed with Esc; it stays closed until it changes. */
  private dismissed: string | undefined;
  /** `start:query` of the listing in flight. */
  private pending: string | undefined;

  constructor(listPaths: PathLister | null, host: MentionHost) {
    this.listPaths = listPaths;
    this.host = host;
  }

  /**
   * Called on every composer edit and cursor move. Opens, refreshes, or closes
   * the list for the token at the cursor. Listing is async; an answer for a
   * token the user has since left is dropped. Until it arrives the previous
   * list stays up, so typing does not flicker.
   */
  update(text: string, cursor: number): void {
    this.input = { text, cursor };
    const listPaths = this.listPaths;
    const token = listPaths ? currentMention(text, cursor) : undefined;
    const key = token ? `${token.start}:${token.query}` : undefined;
    if (key !== this.dismissed) this.dismissed = undefined;
    if (!token || !listPaths || key === this.dismissed || (this.current && this.current.token.start !== token.start)) {
      this.cancel();
      if (this.current) this.close();
      if (!token || !listPaths || key === this.dismissed) return;
    }
    if (this.current && this.current.token.query === token.query) return;
    // A cursor move inside a token whose listing is still loading asks nothing new.
    if (this.pending === key) return;
    this.pending = key;
    const request = ++this.request;
    listPaths(this.host.cwd(), token.query, MENTION_LIMIT).then((items) => {
      if (request !== this.request) return;
      this.pending = undefined;
      const latest = currentMention(this.input.text, this.input.cursor);
      if (!latest || latest.start !== token.start || latest.query !== token.query) return;
      this.current = { token: latest, items, cursor: 0 };
      this.host.changed();
    }, (error: unknown) => {
      if (request !== this.request) return;
      this.pending = undefined;
      this.host.failed(error);
    });
  }

  move(delta: number): void {
    const mention = this.current;
    if (!mention || mention.items.length === 0) return;
    const count = mention.items.length;
    this.current = { ...mention, cursor: (mention.cursor + delta + count) % count };
    this.host.changed();
  }

  /** Esc: close the list; it reopens once the token changes. */
  dismiss(): void {
    const mention = this.current;
    if (!mention) return;
    this.dismissed = `${mention.token.start}:${mention.token.query}`;
    this.cancel();
    this.close();
  }

  /**
   * Enter/Tab: the composer text with the highlighted path in place of the
   * token, and where the cursor goes (JS index); undefined when nothing is
   * highlighted. Uses the latest token, since the list can be a keystroke behind.
   */
  accept(): { text: string; cursor: number } | undefined {
    const mention = this.current;
    const pick = mention?.items[mention.cursor];
    if (!mention || !pick) return undefined;
    const { text, cursor } = this.input;
    const token = currentMention(text, cursor) ?? mention.token;
    this.cancel();
    this.close();
    return replaceMention(text, token, pick);
  }

  /** Drop any listing in flight. */
  private cancel(): void {
    this.request += 1;
    this.pending = undefined;
  }

  private close(): void {
    this.current = undefined;
    this.host.changed();
  }
}
