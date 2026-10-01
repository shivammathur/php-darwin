#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../../lib/lib.sh"

version=${1:-8.6}
php_darwin_validate_channel "$version" nightly || exit 1

work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-nightly-test.XXXXXX") || \
  php_darwin_die 'could not create nightly update test fixtures'
trap 'rm -rf "$work_dir"' EXIT
tap_path="$work_dir/homebrew-php"
formula_dir="$tap_path/Formula"
extensions_path="$work_dir/homebrew-extensions"
manifest="$work_dir/php-$version-manifest.json"
assets_jsonl="$work_dir/assets.jsonl"
output="$work_dir/github-output"
current=0123456789abcdef0123456789abcdef01234567
previous=89abcdef0123456789abcdef0123456789abcdef
mkdir -p "$formula_dir" "$extensions_path/Abstract" "$extensions_path/Formula" || \
  php_darwin_die 'could not create the formula fixture directories'
printf 'shared fixture\n' > "$extensions_path/Abstract/abstract-php-extension.rb" || \
  php_darwin_die 'could not write the shared extension fixture'
printf 'xdebug fixture\n' > "$extensions_path/Formula/xdebug@$version.rb" || \
  php_darwin_die 'could not write the Xdebug fixture'
printf 'pcov fixture\n' > "$extensions_path/Formula/pcov@$version.rb" || \
  php_darwin_die 'could not write the PCOV fixture'
git -C "$extensions_path" init -q || exit 1
git -C "$extensions_path" add . || exit 1
git -C "$extensions_path" -c user.name=fixture -c user.email=fixture@example.invalid \
  -c commit.gpgsign=false commit -qm fixture || exit 1
extensions_commit=$(git -C "$extensions_path" rev-parse HEAD) || exit 1
current_extensions=$(HOMEBREW_EXTENSIONS_PATH="$extensions_path" \
  bash "$script_dir/../../build/extensions-source-hash.sh" "$version") || \
  php_darwin_die 'could not hash the nightly extension fixtures'

write_formulae() {
  local commit=$1
  local formula
  local formula_commit

  while read -r build ts; do
    formula=$(php_darwin_requested_formula "$version" "$build" "$ts") || return 1
    formula_commit=$commit
    [ "$formula" != "php@$version-debug-zts" ] || formula_commit=${MISMATCH_COMMIT:-$commit}
    printf 'class Fixture < Formula\n  url "https://github.com/php/php-src/archive/%s.tar.gz?commit=%s"\nend\n' \
      "$formula_commit" "$formula_commit" > "$formula_dir/$formula.rb" || \
      php_darwin_die "could not write the $formula fixture"
  done < <(php_darwin_configured_variants)
}

write_manifest() {
  local commit=$1
  local extensions_hash=${2:-$current_extensions}
  : > "$assets_jsonl" || php_darwin_die 'could not reset the nightly asset fixtures'
  while read -r build ts; do
    while IFS= read -r arch; do
      jq -cn --arg architecture "$arch" --arg build "$build" \
        --arg name "$(php_darwin_asset "$version" "$build" "$ts" "$arch")" \
        --arg thread_safety "$ts" --arg sha256 "$(printf '%064d' 0)" \
        --argjson minimum_macos "$(php_darwin_platform_value "$arch" minimum_macos)" \
        '{architecture:$architecture,build:$build,bytes:1,minimum_macos:$minimum_macos,
          name:$name,sha256:$sha256,thread_safety:$thread_safety}' >> "$assets_jsonl" || \
        php_darwin_die 'could not write a nightly asset fixture'
    done < <(php_darwin_platform_arches)
  done < <(php_darwin_configured_variants)
  jq -s --arg commit "$commit" --arg extensions_hash "$extensions_hash" \
    --arg version "$version" --arg extensions_commit "$extensions_commit" \
    --arg homebrew_commit "$php_commit" \
    --arg source_hash "$(HOMEBREW_PHP_PATH="$tap_path" bash "$script_dir/../../lib/source-hash.sh" "$version")" '
    {schema:1,php_version:$version,php_semver:($version + ".0"),php_src_commit:$commit,
     extensions_source_hash:$extensions_hash,homebrew_php_commit:$homebrew_commit,
     homebrew_extensions_commit:$extensions_commit,
     source_hash:$source_hash,assets:.}
  ' "$assets_jsonl" > "$manifest" || php_darwin_die 'could not write the nightly manifest fixture'
  node "$script_dir/../helpers/add-package-inputs.cjs" "$manifest" "$extensions_path" || exit 1
}

run_gate() {
  local expected=$1
  local force=${2:-false}
  local expected_architectures=${3:-arm64 x86_64}

  : > "$output" || php_darwin_die 'could not reset the nightly output fixture'
  FORCE="$force" GITHUB_OUTPUT="$output" HOMEBREW_EXTENSIONS_PATH="$extensions_path" \
    HOMEBREW_PHP_PATH="$tap_path" \
    PHP_DARWIN_MANIFEST_PATH="$manifest" PHP_VERSION="$version" \
    bash "$script_dir/../../release/update-nightly.sh" >/dev/null || php_darwin_die 'nightly update gate failed'
  grep -Fxq "build=$expected" "$output" || \
    php_darwin_die "nightly update gate did not return build=$expected"
  grep -Fxq "php-src-commit=$current" "$output" || \
    php_darwin_die 'nightly update gate returned the wrong PHP source commit'
  grep -Fxq "php-version=$version" "$output" || \
    php_darwin_die 'nightly update gate returned the wrong configured version'
  grep -Fxq "architectures=$expected_architectures" "$output" || \
    php_darwin_die "nightly update gate did not return architectures=$expected_architectures"
  FORCE="$force" PUBLISH=true CHANNEL=nightly GITHUB_OUTPUT="$output" \
    HOMEBREW_EXTENSIONS_PATH="$extensions_path" HOMEBREW_PHP_PATH="$tap_path" \
    PHP_DARWIN_MANIFEST_PATH="$manifest" PHP_VERSION="$version" \
    bash "$script_dir/../../build/check-build-freshness.sh" >/dev/null || php_darwin_die 'queued nightly freshness check failed'
  grep -Fxq "build-required=$expected" "$output" || \
    php_darwin_die 'queued nightly freshness did not match the published inputs'
}

write_formulae "$current"
git -C "$tap_path" init -q || exit 1
git -C "$tap_path" add . || exit 1
git -C "$tap_path" -c user.name=fixture -c user.email=fixture@example.invalid \
  -c commit.gpgsign=false commit -qm fixture || exit 1
php_commit=$(git -C "$tap_path" rev-parse HEAD) || exit 1
[ "$(HOMEBREW_PHP_PATH="$tap_path" bash "$script_dir/../../build/php-src-commit.sh" "$version")" = "$current" ] || \
  php_darwin_die 'PHP source commit resolver returned the wrong commit'
write_manifest "$current"
run_gate false
printf '  revision 1\n' >> "$formula_dir/php@$version.rb" || exit 1
run_gate true
write_formulae "$current"
run_gate false
jq '.assets |= map(select(.architecture == "arm64"))' "$manifest" > "$manifest.arm" || \
  php_darwin_die 'could not write the ARM64-only nightly manifest fixture'
mv "$manifest.arm" "$manifest" || php_darwin_die 'could not install the ARM64-only nightly manifest fixture'
run_gate true false x86_64
grep -Fxq "homebrew-php-commit=$php_commit" "$output" || \
  php_darwin_die 'nightly platform completion did not pin the published homebrew-php commit'
grep -Fxq "homebrew-extensions-commit=$extensions_commit" "$output" || \
  php_darwin_die 'nightly platform completion did not pin the published extension commit'
write_manifest "$previous"
jq '.assets |= map(select(.architecture == "arm64"))' "$manifest" > "$manifest.arm" || \
  php_darwin_die 'could not write the stale ARM64-only nightly manifest fixture'
mv "$manifest.arm" "$manifest" || \
  php_darwin_die 'could not install the stale ARM64-only nightly manifest fixture'
run_gate true
grep -Fxq 'homebrew-php-commit=' "$output" || \
  php_darwin_die 'changed nightly source retained a stale homebrew-php commit'
grep -Fxq 'homebrew-extensions-commit=' "$output" || \
  php_darwin_die 'changed nightly source retained a stale extension commit'
write_manifest "$current" "$(printf '%064d' 2)"
run_gate true
write_manifest "$current"
run_gate true true

jq 'del(.php_src_commit)' "$manifest" > "$manifest.old" || \
  php_darwin_die 'could not write the legacy manifest fixture'
mv "$manifest.old" "$manifest" || php_darwin_die 'could not replace the nightly manifest fixture'
run_gate true

MISMATCH_COMMIT="$previous" write_formulae "$current"
source_status=0
HOMEBREW_PHP_PATH="$tap_path" bash "$script_dir/../../build/php-src-commit.sh" "$version" \
  > "$work_dir/source-output" 2> "$work_dir/source-errors" || source_status=$?
[ "$source_status" -eq 75 ] || php_darwin_die 'disagreeing formulae did not return the temporary mismatch status'
[ ! -s "$work_dir/source-output" ] || php_darwin_die 'disagreeing formulae returned a usable source commit'
grep -Fq "php@$version-debug-zts: $previous" "$work_dir/source-errors" || \
  php_darwin_die 'source mismatch diagnostics did not identify the stale variant'
grep -Fq "php@$version: $current" "$work_dir/source-errors" || \
  php_darwin_die 'source mismatch diagnostics did not identify the current variant'

for force in false true; do
  : > "$output"
  : > "$work_dir/summary"
  # Deferral must happen before consulting extensions or the published manifest.
  FORCE="$force" GITHUB_OUTPUT="$output" GITHUB_STEP_SUMMARY="$work_dir/summary" \
    HOMEBREW_PHP_COMMIT='' HOMEBREW_PHP_PATH="$tap_path" \
    HOMEBREW_EXTENSIONS_PATH="$work_dir/missing-extensions" \
    PHP_DARWIN_MANIFEST_PATH="$work_dir/missing-manifest" PHP_VERSION="$version" \
    bash "$script_dir/../../release/update-nightly.sh" > "$work_dir/gate-log" 2>&1 || \
    php_darwin_die 'nightly gate failed instead of deferring a mixed tap'
  printf 'build=false\ndeferred=true\nphp-version=%s\n' "$version" > "$work_dir/expected-output"
  cmp "$output" "$work_dir/expected-output" || php_darwin_die 'deferred nightly gate emitted unsafe build outputs'
  grep -Fq "Deferring PHP $version nightly" "$work_dir/summary" || \
    php_darwin_die 'deferred nightly gate did not explain the skip in its summary'
done

assert_gate_error() {
  local pinned_commit=${1:-}
  : > "$output"
  if FORCE=false GITHUB_OUTPUT="$output" HOMEBREW_PHP_COMMIT="$pinned_commit" \
    HOMEBREW_PHP_PATH="$tap_path" HOMEBREW_EXTENSIONS_PATH="$extensions_path" \
    PHP_DARWIN_MANIFEST_PATH="$manifest" PHP_VERSION="$version" \
    bash "$script_dir/../../release/update-nightly.sh" > "$work_dir/gate-log" 2>&1; then
    php_darwin_die 'nightly gate accepted an invalid or explicitly pinned inconsistent tap'
  fi
  [ ! -s "$output" ] || php_darwin_die 'failed nightly gate emitted build or deferral outputs'
}
assert_gate_error "$php_commit"

# A subsequent aligned snapshot resumes normal freshness decisions.
write_formulae "$current"
write_manifest "$previous"
run_gate true
write_manifest "$current"
run_gate false

# Malformed URLs must not be mistaken for a transient mismatch, even if other
# formulae disagree at the same time.
MISMATCH_COMMIT="$previous" write_formulae "$current"
printf 'class Fixture < Formula\n  url "https://github.com/php/php-src/archive/%s.tar.gz?commit=%s"\nend\n' \
  "$current" "$previous" > "$formula_dir/php@$version.rb" || \
  php_darwin_die 'could not write the invalid PHP source URL fixture'
if HOMEBREW_PHP_PATH="$tap_path" bash "$script_dir/../../build/php-src-commit.sh" "$version" >/dev/null 2>&1; then
  php_darwin_die 'PHP source commit resolver accepted different path and query commits'
fi
assert_gate_error

write_formulae "$current"
rm "$formula_dir/php@$version-debug.rb" || exit 1
assert_gate_error

write_formulae "$current"
cat "$formula_dir/php@$version-debug.rb" >> "$formula_dir/php@$version.rb" || exit 1
assert_gate_error

printf 'PHP %s nightly update validation passed\n' "$version"
