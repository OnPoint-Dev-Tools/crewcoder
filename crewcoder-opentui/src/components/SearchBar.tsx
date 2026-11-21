import type { InputRenderable } from "@opentui/core";
import type { ReactNode, RefObject } from "react";
import { useTheme } from "../hooks/use-theme.js";
import { actionLabel } from "../keybindings.js";
import type { TranscriptSearch } from "../search-controller.js";
import { matchCounter, matchSnippet } from "../transcript-search.js";

/** Rows the search bar takes in the footer: the field and the match line. */
export const SEARCH_BAR_ROWS = 2;

const LABEL = "Find ";

/**
 * Transcript search in the footer, in the composer's place
 * (`docs/TRANSCRIPT.md#search`): the query field with its counter and keys,
 * then the current match's line with the match picked out. Keys other than
 * typing go through `DEFAULT_APP_KEYBINDINGS` in `App`.
 */
export function SearchBar({ search, width, inputRef, onQuery }: {
  search: TranscriptSearch;
  /** Columns the bar may use. */
  width: number;
  inputRef: RefObject<InputRenderable | null>;
  onQuery: (query: string) => void;
}): ReactNode {
  const theme = useTheme();
  const counter = matchCounter(search.index, search.matches.length);
  const hint = `${actionLabel("searchOlder")} older · ${actionLabel("searchNewer")} newer · ${actionLabel("searchClose")} close`;
  const current = search.current;
  // The match line goes under the field, past the label.
  const snippetWidth = Math.max(1, width - LABEL.length - 2);
  return (
    <box flexDirection="column" width="100%" flexShrink={0} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text fg={theme.colors.primary} wrapMode="none" flexShrink={0}><b>{LABEL}</b></text>
        <input
          ref={inputRef}
          focused
          flexGrow={1}
          flexShrink={1}
          value={search.query}
          placeholder="Search the transcript"
          placeholderColor={theme.colors.mutedForeground}
          textColor={theme.colors.foreground}
          focusedTextColor={theme.colors.foreground}
          onInput={onQuery}
        />
        <text height={1} wrapMode="none" flexShrink={0}>
          <span fg={search.query && !current ? theme.colors.error : theme.colors.accent}>{`  ${counter}`}</span>
          <span fg={theme.colors.mutedForeground}>{`  ${hint}`}</span>
        </text>
      </box>
      <text height={1} wrapMode="none" flexShrink={0} paddingLeft={LABEL.length}>
        {current ? <MatchLine match={current} width={snippetWidth} /> : <span fg={theme.colors.mutedForeground}>{search.query ? "No matches" : " "}</span>}
      </text>
    </box>
  );
}

function MatchLine({ match, width }: { match: NonNullable<TranscriptSearch["current"]>; width: number }): ReactNode {
  const theme = useTheme();
  const snippet = matchSnippet(match, width);
  return (
    <>
      <span fg={theme.colors.mutedForeground}>{snippet.before}</span>
      <span fg={theme.colors.warningForeground} bg={theme.colors.warning}><b>{snippet.match}</b></span>
      <span fg={theme.colors.mutedForeground}>{snippet.after}</span>
    </>
  );
}
