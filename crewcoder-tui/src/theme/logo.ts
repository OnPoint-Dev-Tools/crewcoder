export const crewCodeLogoLines = [
// "▄▖▄▖▄▖▖  ▖  ▄▖▄▖▄ ▄▖▄▖",
// "▌ ▙▘▙▖▌▞▖▌  ▌ ▌▌▌▌▙▖▙▘",
// "▙▖▌▌▙▖▛ ▝▌  ▙▖▙▌▙▘▙▖▌▌",

// "░█▀▀░█▀▄░█▀▀░█░█░ ░█▀▀░█▀█░█▀▄░█▀▀░█▀▄",
// "░█░░░█▀▄░█▀▀░█▄█░ ░█░░░█░█░█░█░█▀▀░█▀▄",
// " ▀▀▀ ▀ ▀ ▀▀▀ ▀ ▀   ▀▀▀ ▀▀▀ ▀▀  ▀▀▀ ▀ ▀",

"┏┓       ┏┓   ┓     ",
"┃ ┏┓┏┓┓┏┏┃ ┏┓┏┫┏┓┏┓ ",
"┗┛┛ ┗ ┗┻┛┗┛┗┛┗┻┗ ┛  ",

 ];

export const compactCrewCodeLogoLines = crewCodeLogoLines;

export const miniCrewCodeLogoLines = [
  "CREW CODER"
];

// Large 5-row block wordmark, assembled from a fixed-height block alphabet so the
// letters always stay aligned. Used by the home screen on wide terminals.
type BlockGlyph = [string, string, string, string, string];

const BLOCK_GLYPHS: Record<string, BlockGlyph> = {
  C: ["██████", "██    ", "██    ", "██    ", "██████"],
  R: ["█████ ", "██  ██", "█████ ", "██ ██ ", "██  ██"],
  E: ["██████", "██    ", "█████ ", "██    ", "██████"],
  W: ["██   ██", "██   ██", "██ █ ██", "███████", " ██ ██ "],
  O: [" ████ ", "██  ██", "██  ██", "██  ██", " ████ "],
  D: ["█████ ", "██  ██", "██  ██", "██  ██", "█████ "]
};

function buildBlockBanner(text: string): string[] {
  const rows = ["", "", "", "", ""];
  for (const char of text) {
    const glyph = BLOCK_GLYPHS[char];
    if (!glyph) continue;
    for (let row = 0; row < rows.length; row++) {
      rows[row] += (rows[row] ? " " : "") + glyph[row];
    }
  }
  return rows;
}

export const bigCrewCodeLogoLines = buildBlockBanner("CREW CODER");
