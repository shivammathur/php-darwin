#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
repository=https://github.com/shivammathur/homebrew-php
export GIT_AUTHOR_NAME=Fixture GIT_COMMITTER_NAME=Fixture
export GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_EMAIL=fixture@example.invalid
git init -q -b main "$fixture/source"
mkdir "$fixture/source/Formula"
printf 'public version\n' > "$fixture/source/Formula/php.rb"
git -C "$fixture/source" add .
git -C "$fixture/source" commit -qm public
base=$(git -C "$fixture/source" rev-parse HEAD)
git -C "$fixture/source" checkout -qb candidate
printf 'private candidate\n' > "$fixture/source/Formula/php.rb"
git -C "$fixture/source" commit -qam candidate
candidate=$(git -C "$fixture/source" rev-parse HEAD)
PHP_DARWIN_PRIVATE_SOURCE_SHA256=$(printf 'a%.0s' {1..64}) \
  bash "$root/scripts/build/create-tap-snapshot.sh" "$fixture/source" "$candidate" "$repository" main "$fixture/snapshot"
bash "$root/scripts/installer/validate-tap.sh" "$fixture/snapshot" 8.4 '' "$repository" "$candidate" main true
[ "$(git -C "$fixture/snapshot" symbolic-ref --short HEAD)" = php-darwin-staged ]
git -C "$fixture/snapshot" config php-darwin.private-snapshot "$base"
if bash "$root/scripts/installer/validate-tap.sh" "$fixture/snapshot" 8.4 '' "$repository" "$candidate" main true >/dev/null 2>&1; then
  echo 'Accepted a private branch without matching provenance' >&2; exit 1
fi
git -C "$fixture/snapshot" config php-darwin.private-snapshot "$candidate"
# Advance the public formula past the candidate, creating an intentional
# conflict if the synthetic candidate commit were ever replayed onto main.
git -C "$fixture/source" checkout -q main
printf 'next public release\n' > "$fixture/source/Formula/php.rb"
git -C "$fixture/source" commit -qam next-public
published=$(git -C "$fixture/source" rev-parse HEAD)
git -C "$fixture/snapshot" fetch -q "$fixture/source" +main:refs/remotes/origin/main
# Homebrew's update path resets a divergent upstream branch when starting from
# a non-default branch, then rebases the now-public checkout.
[ "$(git -C "$fixture/snapshot" symbolic-ref --short HEAD)" != main ]
if git -C "$fixture/snapshot" merge-base --is-ancestor main origin/main; then
  git -C "$fixture/snapshot" checkout -q main
else
  git -C "$fixture/snapshot" checkout -q -B main origin/main
fi
git -C "$fixture/snapshot" rebase -q origin/main
[ "$(git -C "$fixture/snapshot" rev-parse HEAD)" = "$published" ]
[ "$(cat "$fixture/snapshot/Formula/php.rb")" = 'next public release' ]
printf 'Private tap provenance and public update transition passed\n'
