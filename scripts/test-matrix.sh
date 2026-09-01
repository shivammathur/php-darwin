#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-matrix-test.XXXXXX") || \
  php_darwin_die 'could not create the matrix test directory'
trap 'rm -rf "$work_dir"' EXIT

full_output="$work_dir/full.txt"
GITHUB_OUTPUT="$full_output" PHP_VERSION=8.5 CHANNEL=stable BUILDS='debug release' \
  TS='nts zts' ARCHITECTURES=arm64 PUBLISH=true bash "$script_dir/get-matrix.sh" || \
  php_darwin_die 'full workflow matrix generation failed'
full_build=$(sed -n 's/^build-matrix=//p' "$full_output")
full_test=$(sed -n 's/^test-matrix=//p' "$full_output")
jq -e '
  .include == [
    {php:"8.5",arch:"arm64",runner:"macos-14"}
  ]
' <<< "$full_build" >/dev/null || php_darwin_die 'full build matrix does not reuse one ARM64 runner'
jq -e '
  .include == [
    {php:"8.5",arch:"arm64",runner:"macos-14"},
    {php:"8.5",arch:"arm64",runner:"macos-15"},
    {php:"8.5",arch:"arm64",runner:"macos-26"},
    {php:"8.5",arch:"arm64",runner:"macos-latest"}
  ]
' <<< "$full_test" >/dev/null || php_darwin_die 'full test matrix does not cover every free macOS runner'

target_output="$work_dir/target.txt"
GITHUB_OUTPUT="$target_output" PHP_VERSION=5.6 CHANNEL=stable BUILDS=debug TS=nts \
  ARCHITECTURES=arm64 PUBLISH=false bash "$script_dir/get-matrix.sh" || \
  php_darwin_die 'targeted workflow matrix generation failed'
target_build=$(sed -n 's/^build-matrix=//p' "$target_output")
target_test=$(sed -n 's/^test-matrix=//p' "$target_output")
jq -e '.include == [{php:"5.6",arch:"arm64",runner:"macos-14"}]' \
  <<< "$target_build" >/dev/null || php_darwin_die 'targeted build matrix is invalid'
jq -e '
  .include == [
    {php:"5.6",arch:"arm64",runner:"macos-14"},
    {php:"5.6",arch:"arm64",runner:"macos-15"},
    {php:"5.6",arch:"arm64",runner:"macos-26"},
    {php:"5.6",arch:"arm64",runner:"macos-latest"}
  ]
' <<< "$target_test" >/dev/null || php_darwin_die 'targeted test matrix is invalid'

unsupported_output="$work_dir/unsupported.txt"
if GITHUB_OUTPUT="$unsupported_output" PHP_VERSION=5.6 CHANNEL=stable BUILDS=debug TS=nts \
  ARCHITECTURES=x86_64 PUBLISH=false bash "$script_dir/get-matrix.sh" >/dev/null 2>&1; then
  php_darwin_die 'workflow matrix accepted an Intel architecture'
fi

while read -r runner expected_arch extra; do
  [ -n "$runner" ] || continue
  [ -z "$extra" ] || php_darwin_die "invalid compatibility-test fixture: $runner $expected_arch $extra"
  runner_output="$work_dir/runner-$runner.txt"
  RUNNER="$runner" GITHUB_OUTPUT="$runner_output" bash "$script_dir/get-test-target.sh" || \
    php_darwin_die "could not resolve compatibility-test runner $runner"
  [ "$(sed -n 's/^arch=//p' "$runner_output")" = "$expected_arch" ] || \
    php_darwin_die "compatibility-test runner $runner resolved to the wrong architecture"
done <<'RUNNERS'
macos-14 arm64
macos-15 arm64
macos-26 arm64
macos-latest arm64
RUNNERS

printf 'Workflow matrix validation passed (1 ARM64 build, 4 free-runner tests)\n'
