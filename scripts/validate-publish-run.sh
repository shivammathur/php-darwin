#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

run_id=${1:?}
repository=${GITHUB_REPOSITORY:-shivammathur/php-darwin}
run_json=${PHP_DARWIN_RUN_JSON:-}

[[ "$run_id" =~ ^[0-9]+$ ]] || php_darwin_die "invalid workflow run ID: $run_id"
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || \
  php_darwin_die "invalid workflow repository: $repository"

if [ -n "$run_json" ]; then
  [ -f "$run_json" ] || php_darwin_die "workflow run fixture is missing: $run_json"
else
  run_json=$(mktemp "${RUNNER_TEMP:-/tmp}/php-darwin-publish-run.XXXXXX") || \
    php_darwin_die 'could not create the workflow run inspection file'
  trap 'rm -f "$run_json"' EXIT
  gh run view "$run_id" --repo "$repository" --json status,conclusion,workflowName,jobs \
    > "$run_json" || php_darwin_die "could not inspect workflow run $run_id"
fi

jq -e '
  .status == "completed" and
  (.workflowName | type == "string" and length > 0) and
  (.jobs | type == "array") and
  ([.jobs[] | select(.name | test("(^| / )Build PHP "))] as $builds |
    ($builds | length > 0) and all($builds[]; .status == "completed" and .conclusion == "success")) and
  ([.jobs[] | select(.name | test("(^| / )Test PHP "))] as $tests |
    ($tests | length > 0) and all($tests[]; .status == "completed" and .conclusion == "success"))
' "$run_json" >/dev/null || \
  php_darwin_die "workflow run $run_id does not contain successful cache build and compatibility-test jobs"

printf 'Validated workflow run %s before publish\n' "$run_id"
