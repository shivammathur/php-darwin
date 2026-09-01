#!/usr/bin/env bash

printf '%s\n' "$*" >> "${GH_LOG:?}"
case "${1:-}/${2:-}" in
  release/view)
    [ "${GH_RELEASE_EXISTS:-false}" = true ] && exit 0
    exit 1
    ;;
  release/create|release/delete-asset) exit 0 ;;
  release/download)
    destination=
    previous=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --dir) shift; destination=${1:-} ;;
      esac
      shift
    done
    [ -n "$destination" ] && [ -d "${GH_PREVIOUS_ASSETS:-}" ] || exit 1
    mkdir -p "$destination" || exit 1
    for previous in "${GH_PREVIOUS_ASSETS}"/*; do
      [ -f "$previous" ] || continue
      cp "$previous" "$destination/" || exit 1
    done
    exit 0
    ;;
  release/upload)
    for argument in "$@"; do
      case "${GH_FAIL_UPLOAD_MATCH:-}" in
        '') ;;
        *) case "$argument" in *"$GH_FAIL_UPLOAD_MATCH"*) exit 1 ;; esac ;;
      esac
      case "$argument" in *-manifest.json)
        cp "$argument" "${GH_MANIFEST:?}" || exit 1
        ;;
      */install.sh)
        [ -z "${GH_INSTALLER:-}" ] || cp "$argument" "$GH_INSTALLER" || exit 1
        ;;
      esac
    done
    exit 0
    ;;
esac
printf 'Unexpected gh fixture command: %s\n' "$*" >&2
exit 1
