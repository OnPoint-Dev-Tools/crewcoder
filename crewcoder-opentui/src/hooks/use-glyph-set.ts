import type { TerminalCapabilities } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";
import { GLYPHS_ENV, resolveGlyphSet, type GlyphSet } from "../glyphs.js";

/**
 * The icon set this terminal can draw. Follows the renderer's capability
 * probe, which can answer after the first frame (tmux re-reports several times),
 * so icons switch once the terminal is known.
 */
export function useGlyphSet(): GlyphSet {
  const renderer = useRenderer();
  const [capabilities, setCapabilities] = useState<TerminalCapabilities | null>(renderer.capabilities);
  useEffect(() => {
    const update = (next: TerminalCapabilities): void => setCapabilities(next);
    renderer.on("capabilities", update);
    setCapabilities(renderer.capabilities);
    return () => {
      renderer.off("capabilities", update);
    };
  }, [renderer]);
  return resolveGlyphSet(capabilities, process.env[GLYPHS_ENV]);
}
