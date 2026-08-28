#!/usr/bin/env bash

archive=${1:?}
member=${2:?}
output=${3:?}

[ -f "$archive" ] || {
  printf 'Archive not found: %s\n' "$archive" >&2
  exit 1
}
[[ "$member" =~ ^var/php-darwin/php_[0-9]+\.[0-9]+-(nts|zts)-(debug|release)\+darwin_(arm64|x86_64)\.json$ ]] || {
  printf 'Unsafe metadata member: %s\n' "$member" >&2
  exit 1
}

tar --ignore-zeros -xOf "$archive" "$member" > "$output"
[ -s "$output" ]
