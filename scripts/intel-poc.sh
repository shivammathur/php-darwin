#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$script_dir/.." && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

export PHP_DARWIN_BACKEND=intel

validate() {
  local fixture member

  jq -e '
    keys == ["x86_64"] and .x86_64.brew_prefix == "/usr/local" and
    .x86_64.build_runner == "macos-15-intel" and .x86_64.minimum_macos == 15 and
    .x86_64.platform_key == "x86_64_sequoia" and
    .x86_64.test_runners == ["macos-15-intel", "macos-26-intel"]
  ' "$root/conf/intel-platforms.json" >/dev/null || php_darwin_die 'invalid Intel platform configuration'
  [ "$(php_darwin_normalize_arch amd64)" = x86_64 ] || php_darwin_die 'Intel architecture alias failed'
  [ "$(php_darwin_expected_asset_count)" -eq 1 ] || php_darwin_die 'Intel POC must contain one asset'
  [ "$(php_darwin_asset 8.5 release nts x86_64)" = 'php_8.5-nts-release+darwin_x86_64.tar.zst' ] || \
    php_darwin_die 'Intel cache asset naming failed'
  [ "$(php_darwin_expected_prefix x86_64)" = /usr/local ] || php_darwin_die 'Intel Homebrew prefix failed'
  grep -Fq 'brew install "$tap/$requested_formula"' "$root/scripts/build.sh" || \
    php_darwin_die 'PHP is not installed through Homebrew dependency resolution'
  if grep -Fq 'PHP_DARWIN_FORCE_''SOURCE' "$root/scripts/build.sh" "$root/scripts/build-extensions.sh"; then
    php_darwin_die 'Intel must not force PHP or its dependencies to build from source'
  fi

  fixture=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-intel-validation.XXXXXX") || exit 1
  trap 'rm -rf "$fixture"' EXIT
  member=var/php-darwin/php_8.5-nts-release+darwin_x86_64.json
  mkdir -p "$fixture/source/${member%/*}" || exit 1
  printf '{}\n' > "$fixture/source/$member" || exit 1
  tar -cf "$fixture/intel.tar" -C "$fixture/source" "$member" || exit 1
  bash "$root/scripts/read-metadata.sh" "$fixture/intel.tar" "$member" "$fixture/metadata.json" || \
    php_darwin_die 'Intel metadata extraction failed'
  if PHP_DARWIN_BACKEND=homebrew bash "$root/scripts/read-metadata.sh" "$fixture/intel.tar" "$member" \
    "$fixture/default-metadata.json" >/dev/null 2>&1; then
    php_darwin_die 'the ARM-only metadata reader accepted Intel without the isolated backend'
  fi
  printf 'Intel/Homebrew POC configuration is valid\n'
}

profile() {
  local output_dir=${1:?}
  local profile_name=${PROFILE_NAME:?}
  local command_name key

  mkdir -p "$output_dir" || exit 1
  for command_name in php php-config pear pecl; do
    command -v "$command_name" >/dev/null 2>&1 || \
      php_darwin_die "$command_name is not on PATH"
  done
  php -m | awk '/^\[/ || /^[[:space:]]*$/ { next } { print tolower($0) }' | \
    LC_ALL=C sort -u > "$output_dir/extensions.txt" || exit 1
  php -i | awk -F ' => ' '
    /^[^[:space:]<][^=]* => / {
      key=tolower($1); gsub(/[[:space:]]+/, " ", key); print key
    }
  ' | LC_ALL=C sort -u > "$output_dir/php-info-keys.txt" || exit 1
  # shellcheck disable=SC2016
  php -r '
    $functions = ["curl_init", "date_create", "filter_var", "gd_info", "gettext", "gmp_init",
      "iconv", "mysqli_connect", "openssl_encrypt", "pg_connect", "simplexml_load_string",
      "socket_create", "sodium_crypto_secretbox", "tidy_parse_string", "xml_parser_create"];
    $classes = ["DOMDocument", "IntlDateFormatter", "PDO", "Phar", "SQLite3", "XSLTProcessor", "ZipArchive"];
    $result = ["classes" => array_fill_keys($classes, false), "debug" => (bool) PHP_DEBUG,
      "functions" => array_fill_keys($functions, false), "sapi" => PHP_SAPI,
      "stream_filters" => stream_get_filters(), "stream_transports" => stream_get_transports(),
      "stream_wrappers" => stream_get_wrappers(), "version_minor" => PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION,
      "zts" => (bool) PHP_ZTS];
    foreach ($functions as $function) $result["functions"][$function] = function_exists($function);
    foreach ($classes as $class) $result["classes"][$class] = class_exists($class);
    foreach (["stream_filters", "stream_transports", "stream_wrappers"] as $key) sort($result[$key]);
    echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
  ' > "$output_dir/runtime.json" || exit 1
  pecl config-show > "$output_dir/pecl-config.txt" || exit 1
  for key in bin_dir cache_dir download_dir ext_dir php_bin php_dir php_ini temp_dir; do
    grep -Eq "[[:space:]]${key}[[:space:]]" "$output_dir/pecl-config.txt" || exit 1
    printf '%s\n' "$key" >> "$output_dir/pecl-config-keys.txt" || exit 1
  done
  LC_ALL=C sort -u "$output_dir/pecl-config-keys.txt" -o "$output_dir/pecl-config-keys.txt" || exit 1
  {
    printf 'name=%s\n' "$profile_name"
    printf 'php=%s\n' "$(php -r 'echo PHP_VERSION;')"
    printf 'php_config=%s\n' "$(php-config --version)"
    printf 'pear=%s\n' "$(pear version | awk '/PEAR Version:/ {print $3; exit}')"
    printf 'pecl=%s\n' "$(pecl version | awk '/PEAR Version:/ {print $3; exit}')"
  } > "$output_dir/tool-versions.txt" || exit 1
}

compare() {
  local arm=${1:?}
  local intel=${2:?}
  local profile file work_dir common_count union_count match

  for profile in "$arm" "$intel"; do
    for file in extensions.txt php-info-keys.txt runtime.json pecl-config-keys.txt tool-versions.txt; do
      [ -s "$profile/$file" ] || php_darwin_die "missing profile file: $profile/$file"
    done
  done
  work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-parity.XXXXXX") || exit 1
  trap 'rm -rf "$work_dir"' EXIT
  diff -u "$arm/extensions.txt" "$intel/extensions.txt" || \
    php_darwin_die 'ARM and Intel PHP extension sets differ'
  jq -S . "$arm/runtime.json" > "$work_dir/arm-runtime.json" || exit 1
  jq -S . "$intel/runtime.json" > "$work_dir/intel-runtime.json" || exit 1
  diff -u "$work_dir/arm-runtime.json" "$work_dir/intel-runtime.json" || \
    php_darwin_die 'ARM and Intel runtime capabilities differ'
  diff -u "$arm/pecl-config-keys.txt" "$intel/pecl-config-keys.txt" || \
    php_darwin_die 'ARM and Intel PECL configuration capabilities differ'
  comm -12 "$arm/php-info-keys.txt" "$intel/php-info-keys.txt" > "$work_dir/info-common.txt" || exit 1
  LC_ALL=C sort -u "$arm/php-info-keys.txt" "$intel/php-info-keys.txt" > "$work_dir/info-union.txt" || exit 1
  common_count=$(awk 'END { print NR+0 }' "$work_dir/info-common.txt")
  union_count=$(awk 'END { print NR+0 }' "$work_dir/info-union.txt")
  [ "$union_count" -gt 0 ] || exit 1
  match=$((common_count * 100 / union_count))
  printf 'phpinfo key parity: %s%% (%s of %s)\n' "$match" "$common_count" "$union_count"
  [ "$match" -ge 95 ] || php_darwin_die 'phpinfo key parity is below 95%'
  printf 'ARM and Intel Homebrew PHP profiles match\n'
}

create_release_assets() {
  local assets_dir=$1 metadata output version asset archive checksum sha256 bytes asset_record

  metadata="$assets_dir/php_8.5-nts-release+darwin_x86_64.json"
  output="$assets_dir/php-8.5-manifest.json"
  version=$(jq -er '.php_version' "$metadata") || php_darwin_die 'PHP version is missing from Intel metadata'
  asset=$(jq -er '.archive' "$metadata") || php_darwin_die 'archive is missing from Intel metadata'
  archive="$assets_dir/$asset"
  checksum="$archive.sha256"
  [ -f "$archive" ] && [ -f "$checksum" ] || php_darwin_die 'Intel archive or checksum is missing'
  php_darwin_validate_cache_metadata "$metadata" "$version" release nts x86_64 \
    /usr/local 15 >/dev/null || php_darwin_die 'Intel cache metadata is invalid'
  sha256=$(php_darwin_checksum_from_file "$checksum" "$asset") || php_darwin_die 'Intel checksum is invalid'
  bytes=$(wc -c < "$archive" | tr -d '[:space:]')
  asset_record=$(jq -cn \
    --arg architecture x86_64 --arg build release --arg name "$asset" --arg sha256 "$sha256" \
    --arg thread_safety nts --argjson bytes "$bytes" --argjson minimum_macos 15 \
    '{architecture:$architecture,build:$build,bytes:$bytes,download:$name,minimum_macos:$minimum_macos,
      name:$name,sha256:$sha256,thread_safety:$thread_safety}') || exit 1
  jq --argjson asset "$asset_record" --slurpfile metadata "$metadata" '
    .assets=[$asset] |
    .extensions_source_hash=$metadata[0].extensions_source_hash |
    .homebrew_extensions_commit=$metadata[0].homebrew_extensions_commit |
    .homebrew_php_commit=$metadata[0].homebrew_php_commit |
    .php_semver=$metadata[0].php_semver | .php_src_commit=$metadata[0].php_src_commit |
    .php_version=$metadata[0].php_version | .source_hash=$metadata[0].source_hash
  ' "$root/templates/release-manifest.json" > "$output" || \
    php_darwin_die 'could not create the Intel release manifest'
  php_darwin_validate_release_manifest "$output" "$version" stable || \
    php_darwin_die 'Intel release manifest validation failed'
  PHP_DARWIN_RELEASE_MANIFEST="$output" PHP_DARWIN_GENERATED_BACKEND=intel \
    PHP_DARWIN_GENERATED_RELEASE_TAG_SUFFIX=-intel-poc \
    bash "$root/scripts/generate-install.sh" "$assets_dir/install.sh" >/dev/null || \
    php_darwin_die 'could not create the Intel installer'
}

publish() {
  local assets_dir=${1:?}
  local repository=${GITHUB_REPOSITORY:-shivammathur/php-darwin}
  local token=${GITHUB_TOKEN:?}
  local tag=php-8.5-intel-poc
  local api="https://api.github.com/repos/$repository"
  local upload_api="https://uploads.github.com/repos/$repository"
  local work_dir release_json response_json required_assets name actual_count status release_id asset existing_id encoded_name

  create_release_assets "$assets_dir"
  work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-intel-publish.XXXXXX") || exit 1
  trap 'rm -rf "$work_dir"' EXIT
  release_json="$work_dir/release.json"
  response_json="$work_dir/response.json"
  required_assets='install.sh
php-8.5-manifest.json
php_8.5-nts-release+darwin_x86_64.json
php_8.5-nts-release+darwin_x86_64.tar.zst
php_8.5-nts-release+darwin_x86_64.tar.zst.sha256'
  for name in $required_assets; do
    [ -f "$assets_dir/$name" ] || php_darwin_die "required Intel POC asset is missing: $name"
  done
  actual_count=$(find "$assets_dir" -maxdepth 1 -type f | awk 'END { print NR+0 }') || exit 1
  [ "$actual_count" -eq 5 ] || php_darwin_die "expected 5 Intel POC assets, found $actual_count"

  request() {
    curl --fail --silent --show-error -H 'Accept: application/vnd.github+json' \
      -H "Authorization: Bearer $token" -H 'X-GitHub-Api-Version: 2022-11-28' "$@"
  }
  status=$(request --output "$release_json" --write-out '%{http_code}' "$api/releases/tags/$tag" 2>/dev/null) || true
  if [ "$status" = 404 ]; then
    jq -n --arg tag "$tag" '{tag_name:$tag,name:$tag,prerelease:true,generate_release_notes:false}' \
      > "$work_dir/create.json" || exit 1
    request --request POST --data-binary "@$work_dir/create.json" "$api/releases" > "$release_json" || exit 1
  elif [ "$status" != 200 ]; then
    php_darwin_die "could not inspect $tag (HTTP $status)"
  fi
  release_id=$(jq -er '.id' "$release_json") || exit 1
  for asset in "$assets_dir"/*; do
    [ -f "$asset" ] || continue
    name=${asset##*/}
    case "$name" in *.tar.zst|*.sha256|*.json|install.sh) ;; *) continue ;; esac
    existing_id=$(jq -r --arg name "$name" '.assets[]? | select(.name == $name) | .id' "$release_json") || exit 1
    if [ -n "$existing_id" ]; then
      request --request DELETE "$api/releases/assets/$existing_id" >/dev/null || exit 1
    fi
    encoded_name=$(jq -rn --arg name "$name" '$name | @uri') || exit 1
    request --request POST --header 'Content-Type: application/octet-stream' --data-binary "@$asset" \
      "$upload_api/releases/$release_id/assets?name=$encoded_name" > "$response_json" || exit 1
    [ "$(jq -r '.state' "$response_json")" = uploaded ] || exit 1
  done
  printf 'Published %s\n' "$tag"
}

case "${1:-}" in
  validate) validate ;;
  profile) shift; profile "$@" ;;
  compare) shift; compare "$@" ;;
  publish) shift; publish "$@" ;;
  *) printf 'Usage: %s validate|profile DIR|compare ARM INTEL|publish BUILDS_DIR\n' "$0" >&2; exit 1 ;;
esac
