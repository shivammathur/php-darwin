#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

fixture_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-tap-test.XXXXXX")
trap 'rm -rf "$fixture_dir"' EXIT
source_tap="$fixture_dir/source"
cached_tap="$fixture_dir/cache"
new_cached_tap="$fixture_dir/new-cache"
unmarked_tap="$fixture_dir/unmarked-cache"
legacy_tap="$fixture_dir/legacy-cache"
status_failure_tap="$fixture_dir/status-failure-cache"
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
[ "$(git -C "$cached_tap" config --get php-darwin.snapshot-commit)" = "$source_commit" ] || \
  php_darwin_die 'cached tap fixture omitted its snapshot provenance'
[ "$(bash "$script_dir/validate-tap.sh" "$cached_tap" 8.5 "$source_hash" \
  "$repository" "$source_commit" "$branch")" = "$source_hash" ] || \
  php_darwin_die 'cached tap fixture validation failed'
[ "$(bash "$script_dir/tap-action.sh" "$cached_tap" "$cached_tap" 8.5 \
  "$source_hash" "$repository" "$source_commit" "$branch")" = keep ] || \
  php_darwin_die 'an exact installed tap snapshot was not kept'

printf 'class NewerFixture\n' > "$source_tap/Formula/php.rb" || \
  php_darwin_die 'could not update the tap formula fixture'
git -C "$source_tap" add Formula/php.rb || php_darwin_die 'could not stage the newer tap fixture'
GIT_AUTHOR_DATE=2030-01-01T00:00:00Z GIT_COMMITTER_DATE=2030-01-01T00:00:00Z \
  git -C "$source_tap" -c user.name=php-darwin -c user.email=php-darwin@example.invalid \
  commit -q -m newer-fixture || php_darwin_die 'could not commit the newer tap fixture'
new_source_commit=$(git -C "$source_tap" rev-parse HEAD) || \
  php_darwin_die 'could not resolve the newer tap fixture commit'
new_source_hash=$(HOMEBREW_PHP_PATH="$source_tap" bash "$script_dir/source-hash.sh" 8.5) || \
  php_darwin_die 'could not hash the newer tap source fixture'
bash "$script_dir/create-tap-snapshot.sh" "$source_tap" "$new_source_commit" "$repository" \
  "$branch" "$new_cached_tap" || php_darwin_die 'could not create the newer cached tap fixture'
[ "$(bash "$script_dir/tap-action.sh" "$cached_tap" "$new_cached_tap" 8.5 \
  "$new_source_hash" "$repository" "$new_source_commit" "$branch")" = replace ] || \
  php_darwin_die 'an older cache snapshot was not advanced to the newer cache snapshot'
if bash "$script_dir/tap-action.sh" "$new_cached_tap" "$cached_tap" 8.5 \
  "$source_hash" "$repository" "$source_commit" "$branch" >/dev/null 2> "$validation_log"; then
  php_darwin_die 'tap selection downgraded a newer cache snapshot'
fi
grep -Fxq 'Homebrew tap formula hash mismatch and the cached snapshot is not newer' "$validation_log" || \
  php_darwin_die 'tap selection did not explain the refused snapshot downgrade'
cp -R "$cached_tap" "$legacy_tap" || php_darwin_die 'could not create a legacy tap fixture'
git -C "$legacy_tap" config --unset php-darwin.snapshot-commit || \
  php_darwin_die 'could not remove the legacy tap snapshot provenance fixture'
[ "$(bash "$script_dir/tap-action.sh" "$legacy_tap" "$new_cached_tap" 8.5 \
  "$new_source_hash" "$repository" "$new_source_commit" "$branch")" = replace ] || \
  php_darwin_die 'an older legacy cache snapshot was not advanced'
missing_formula_hash=$(printf '0%.0s' {1..64})
[ "$(bash "$script_dir/tap-action.sh" "$legacy_tap" "$new_cached_tap" 8.6 \
  "$missing_formula_hash" "$repository" "$new_source_commit" "$branch")" = replace ] || \
  php_darwin_die 'a legacy snapshot without the new formula was not advanced'
git clone -q "$source_tap" "$unmarked_tap" || php_darwin_die 'could not create an unmarked tap fixture'
git -C "$unmarked_tap" checkout -q -B "$branch" "$source_commit" || \
  php_darwin_die 'could not select the older unmarked tap fixture'
git -C "$unmarked_tap" remote set-url origin "$repository" || \
  php_darwin_die 'could not configure the unmarked tap origin fixture'
git -C "$unmarked_tap" update-ref "refs/remotes/origin/$branch" "$source_commit" || \
  php_darwin_die 'could not configure the unmarked tap branch fixture'
if bash "$script_dir/tap-action.sh" "$unmarked_tap" "$new_cached_tap" 8.5 \
  "$new_source_hash" "$repository" "$new_source_commit" "$branch" >/dev/null 2> "$validation_log"; then
  php_darwin_die 'tap selection replaced an unmarked Homebrew checkout'
fi
grep -Fxq 'Homebrew tap formula hash mismatch on an unmarked checkout' "$validation_log" || \
  php_darwin_die 'tap selection did not explain the unmarked checkout mismatch'

cp -R "$cached_tap" "$status_failure_tap" || \
  php_darwin_die 'could not create the Git status failure fixture'
printf 'x' > "$status_failure_tap/.git/index" || php_darwin_die 'could not corrupt the Git index fixture'
if bash "$script_dir/validate-tap.sh" "$status_failure_tap" 8.5 "$source_hash" \
  "$repository" > /dev/null 2> "$validation_log"; then
  php_darwin_die 'cached tap validation treated a failed Git status as clean'
fi
grep -Fxq 'Could not inspect Homebrew tap status' "$validation_log" || \
  php_darwin_die 'cached tap validation did not explain the failed Git status'

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
grep -Fxq 'Homebrew tap snapshot has changed or untracked files' "$snapshot_validation_log" || \
  php_darwin_die 'cached tap validation did not explain the changed snapshot'
git -C "$cached_tap" checkout -q -- Formula/php.rb || \
  php_darwin_die 'could not restore the changed tap fixture'
printf 'class InjectedFormula\n' > "$cached_tap/Formula/injected.rb" || \
  php_darwin_die 'could not add the untracked tap fixture'
if bash "$script_dir/validate-tap.sh" "$cached_tap" 8.5 "$source_hash" \
  "$repository" > /dev/null 2> "$snapshot_validation_log"; then
  php_darwin_die 'formula-hash validation accepted an untracked tap file'
fi
grep -Fxq 'Homebrew tap snapshot has changed or untracked files' "$snapshot_validation_log" || \
  php_darwin_die 'formula-hash validation did not explain the untracked tap file'
if bash "$script_dir/validate-tap.sh" "$cached_tap" 8.5 '' \
  "$repository" "$source_commit" "$branch" > /dev/null 2> "$snapshot_validation_log"; then
  php_darwin_die 'cached tap validation accepted an untracked formula'
fi
grep -Fxq 'Homebrew tap snapshot has changed or untracked files' "$snapshot_validation_log" || \
  php_darwin_die 'cached tap validation did not explain the untracked formula'

printf 'Homebrew tap snapshot validation passed\n'
