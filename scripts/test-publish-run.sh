#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-publish-run-test.XXXXXX") || exit 1
trap 'rm -rf "$work_dir"' EXIT
run_json="$work_dir/run.json"

jq -n '{status:"completed",conclusion:"success",workflowName:"Cache stable PHP",jobs:[
  {name:"cache / Build PHP 8.5 packages on arm64",status:"completed",conclusion:"success"},
  {name:"cache / Test PHP 8.5 packages on macos-14",status:"completed",conclusion:"success"},
  {name:"cache / Test PHP 8.5 packages on macos-15",status:"completed",conclusion:"success"}
]}' > "$run_json" || exit 1
PHP_DARWIN_RUN_JSON="$run_json" bash "$script_dir/validate-publish-run.sh" 123 >/dev/null || \
  php_darwin_die 'publisher rejected a successful build and test workflow run'

jq '.conclusion="failure" | .jobs += [
  {name:"cache / Publish PHP 8.5 release assets",status:"completed",conclusion:"failure"}
]' "$run_json" > "$run_json.publish-failed" || exit 1
PHP_DARWIN_RUN_JSON="$run_json.publish-failed" bash "$script_dir/validate-publish-run.sh" 123 \
  >/dev/null || php_darwin_die 'publisher rejected successful build and test jobs after publish failed'

jq '.status="in_progress" | .conclusion=""' "$run_json" > "$run_json.in-progress" || exit 1
if PHP_DARWIN_RUN_JSON="$run_json.in-progress" bash "$script_dir/validate-publish-run.sh" 123 \
  >/dev/null 2>&1; then
  php_darwin_die 'publisher accepted an incomplete workflow run'
fi

jq '(.jobs[] | select(.name | contains("Test PHP 8.5 packages on macos-15"))).conclusion="failure"' \
  "$run_json" > "$run_json.failed" || exit 1
if PHP_DARWIN_RUN_JSON="$run_json.failed" bash "$script_dir/validate-publish-run.sh" 123 \
  >/dev/null 2>&1; then
  php_darwin_die 'publisher accepted a workflow run with a failed compatibility test'
fi

jq '(.jobs[] | select(.name | contains("Build PHP 8.5"))).conclusion="failure"' \
  "$run_json" > "$run_json.failed-build" || exit 1
if PHP_DARWIN_RUN_JSON="$run_json.failed-build" bash "$script_dir/validate-publish-run.sh" 123 \
  >/dev/null 2>&1; then
  php_darwin_die 'publisher accepted a workflow run with a failed cache build'
fi

jq '.jobs |= map(select(.name | contains("Test PHP ") | not))' "$run_json" \
  > "$run_json.untested" || exit 1
if PHP_DARWIN_RUN_JSON="$run_json.untested" bash "$script_dir/validate-publish-run.sh" 123 \
  >/dev/null 2>&1; then
  php_darwin_die 'publisher accepted a workflow run without compatibility tests'
fi

printf 'Publish workflow-run validation passed\n'
