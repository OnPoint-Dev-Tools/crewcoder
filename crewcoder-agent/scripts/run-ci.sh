#!/usr/bin/env bash
set -uo pipefail

if [[ -z "${CREWCODER_PROMPT:-}" ]]; then
  echo "CREWCODER_PROMPT is required." >&2
  exit 1
fi

crewcoder_bin="${CREWCODER_BIN:-}"
if [[ -z "$crewcoder_bin" ]]; then
  crewcoder_bin="${CREWCODER_SOURCE_BIN:-}"
fi
if [[ -z "$crewcoder_bin" ]]; then
  echo "CREWCODER_BIN or CREWCODER_SOURCE_BIN is required." >&2
  exit 1
fi

args=(run --ci --approval "${CREWCODER_APPROVAL:-never}")
[[ -n "${CREWCODER_PROVIDER:-}" ]] && args+=(--provider "$CREWCODER_PROVIDER")
[[ -n "${CREWCODER_MODEL:-}" ]] && args+=(--model "$CREWCODER_MODEL")
[[ -n "${CREWCODER_EFFORT:-}" ]] && args+=(--effort "$CREWCODER_EFFORT")
[[ -n "${CREWCODER_BUDGET:-}" ]] && args+=(--budget "$CREWCODER_BUDGET")

set +e
summary="$("$crewcoder_bin" "${args[@]}" "$CREWCODER_PROMPT")"
status=$?
set -e

printf '%s\n' "$summary"

if [[ -n "${CREWCODER_SUMMARY_PATH:-}" ]]; then
  mkdir -p "$(dirname "$CREWCODER_SUMMARY_PATH")"
  printf '%s\n' "$summary" > "$CREWCODER_SUMMARY_PATH"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'summary=%s\n' "$summary" >> "$GITHUB_OUTPUT"
fi

exit "$status"
