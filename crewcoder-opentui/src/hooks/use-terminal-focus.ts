import { useBlur, useFocus, usePaste } from "@opentui/react";
import { useRef, type RefObject } from "react";

/**
 * Whether this terminal surface has focus, from focus reporting (DECSET 1004,
 * which OpenTUI enables itself and turns off on exit).
 *
 * Ported from the legacy `InputFocusGate`: while the tab, pane, or window is
 * unfocused, input is dropped, so input a terminal duplicates to several panes
 * (broadcast input, emulator bugs) cannot reach a second CrewCoder instance.
 * App drops keys with this ref; pastes are dropped here, because global paste
 * listeners run before the focused composer and it honors `preventDefault`.
 *
 * Starts focused: a terminal without focus reporting never sends focus events,
 * so input keeps working there.
 */
export function useTerminalFocus(): RefObject<boolean> {
  const focused = useRef(true);
  useFocus(() => {
    focused.current = true;
  });
  useBlur(() => {
    focused.current = false;
  });
  usePaste((event) => {
    if (!focused.current) event.preventDefault();
  });
  return focused;
}
