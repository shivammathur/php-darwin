#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-update-test.XXXXXX") || \
  php_darwin_die 'could not create stable update test fixtures'
php_path="$work_dir/homebrew-php"
extensions_path="$work_dir/homebrew-extensions"
fake_bin="$work_dir/bin"
manifest="$work_dir/php-8.5-manifest.json"
assets_jsonl="$work_dir/assets.jsonl"
gh_log="$work_dir/gh.log"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$php_path/Formula" "$extensions_path/Abstract" "$extensions_path/Formula" "$fake_bin" || \
  php_darwin_die 'could not create stable update fixture directories'
while read -r build ts; do
  formula=$(php_darwin_formula 8.5 "$build" "$ts") || exit 1
  printf 'formula %s\n' "$formula" > "$php_path/Formula/$formula.rb" || \
    php_darwin_die "could not write the $formula fixture"
done < <(php_darwin_configured_variants)
printf 'shared source\n' > "$extensions_path/Abstract/abstract-php-extension.rb" || \
  php_darwin_die 'could not write the shared extension fixture'
printf 'xdebug source\n' > "$extensions_path/Formula/xdebug@8.5.rb" || \
  php_darwin_die 'could not write the Xdebug fixture'
printf 'pcov source\n' > "$extensions_path/Formula/pcov@8.5.rb" || \
  php_darwin_die 'could not write the PCOV fixture'
printf 'unrelated source\n' > "$extensions_path/Formula/unrelated@8.5.rb" || \
  php_darwin_die 'could not write the unrelated extension fixture'

cat > "$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
destination=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then
    destination=$2
    shift 2
  else
    shift
  fi
done
cp "${PHP_DARWIN_TEST_MANIFEST:?}" "${destination:?}" || exit 1
printf '200'
EOF
cat > "$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PHP_DARWIN_TEST_GH_LOG:?}"
EOF
chmod 0755 "$fake_bin/curl" "$fake_bin/gh" || php_darwin_die 'could not prepare stable update fixtures'

write_manifest() {
  local extensions_hash=$2
  local php_hash=$1

  : > "$assets_jsonl" || return 1
  while read -r build ts; do
    while IFS= read -r arch; do
      jq -cn --arg architecture "$arch" --arg build "$build" \
        --arg name "$(php_darwin_asset 8.5 "$build" "$ts" "$arch")" \
        --arg thread_safety "$ts" --arg sha256 "$(printf '%064d' 0)" \
        --argjson minimum_macos "$(php_darwin_platform_value "$arch" minimum_macos)" \
        '{architecture:$architecture,build:$build,bytes:1,minimum_macos:$minimum_macos,
          name:$name,sha256:$sha256,thread_safety:$thread_safety}' >> "$assets_jsonl" || return 1
    done < <(php_darwin_platform_arches)
  done < <(php_darwin_configured_variants)
  jq -s --arg extensions_hash "$extensions_hash" \
    --arg extensions_commit 0123456789abcdef0123456789abcdef01234567 \
    --arg homebrew_commit 89abcdef0123456789abcdef0123456789abcdef \
    --arg source_hash "$php_hash" '
    {schema:1,php_version:"8.5",php_semver:"8.5.1",php_src_commit:"",
     extensions_source_hash:$extensions_hash,homebrew_extensions_commit:$extensions_commit,
     homebrew_php_commit:$homebrew_commit,source_hash:$source_hash,assets:.}
  ' "$assets_jsonl" > "$manifest"
}

run_gate() {
  local expected_dispatches=$1

  : > "$gh_log" || php_darwin_die 'could not reset the stable update log'
  HOMEBREW_EXTENSIONS_PATH="$extensions_path" HOMEBREW_PHP_PATH="$php_path" ONLY_VERSION=8.5 \
    PHP_DARWIN_TEST_GH_LOG="$gh_log" PHP_DARWIN_TEST_MANIFEST="$manifest" \
    GITHUB_REF_NAME=main GITHUB_REPOSITORY=shivammathur/php-darwin PATH="$fake_bin:$PATH" \
    bash "$script_dir/update.sh" >/dev/null || php_darwin_die 'stable update gate failed'
  [ "$(awk 'END { print NR+0 }' "$gh_log")" -eq "$expected_dispatches" ] || \
    php_darwin_die "stable update gate dispatched $expected_dispatches workflows unexpectedly"
}

php_hash=$(HOMEBREW_PHP_PATH="$php_path" bash "$script_dir/source-hash.sh" 8.5) || \
  php_darwin_die 'could not hash the stable PHP fixtures'
extensions_hash=$(HOMEBREW_EXTENSIONS_PATH="$extensions_path" \
  bash "$script_dir/extensions-source-hash.sh" 8.5) || \
  php_darwin_die 'could not hash the stable extension fixtures'
write_manifest "$php_hash" "$extensions_hash" || php_darwin_die 'could not write the current stable manifest'
run_gate 0

printf 'changed unrelated source\n' > "$extensions_path/Formula/unrelated@8.5.rb" || \
  php_darwin_die 'could not change the unrelated stable extension fixture'
run_gate 0

printf 'changed xdebug source\n' > "$extensions_path/Formula/xdebug@8.5.rb" || \
  php_darwin_die 'could not change the configured stable extension fixture'
run_gate 1

extensions_hash=$(HOMEBREW_EXTENSIONS_PATH="$extensions_path" \
  bash "$script_dir/extensions-source-hash.sh" 8.5) || \
  php_darwin_die 'could not rehash the stable extension fixtures'
write_manifest "$php_hash" "$extensions_hash" || php_darwin_die 'could not refresh the stable manifest fixture'
printf 'changed php source\n' >> "$php_path/Formula/php.rb" || \
  php_darwin_die 'could not change the stable PHP formula fixture'
run_gate 1

printf 'Stable update validation passed\n'
