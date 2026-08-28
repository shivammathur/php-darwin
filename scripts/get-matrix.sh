#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

php_version=${PHP_VERSION:?}
channel=${CHANNEL:?}
builds=${BUILDS:-debug release}
thread_safety=${TS:-nts zts}
architectures=${ARCHITECTURES:-arm64 x86_64}
publish=${PUBLISH:-false}

php_darwin_validate_channel "$php_version" "$channel"
read -r -a build_values <<< "$builds"
read -r -a ts_values <<< "$thread_safety"
read -r -a arch_values <<< "$architectures"
[ "${#build_values[@]}" -gt 0 ] || php_darwin_die 'at least one build type is required'
[ "${#ts_values[@]}" -gt 0 ] || php_darwin_die 'at least one thread-safety mode is required'
[ "${#arch_values[@]}" -gt 0 ] || php_darwin_die 'at least one architecture is required'

seen_builds=
for build in "${build_values[@]}"; do
  php_darwin_validate_build "$build"
  case " $seen_builds " in *" $build "*) php_darwin_die "duplicate build type: $build" ;; esac
  seen_builds="$seen_builds $build"
done
seen_ts=
for ts in "${ts_values[@]}"; do
  php_darwin_validate_ts "$ts"
  case " $seen_ts " in *" $ts "*) php_darwin_die "duplicate thread-safety mode: $ts" ;; esac
  seen_ts="$seen_ts $ts"
done
seen_arches=
for requested_arch in "${arch_values[@]}"; do
  normalized_arch=$(php_darwin_normalize_arch "$requested_arch")
  case " $seen_arches " in *" $normalized_arch "*) php_darwin_die "duplicate architecture: $normalized_arch" ;; esac
  seen_arches="$seen_arches $normalized_arch"
done
case "$publish" in
  true)
    [ "${#build_values[@]}" -eq 2 ] && [ "${#ts_values[@]}" -eq 2 ] && [ "${#arch_values[@]}" -eq 2 ] || \
      php_darwin_die 'publishing requires the complete build, thread-safety, and architecture matrix'
    ;;
  false) ;;
  *) php_darwin_die "publish must be true or false: $publish" ;;
esac

work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-matrix.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
build_entries_file="$work_dir/build.jsonl"
test_entries_file="$work_dir/test.jsonl"
: > "$build_entries_file"
: > "$test_entries_file"
for requested_arch in "${arch_values[@]}"; do
  arch=$(php_darwin_normalize_arch "$requested_arch")
  runner=$(jq -er --arg arch "$arch" '.[$arch].build_runner' "$script_dir/../conf/platforms.json") || \
    php_darwin_die "build runner is not configured for $arch"
  jq -cn --arg php "$php_version" --arg arch "$arch" --arg runner "$runner" \
    '{php:$php,arch:$arch,runner:$runner}' >> "$build_entries_file"
  test_runners=$(jq -cer --arg arch "$arch" '.[$arch].test_runners' "$script_dir/../conf/platforms.json") || \
    php_darwin_die "test runners are not configured for $arch"
  while IFS= read -r test_runner; do
    jq -cn --arg php "$php_version" --arg arch "$arch" --arg runner "$test_runner" \
      '{php:$php,arch:$arch,runner:$runner}' >> "$test_entries_file"
  done < <(jq -r '.[]' <<< "$test_runners")
done

build_matrix=$(jq -c --slurpfile include "$build_entries_file" '.include=$include' "$script_dir/../templates/workflow-matrix.json") || \
  php_darwin_die 'could not create the build matrix'
test_matrix=$(jq -c --slurpfile include "$test_entries_file" '.include=$include' "$script_dir/../templates/workflow-matrix.json") || \
  php_darwin_die 'could not create the test matrix'
printf 'build-matrix=%s\n' "$build_matrix" >> "${GITHUB_OUTPUT:?}" || php_darwin_die 'could not write the build matrix output'
printf 'test-matrix=%s\n' "$test_matrix" >> "${GITHUB_OUTPUT:?}" || php_darwin_die 'could not write the test matrix output'
