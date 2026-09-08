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
member_arch=${BASH_REMATCH[3]}
if [ "$member_arch" != arm64 ] && \
  { [ "$member_arch" != x86_64 ] || [ "${PHP_DARWIN_BACKEND:-homebrew}" != intel ]; }; then
  printf 'Unsupported metadata architecture: %s\n' "$member_arch" >&2
  exit 1
fi

if ! tar --ignore-zeros -xOf "$archive" "$member" > "$output"; then
  rm -f "$output"
  exit 1
fi
[ -s "$output" ] || {
  rm -f "$output"
  exit 1
}
