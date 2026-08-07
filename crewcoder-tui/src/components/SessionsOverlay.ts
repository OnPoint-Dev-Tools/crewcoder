import type { Component, KeyEvent, RenderContext } from "../tui/component.js";
import { listCrewCoderSessions, type SessionRecord } from "../bridge/crewcoder-process.js";
import type { ModalRow } from "./modal-view.js";
import { modalChromeHeight, modalRowAt, renderModalView } from "./modal-view.js";

export type SessionSelectHandler = (session: SessionRecord) => void;

type SessionRow = ModalRow & { sessionIndex?: number };

export class SessionsOverlay implements Component {
  private sessions: SessionRecord[] = [];
  private selected = 0;
  private loading = true;
  private error = "";
  private lastHeight = 1;

  constructor(private readonly onSelect: SessionSelectHandler, private readonly onBranch?: SessionSelectHandler) {
    this.load();
  }

  private async load(): Promise<void> {
    try {
      this.sessions = await listCrewCoderSessions();
      this.loading = false;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.loading = false;
    }
  }

  render(ctx: RenderContext): string[] {
    this.lastHeight = ctx.size.height;
    const rows = this.rows();
    return renderModalView(ctx, {
      title: "Sessions",
      rows,
      selected: this.selectedRow(rows),
      footer: "↑↓ navigate   ↵ resume   b branch   esc close",
      emptyText: this.loading ? "Loading sessions…" : this.error ? `Error: ${this.error}` : "No sessions found"
    });
  }

  desiredHeight(): number {
    const rows = Math.min(Math.max(this.rows().length, 1), 14);
    return rows + modalChromeHeight({ footer: true });
  }

  handleInput(event: KeyEvent): boolean {
    if (this.loading || !this.sessions.length) return false;
    if (event.name === "mouse" && event.mouse?.kind === "press") {
      const rows = this.rows();
      const rowIndex = modalRowAt(rows, this.selectedRow(rows), this.lastHeight, event.mouse.y, { footer: true });
      const sessionIndex = rowIndex === undefined ? undefined : rows[rowIndex]?.sessionIndex;
      if (sessionIndex === undefined) return true;
      this.selected = sessionIndex;
      this.onSelect(this.sessions[sessionIndex]!);
      return true;
    }
    if (event.name === "up") {
      this.selected = Math.max(0, this.selected - 1);
      return true;
    }
    if (event.name === "down") {
      this.selected = Math.min(this.sessions.length - 1, this.selected + 1);
      return true;
    }
    if (event.name === "return") {
      const selected = this.sessions[this.selected];
      if (selected) this.onSelect(selected);
      return true;
    }
    if (event.name === "b") {
      const selected = this.sessions[this.selected];
      if (selected) this.onBranch?.(selected);
      return true;
    }
    return false;
  }

  private rows(): SessionRow[] {
    if (this.loading || this.error || !this.sessions.length) return [];
    const rows: SessionRow[] = [];
    let previousDay = "";
    for (let sessionIndex = 0; sessionIndex < this.sessions.length; sessionIndex++) {
      const session = this.sessions[sessionIndex]!;
      const day = dayKey(session.startedAt);
      if (day !== previousDay) {
        rows.push({ label: formatDay(session.startedAt), header: true });
        previousDay = day;
      }
      const description = session.prompt.replace(/\s+/g, " ").trim() || "Untitled session";
      rows.push({
        label: `• ${description}`,
        hint: formatTime(session.startedAt),
        alignHint: true,
        sessionIndex
      });
    }
    return rows;
  }

  private selectedRow(rows: SessionRow[]): number {
    const index = rows.findIndex((row) => row.sessionIndex === this.selected);
    return index === -1 ? 0 : index;
  }
}

function sessionDate(iso: string): Date | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dayKey(iso: string): string {
  const date = sessionDate(iso);
  return date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : iso;
}

function formatDay(iso: string): string {
  const date = sessionDate(iso);
  if (!date) return "Unknown date";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "2-digit",
    year: "numeric"
  }).format(date).replaceAll(",", "");
}

function formatTime(iso: string): string {
  const date = sessionDate(iso);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}
