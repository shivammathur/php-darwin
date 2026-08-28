#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

fixture_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-tap-test.XXXXXX")
trap 'rm -rf "$fixture_dir"' EXIT
source_tap="$fixture_dir/source"
cached_tap="$fixture_dir/cache"
validation_log="$fixture_dir/validation.log"
snapshot_validation_log="$fixture_dir/snapshot-validation.log"
repository=$(php_darwin_package_config tap_repository)
branch=$(php_darwin_package_config tap_branch)

git init -q -b "$branch" "$source_tap" || php_darwin_die 'could not create the tap source fixture'
mkdir -p "$source_tap/Formula" || php_darwin_die 'could not create the tap formula fixtures'
for formula in php php-debug php-zts php-debug-zts; do
  printf 'class Fixture%s\n' "$formula" > "$source_tap/Formula/$formula.rb" || \
    php_darwin_die 'could not write the tap formula fixtures'
done
git -C "$source_tap" add Formula || php_darwin_die 'could not stage the tap source fixture'
git -C "$source_tap" -c user.name=php-darwin -c user.email=php-darwin@example.invalid \
  commit -q -m fixture || php_darwin_die 'could not commit the tap source fixture'
source_commit=$(git -C "$source_tap" rev-parse HEAD) || php_darwin_die 'could not resolve the tap fixture commit'
source_hash=$(HOMEBREW_PHP_PATH="$source_tap" bash "$script_dir/source-hash.sh" 8.5) || \
  php_darwin_die 'could not hash the tap source fixture'

bash "$script_dir/create-tap-snapshot.sh" "$source_tap" "$source_commit" "$repository" \
  "$branch" "$cached_tap" || php_darwin_die 'could not create the cached tap fixture'
[ "$(git -C "$cached_tap" rev-parse --is-shallow-repository)" = true ] || \
  php_darwin_die 'cached tap fixture is not shallow'
[ "$(git -C "$cached_tap" remote get-url origin)" = "$repository" ] || \
  php_darwin_die 'cached tap fixture has the wrong update origin'
[ "$(bash "$script_dir/validate-tap.sh" "$cached_tap" 8.5 "$source_hash" \
  "$repository" "$source_commit" "$branch")" = "$source_hash" ] || \
  php_darwin_die 'cached tap fixture validation failed'

printf 'corrupt fixture\n' >> "$cached_tap/Formula/php.rb" || php_darwin_die 'could not corrupt the tap fixture'
if bash "$script_dir/validate-tap.sh" "$cached_tap" 8.5 "$source_hash" \
  "$repository" > /dev/null 2> "$validation_log"; then
  php_darwin_die 'cached tap validation accepted a changed formula'
fi
grep -Fxq 'Homebrew tap formula hash mismatch' "$validation_log" || \
  php_darwin_die 'cached tap validation did not explain the formula mismatch'
if bash "$script_dir/validate-tap.sh" "$cached_tap" 8.5 '' \
  "$repository" "$source_commit" "$branch" > /dev/null 2> "$snapshot_validation_log"; then
  php_darwin_die 'cached tap validation accepted a changed snapshot'
fi
grep -Fxq 'Homebrew tap snapshot has changed files' "$snapshot_validation_log" || \
  php_darwin_die 'cached tap validation did not explain the changed snapshot'

printf 'Homebrew tap snapshot validation passed\n'
