#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../lib/lib.sh"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1
export HOMEBREW_VERBOSE=1 HOMEBREW_VERBOSE_USING_DOTS=0
export PATH="$script_dir:$PATH"
# Use the same complete root set as dependency approval, including optional
# packs and their serializer modules as well as bundled extensions.
roots=$("${PHP_DARWIN_NODE:-node}" -e \
  'console.log(JSON.stringify(require(process.argv[1]).roots()))' "$script_dir/update-dependencies.cjs")
# Ignore installed state and include root build dependencies, even where a PHP
# release bottle exists. This covers source/debug/ZTS and transitive source builds.
brew php-darwin-source info seed "$roots" true > bottle-plan.json
"${PHP_DARWIN_NODE:-node}" "$script_dir/seed-bottle-records.cjs" bottle-plan.json > bottles.jsonl
jq -r '.[] | select(.bottled == false) | "Source-cache required: \(.full_name) \(.version)"' bottle-plan.json
printf 'Resolved %s roots; %s bottled dependencies\n' "$(jq length <<< "$roots")" "$(wc -l < bottles.jsonl)"
