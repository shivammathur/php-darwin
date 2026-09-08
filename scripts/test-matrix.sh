#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-matrix-test.XXXXXX") || \
  php_darwin_die 'could not create the matrix test directory'
trap 'rm -rf "$work_dir"' EXIT

full_output="$work_dir/full.txt"
GITHUB_OUTPUT="$full_output" PHP_VERSION=8.5 CHANNEL=stable BUILDS='debug release' \
  TS='nts zts' ARCHITECTURES='arm64 x86_64' PUBLISH=true bash "$script_dir/get-matrix.sh" || \
  php_darwin_die 'full workflow matrix generation failed'
full_build=$(sed -n 's/^build-matrix=//p' "$full_output")
full_test=$(sed -n 's/^test-matrix=//p' "$full_output")
jq -e '
  .include == [
    {php:"8.5",arch:"arm64",runner:"macos-14"},
    {php:"8.5",arch:"x86_64",runner:"macos-15-intel"}
  ]
' <<< "$full_build" >/dev/null || php_darwin_die 'full build matrix does not reuse one runner per architecture'
jq -e '
  .include == [
    {php:"8.5",arch:"arm64",runner:"macos-14"},
    {php:"8.5",arch:"arm64",runner:"macos-15"},
    {php:"8.5",arch:"arm64",runner:"macos-26"},
    {php:"8.5",arch:"arm64",runner:"macos-latest"},
    {php:"8.5",arch:"x86_64",runner:"macos-15-intel"},
    {php:"8.5",arch:"x86_64",runner:"macos-26-intel"}
  ]
' <<< "$full_test" >/dev/null || php_darwin_die 'full test matrix does not cover every free macOS runner'

target_output="$work_dir/target.txt"
GITHUB_OUTPUT="$target_output" PHP_VERSION=5.6 CHANNEL=stable BUILDS=debug TS=nts \
  ARCHITECTURES=x86_64 PUBLISH=false bash "$script_dir/get-matrix.sh" || \
  php_darwin_die 'targeted workflow matrix generation failed'
target_build=$(sed -n 's/^build-matrix=//p' "$target_output")
target_test=$(sed -n 's/^test-matrix=//p' "$target_output")
jq -e '.include == [{php:"5.6",arch:"x86_64",runner:"macos-15-intel"}]' \
  <<< "$target_build" >/dev/null || php_darwin_die 'targeted build matrix is invalid'
jq -e '
  .include == [
    {php:"5.6",arch:"x86_64",runner:"macos-15-intel"},
    {php:"5.6",arch:"x86_64",runner:"macos-26-intel"}
  ]
' <<< "$target_test" >/dev/null || php_darwin_die 'targeted test matrix is invalid'

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
macos-15-intel x86_64
macos-26-intel x86_64
RUNNERS

printf 'Workflow matrix validation passed (2 builds, 6 free-runner tests)\n'
