#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-nightly-test.XXXXXX") || \
  php_darwin_die 'could not create nightly update test fixtures'
trap 'rm -rf "$work_dir"' EXIT
tap_path="$work_dir/homebrew-php"
formula_dir="$tap_path/Formula"
manifest="$work_dir/php-8.6-manifest.json"
assets_jsonl="$work_dir/assets.jsonl"
output="$work_dir/github-output"
current=0123456789abcdef0123456789abcdef01234567
previous=89abcdef0123456789abcdef0123456789abcdef
mkdir -p "$formula_dir" || php_darwin_die 'could not create the formula fixture directory'

write_formulae() {
  local commit=$1
  local formula
  local formula_commit

  for build in release debug; do
    for ts in nts zts; do
      formula=$(php_darwin_requested_formula 8.6 "$build" "$ts")
      formula_commit=$commit
      [ "$formula" != php@8.6-debug-zts ] || formula_commit=${MISMATCH_COMMIT:-$commit}
      printf 'class Fixture < Formula\n  url "https://github.com/php/php-src/archive/%s.tar.gz?commit=%s"\nend\n' \
        "$formula_commit" "$formula_commit" > "$formula_dir/$formula.rb" || \
        php_darwin_die "could not write the $formula fixture"
    done
  done
}

write_manifest() {
  local commit=$1
  : > "$assets_jsonl" || php_darwin_die 'could not reset the nightly asset fixtures'
  while read -r build ts extra; do
    [ -n "$build" ] || continue
    case "$build" in \#*) continue ;; esac
    [ -z "$extra" ] || php_darwin_die "invalid configured variant: $build $ts $extra"
    while IFS= read -r arch; do
      jq -cn --arg architecture "$arch" --arg build "$build" \
        --arg name "$(php_darwin_asset 8.6 "$build" "$ts" "$arch")" \
        --arg thread_safety "$ts" --arg sha256 "$(printf '%064d' 0)" \
        --argjson minimum_macos "$(jq -r --arg arch "$arch" '.[$arch].minimum_macos' \
          "$script_dir/../conf/platforms.json")" \
        '{architecture:$architecture,build:$build,bytes:1,minimum_macos:$minimum_macos,
          name:$name,sha256:$sha256,thread_safety:$thread_safety}' >> "$assets_jsonl" || \
        php_darwin_die 'could not write a nightly asset fixture'
    done < <(jq -r 'keys[]' "$script_dir/../conf/platforms.json")
  done < "$script_dir/../conf/variants"
  jq -s --arg commit "$commit" --arg homebrew_commit 0123456789abcdef0123456789abcdef01234567 \
    --arg source_hash "$(printf '%064d' 1)" '
    {schema:1,php_version:"8.6",php_semver:"8.6.0",php_src_commit:$commit,
     homebrew_php_commit:$homebrew_commit,source_hash:$source_hash,assets:.}
  ' "$assets_jsonl" > "$manifest" || php_darwin_die 'could not write the nightly manifest fixture'
}

run_gate() {
  local expected=$1
  local force=${2:-false}

  : > "$output" || php_darwin_die 'could not reset the nightly output fixture'
  FORCE="$force" GITHUB_OUTPUT="$output" HOMEBREW_PHP_PATH="$tap_path" \
    PHP_DARWIN_MANIFEST_PATH="$manifest" PHP_VERSION=8.6 \
    bash "$script_dir/update-nightly.sh" >/dev/null || php_darwin_die 'nightly update gate failed'
  grep -Fxq "build=$expected" "$output" || \
    php_darwin_die "nightly update gate did not return build=$expected"
  grep -Fxq "php-src-commit=$current" "$output" || \
    php_darwin_die 'nightly update gate returned the wrong PHP source commit'
  grep -Fxq 'php-version=8.6' "$output" || \
    php_darwin_die 'nightly update gate returned the wrong configured version'
}

write_formulae "$current"
[ "$(HOMEBREW_PHP_PATH="$tap_path" bash "$script_dir/php-src-commit.sh" 8.6)" = "$current" ] || \
  php_darwin_die 'PHP source commit resolver returned the wrong commit'
write_manifest "$current"
run_gate false
write_manifest "$previous"
run_gate true
write_manifest "$current"
run_gate true true

jq 'del(.php_src_commit)' "$manifest" > "$manifest.old" || \
  php_darwin_die 'could not write the legacy manifest fixture'
mv "$manifest.old" "$manifest" || php_darwin_die 'could not replace the nightly manifest fixture'
run_gate true

MISMATCH_COMMIT="$previous" write_formulae "$current"
if HOMEBREW_PHP_PATH="$tap_path" bash "$script_dir/php-src-commit.sh" 8.6 >/dev/null 2>&1; then
  php_darwin_die 'PHP source commit resolver accepted disagreeing formulae'
fi

write_formulae "$current"
printf 'class Fixture < Formula\n  url "https://github.com/php/php-src/archive/%s.tar.gz?commit=%s"\nend\n' \
  "$current" "$previous" > "$formula_dir/php@8.6.rb" || \
  php_darwin_die 'could not write the invalid PHP source URL fixture'
if HOMEBREW_PHP_PATH="$tap_path" bash "$script_dir/php-src-commit.sh" 8.6 >/dev/null 2>&1; then
  php_darwin_die 'PHP source commit resolver accepted different path and query commits'
fi

printf 'Nightly update validation passed\n'
