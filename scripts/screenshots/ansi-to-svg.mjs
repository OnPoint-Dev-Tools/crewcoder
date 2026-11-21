// Convert a `tmux capture-pane -e -p` dump into an SVG terminal screenshot.
// Usage: node ansi-to-svg.mjs <capture.ansi> <out.svg> [title]
import fs from "node:fs";

const [input, output, title = "crewcoder"] = process.argv.slice(2);
const raw = fs.readFileSync(input, "utf8").replace(/\n$/, "");
const rows = raw.split("\n");

const PALETTE16 = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
function xterm256(n) {
  if (n < 16) return PALETTE16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return rgb(v, v, v); }
  const i = n - 16; const c = [Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map((v) => (v ? 55 + v * 40 : 0));
  return rgb(...c);
}
function rgb(r, g, b) { return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""); }

// Parse every row into cells: { ch, fg, bg, bold, italic, dim, underline, strike }
const grid = rows.map((line) => {
  const cells = [];
  let st = { fg: null, bg: null, bold: false, italic: false, dim: false, underline: false, strike: false, reverse: false };
  const re = /\x1b\[([0-9;:]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|([\s\S])/gu;
  let m;
  while ((m = re.exec(line))) {
    if (m[2] !== undefined) {
      const cp = m[2].codePointAt(0);
      if (cp < 0x20) continue;
      cells.push({ ch: m[2], ...st });
      continue;
    }
    if (m[1] === undefined) continue;
    const p = m[1] === "" ? [0] : m[1].split(/[;:]/).map(Number);
    for (let i = 0; i < p.length; i++) {
      const v = p[i];
      if (v === 0) st = { fg: null, bg: null, bold: false, italic: false, dim: false, underline: false, strike: false, reverse: false };
      else if (v === 1) st = { ...st, bold: true };
      else if (v === 2) st = { ...st, dim: true };
      else if (v === 3) st = { ...st, italic: true };
      else if (v === 4) st = { ...st, underline: true };
      else if (v === 7) st = { ...st, reverse: true };
      else if (v === 9) st = { ...st, strike: true };
      else if (v === 22) st = { ...st, bold: false, dim: false };
      else if (v === 23) st = { ...st, italic: false };
      else if (v === 24) st = { ...st, underline: false };
      else if (v === 27) st = { ...st, reverse: false };
      else if (v === 29) st = { ...st, strike: false };
      else if (v >= 30 && v <= 37) st = { ...st, fg: PALETTE16[v - 30] };
      else if (v >= 90 && v <= 97) st = { ...st, fg: PALETTE16[v - 90 + 8] };
      else if (v >= 40 && v <= 47) st = { ...st, bg: PALETTE16[v - 40] };
      else if (v >= 100 && v <= 107) st = { ...st, bg: PALETTE16[v - 100 + 8] };
      else if (v === 39) st = { ...st, fg: null };
      else if (v === 49) st = { ...st, bg: null };
      else if (v === 38 || v === 48) {
        const key = v === 38 ? "fg" : "bg";
        if (p[i + 1] === 2) { st = { ...st, [key]: rgb(p[i + 2], p[i + 3], p[i + 4]) }; i += 4; }
        else if (p[i + 1] === 5) { st = { ...st, [key]: xterm256(p[i + 2]) }; i += 2; }
      }
    }
  }
  return cells;
});

const width = Math.max(Number(process.env.COLS ?? 0), ...grid.map((r) => r.length));
// The most common explicit background is the app's theme background.
const counts = new Map();
for (const r of grid) for (const c of r) if (c.bg) counts.set(c.bg, (counts.get(c.bg) ?? 0) + 1);
const BG = process.env.BG ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "#11161c";
const FG = "#d7dde5";

const CW = 8.4, CH = 18, FS = 14, PAD = 18, BAR = 34;
const W = Math.ceil(width * CW + PAD * 2), H = Math.ceil(rows.length * CH + PAD * 2 + BAR);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
out.push(`<rect width="${W}" height="${H}" rx="10" fill="${BG}"/>`);
out.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="none" stroke="#2a3440"/>`);
out.push(`<circle cx="22" cy="17" r="6" fill="#ff5f57"/><circle cx="42" cy="17" r="6" fill="#febc2e"/><circle cx="62" cy="17" r="6" fill="#28c840"/>`);
out.push(`<text x="${W / 2}" y="22" fill="#7f8b99" font-family="JetBrainsMono Nerd Font Mono" font-size="12" text-anchor="middle">${esc(title)}</text>`);

const ox = PAD, oy = PAD + BAR;
// Backgrounds, merged into runs per row.
grid.forEach((r, y) => {
  let x = 0;
  while (x < r.length) {
    const c = r[x];
    const bg = c.reverse ? (c.fg ?? FG) : c.bg;
    let end = x + 1;
    while (end < r.length && (r[end].reverse ? (r[end].fg ?? FG) : r[end].bg) === bg) end++;
    if (bg && bg !== BG) out.push(`<rect x="${(ox + x * CW).toFixed(1)}" y="${oy + y * CH}" width="${((end - x) * CW + 0.6).toFixed(1)}" height="${CH + 0.6}" fill="${bg}"/>`);
    x = end;
  }
});

// Block and box characters are drawn as shapes so they join seamlessly.
function shape(ch, x, y, fill) {
  const X = ox + x * CW, Y = oy + y * CH, mx = X + CW / 2, my = Y + CH / 2, t = 1.3;
  const r = (a, b, w, h) => `<rect x="${a.toFixed(2)}" y="${b.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}"/>`;
  const H_ = r(X, my - t / 2, CW + 0.4, t), V = r(mx - t / 2, Y, t, CH + 0.4);
  const left = r(X, my - t / 2, CW / 2 + t / 2, t), right = r(mx - t / 2, my - t / 2, CW / 2 + t / 2 + 0.4, t);
  const up = r(mx - t / 2, Y, t, CH / 2 + t / 2), down = r(mx - t / 2, my - t / 2, t, CH / 2 + t / 2 + 0.4);
  const arc = (d) => `<path d="${d}" fill="none" stroke="${fill}" stroke-width="${t}"/>`;
  const rad = Math.min(CW, CH) / 2;
  switch (ch) {
    case "█": return r(X, Y, CW + 0.4, CH + 0.4);
    case "▀": return r(X, Y, CW + 0.4, CH / 2);
    case "▄": return r(X, my, CW + 0.4, CH / 2 + 0.4);
    case "▌": return r(X, Y, CW / 2, CH + 0.4);
    case "▐": return r(mx, Y, CW / 2 + 0.4, CH + 0.4);
    case "▔": return r(X, Y, CW + 0.4, CH / 8);
    case "▁": return r(X, Y + CH * 7 / 8, CW + 0.4, CH / 8 + 0.4);
    case "─": case "━": return H_;
    case "│": case "┃": return V;
    case "┌": return right + down;
    case "┐": return left + down;
    case "└": return right + up;
    case "┘": return left + up;
    case "├": return V + right;
    case "┤": return V + left;
    case "┬": return H_ + down;
    case "┴": return H_ + up;
    case "┼": return H_ + V;
    case "╭": return arc(`M ${X + CW + 0.4} ${my} L ${mx + rad} ${my} A ${rad} ${rad} 0 0 0 ${mx} ${my + rad} L ${mx} ${Y + CH + 0.4}`);
    case "╮": return arc(`M ${X} ${my} L ${mx - rad} ${my} A ${rad} ${rad} 0 0 1 ${mx} ${my + rad} L ${mx} ${Y + CH + 0.4}`);
    case "╰": return arc(`M ${mx} ${Y} L ${mx} ${my - rad} A ${rad} ${rad} 0 0 0 ${mx + rad} ${my} L ${X + CW + 0.4} ${my}`);
    case "╯": return arc(`M ${mx} ${Y} L ${mx} ${my - rad} A ${rad} ${rad} 0 0 1 ${mx - rad} ${my} L ${X} ${my}`);
    case "╌": case "┄": return [0, 1].map((k) => r(X + k * CW / 2, my - t / 2, CW / 2 - 1.5, t)).join("");
    case "╎": case "┆": return [0, 1].map((k) => r(mx - t / 2, Y + k * CH / 2, t, CH / 2 - 3)).join("");
    default: return undefined;
  }
}

grid.forEach((r, y) => {
  let x = 0;
  while (x < r.length) {
    const c = r[x];
    const fg = (c.reverse ? (c.bg ?? BG) : c.fg) ?? FG;
    if (c.ch === " ") { x++; continue; }
    const s = shape(c.ch, x, y, fg);
    if (s) { out.push(c.dim ? `<g opacity="0.55">${s}</g>` : s); x++; continue; }
    // Group consecutive plain glyphs with identical style into one <text> with per-glyph x.
    let end = x + 1;
    const same = (d) => d.ch !== " " && !shape(d.ch, 0, 0, "") && ((d.reverse ? (d.bg ?? BG) : d.fg) ?? FG) === fg && d.bold === c.bold && d.italic === c.italic && d.dim === c.dim && d.underline === c.underline && d.strike === c.strike;
    while (end < r.length && same(r[end])) end++;
    const xs = [];
    for (let i = x; i < end; i++) xs.push((ox + i * CW).toFixed(1));
    const glyphs = r.slice(x, end).map((d) => d.ch).join("");
    const deco = [c.underline ? "underline" : "", c.strike ? "line-through" : ""].filter(Boolean).join(" ");
    out.push(`<text x="${xs.join(" ")}" y="${oy + y * CH + 13.5}" fill="${fg}"${c.bold ? ' font-weight="bold"' : ""}${c.italic ? ' font-style="italic"' : ""}${c.dim ? ' opacity="0.55"' : ""}${deco ? ` text-decoration="${deco}"` : ""} font-family="JetBrainsMono Nerd Font Mono" font-size="${FS}" xml:space="preserve">${esc(glyphs)}</text>`);
    x = end;
  }
});

out.push("</svg>");
fs.writeFileSync(output, out.join("\n"));
console.log(`${output}: ${width}x${rows.length} cells, ${W}x${H}px, bg ${BG}`);
