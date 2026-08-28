#!/usr/bin/env bash

printf '%s\n' "$*" >> "${GH_LOG:?}"
case "${1:-}/${2:-}" in
  release/view) exit 1 ;;
  release/create) exit 0 ;;
  release/upload)
    for argument in "$@"; do
      case "$argument" in *-manifest.json)
        cp "$argument" "${GH_MANIFEST:?}" || exit 1
        ;;
      esac
    done
    exit 0
    ;;
esac
printf 'Unexpected gh fixture command: %s\n' "$*" >&2
exit 1
