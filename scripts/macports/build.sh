#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/macports/lib.sh
. "$script_dir/lib.sh"

[ "${GITHUB_ACTIONS:-}" = true ] || [ "${PHP_DARWIN_ALLOW_LOCAL_BUILD:-}" = true ] || \
  php_darwin_macports_die 'MacPorts builds are restricted to Actions runners'
[ "$(uname -s)" = Darwin ] || php_darwin_macports_die 'macOS is required'
[ "$(uname -m)" = x86_64 ] || php_darwin_macports_die 'an Intel Mac is required'

stage=${1:-all}
version=${PHP_VERSION:?}
build=${BUILD:-release}
ts=${TS:-nts}
php_darwin_macports_validate_version "$version"
php_darwin_macports_validate_build "$build"
php_darwin_macports_validate_ts "$ts"
pilot_version=$(php_darwin_macports_config pilot_version) || exit 1
[ "$version" = "$pilot_version" ] || php_darwin_macports_die "the POC is limited to PHP $pilot_version"

prefix=$(php_darwin_macports_prefix "$version" "$build" "$ts") || exit 1
port_prefix=$(php_darwin_macports_port_prefix "$version") || exit 1
base_version=$(php_darwin_macports_config base_version) || exit 1
base_sha256=$(php_darwin_macports_config base_sha256) || exit 1
ports_commit=$(php_darwin_macports_config ports_commit) || exit 1
ports_sha256=$(php_darwin_macports_config ports_sha256) || exit 1
minimum_macos=$(php_darwin_macports_config minimum_macos) || exit 1
work_dir="${RUNNER_TEMP:-/tmp}/php-darwin-macports-build"
sources_dir="$work_dir/sources"
base_archive="$sources_dir/MacPorts-$base_version.tar.bz2"
ports_archive="$sources_dir/macports-ports-$ports_commit.tar.gz"
base_source="$sources_dir/MacPorts-$base_version"
ports_tree="$sources_dir/macports-ports-$ports_commit"
builds_dir="$php_darwin_macports_root/builds/intel"
archive_name=$(php_darwin_macports_archive "$version" "$build" "$ts") || exit 1
archive="$builds_dir/$archive_name"
metadata_name=$(php_darwin_macports_metadata "$version" "$build" "$ts") || exit 1
metadata="$builds_dir/$metadata_name"
installer="$builds_dir/install.sh"
port="$prefix/bin/port"

prepare_sources() {
  local actual_sha256
  local next_portfile="$work_dir/Portfile"

  mkdir -p "$sources_dir" || php_darwin_macports_die 'could not create the source directory'
  curl --fail --location --retry 3 --output "$base_archive" \
    "https://github.com/macports/macports-base/releases/download/v$base_version/MacPorts-$base_version.tar.bz2" || \
    php_darwin_macports_die 'could not download MacPorts base'
  actual_sha256=$(php_darwin_macports_sha256 "$base_archive") || exit 1
  [ "$actual_sha256" = "$base_sha256" ] || php_darwin_macports_die 'MacPorts base checksum mismatch'
  curl --fail --location --retry 3 --output "$ports_archive" \
    "https://github.com/macports/macports-ports/archive/$ports_commit.tar.gz" || \
    php_darwin_macports_die 'could not download the MacPorts ports tree'
  actual_sha256=$(php_darwin_macports_sha256 "$ports_archive") || exit 1
  [ "$actual_sha256" = "$ports_sha256" ] || php_darwin_macports_die 'MacPorts ports tree checksum mismatch'
  tar -xjf "$base_archive" -C "$sources_dir" || php_darwin_macports_die 'could not extract MacPorts base'
  tar -xzf "$ports_archive" -C "$sources_dir" || php_darwin_macports_die 'could not extract the MacPorts ports tree'
  [ -f "$ports_tree/lang/php/Portfile" ] || php_darwin_macports_die 'the PHP Portfile is missing'
  awk 'FNR == 1 && NR != 1 { print "" } { print }' \
    "$ports_tree/lang/php/Portfile" "$php_darwin_macports_root/templates/macports/php-zts.tcl" \
    > "$next_portfile" || php_darwin_macports_die 'could not add the private ZTS variant'
  mv "$next_portfile" "$ports_tree/lang/php/Portfile" || php_darwin_macports_die 'could not update the PHP Portfile'
}

bootstrap_macports() {
  local install_group
  local install_user

  [ -x "$base_source/configure" ] || php_darwin_macports_die 'MacPorts base has not been prepared'
  install_user=$(id -un) || php_darwin_macports_die 'could not determine the build user'
  install_group=$(id -gn) || php_darwin_macports_die 'could not determine the build group'
  sudo -n mkdir -p "$prefix" || php_darwin_macports_die 'could not create the private MacPorts prefix'
  sudo -n chown "$install_user:$install_group" "$prefix" || \
    php_darwin_macports_die 'could not make the private MacPorts prefix writable'
  (
    cd "$base_source" || exit 1
    ./configure \
      --prefix="$prefix" \
      --with-applications-dir="$prefix/Applications" \
      --with-frameworks-dir="$prefix/Library/Frameworks" \
      --with-install-user="$install_user" \
      --with-install-group="$install_group" \
      --with-macports-user="$install_user" \
      --with-no-root-privileges \
      --with-unsupported-prefix \
      --without-startupitems || exit 1
    make -j"$(sysctl -n hw.logicalcpu)" || exit 1
    make install
  ) || php_darwin_macports_die 'could not build the private MacPorts installation'
}

configure_macports() {
  local macports_conf="$prefix/etc/macports/macports.conf"
  local sources_conf="$prefix/etc/macports/sources.conf"

  [ -x "$port" ] || php_darwin_macports_die 'the private port command is missing'
  printf 'file://%s [default]\n' "$ports_tree" > "$sources_conf" || \
    php_darwin_macports_die 'could not configure the private ports tree'
  {
    printf '\nbuild_arch x86_64\n'
    printf 'buildfromsource always\n'
    printf 'startupitem_install no\n'
    printf 'fetch_threads 8\n'
  } >> "$macports_conf" || php_darwin_macports_die 'could not configure MacPorts'
  "$prefix/bin/portindex" "$ports_tree" || php_darwin_macports_die 'could not index the private ports tree'
}

install_php() {
  local base_port=
  local base_variants=()
  local extra
  local plain_ports=()
  local requested_port
  local variant_ports=()
  local variant_values=()
  local variants
  local index

  while IFS=$'\t' read -r requested_port variants extra; do
    [ -n "$requested_port" ] || continue
    [ -z "$extra" ] || php_darwin_macports_die "invalid expanded port record: $requested_port"
    if [ "$requested_port" = "$port_prefix" ]; then
      base_port=$requested_port
      [ -z "$variants" ] || base_variants+=("$variants")
    elif [ -z "$variants" ]; then
      plain_ports+=("$requested_port")
    else
      variant_ports+=("$requested_port")
      variant_values+=("$variants")
    fi
  done < <(php_darwin_macports_ports "$port_prefix")
  [ -n "$base_port" ] || php_darwin_macports_die 'the base PHP port is not configured'
  [ "$build" != debug ] || base_variants+=(+debug)
  [ "$ts" != zts ] || base_variants+=(+zts)
  "$port" -N install "$base_port" "${base_variants[@]}" || \
    php_darwin_macports_die "could not install $base_port"
  for ((index = 0; index < ${#variant_ports[@]}; index++)); do
    "$port" -N install "${variant_ports[$index]}" "${variant_values[$index]}" || \
      php_darwin_macports_die "could not install ${variant_ports[$index]} ${variant_values[$index]}"
  done
  [ "${#plain_ports[@]}" -eq 0 ] || "$port" -N install "${plain_ports[@]}" || \
    php_darwin_macports_die 'could not install the PHP extension ports'
}

configure_php() {
  local extension_dir
  local ini_dir="$prefix/etc/$port_prefix"
  local pear
  local pecl
  local php_bin="$prefix/bin/$port_prefix"

  "$port" -N select --set php "$port_prefix" || php_darwin_macports_die 'could not select the installed PHP port'
  [ -x "$prefix/bin/php" ] || php_darwin_macports_die 'php_select did not create the PHP executable'
  while IFS= read -r link_name; do
    [ -n "$link_name" ] || continue
    case "$link_name" in \#*) continue ;; esac
    [ -e "$prefix/bin/$link_name" ] || php_darwin_macports_die "php_select did not create $link_name"
  done < "$php_darwin_macports_root/conf/macports-links"
  [ -f "$ini_dir/php.ini-development" ] || php_darwin_macports_die 'php.ini-development is missing'
  cp "$ini_dir/php.ini-development" "$ini_dir/php.ini" || php_darwin_macports_die 'could not create php.ini'
  mkdir -p "$prefix/etc/php-darwin/disabled" || php_darwin_macports_die 'could not create disabled extension storage'
  for extension in xdebug pcov; do
    if [ -f "$prefix/var/db/$port_prefix/$extension.ini" ]; then
      mv "$prefix/var/db/$port_prefix/$extension.ini" "$prefix/etc/php-darwin/disabled/$extension.ini" || \
        php_darwin_macports_die "could not disable $extension"
    fi
  done
  [ -x "$prefix/sbin/php-fpm${port_prefix#php}" ] && \
    ln -s "../sbin/php-fpm${port_prefix#php}" "$prefix/bin/php-fpm" || true
  extension_dir=$("$php_bin" -n -r 'echo ini_get("extension_dir");') || \
    php_darwin_macports_die 'could not determine the PHP extension directory'
  pear="$prefix/bin/pear"
  pecl="$prefix/bin/pecl"
  [ -x "$pear" ] && [ -x "$pecl" ] || php_darwin_macports_die 'PEAR and PECL are missing'
  for command in "$pear" "$pecl"; do
    "$command" config-set bin_dir "$prefix/bin" system >/dev/null || php_darwin_macports_die 'could not configure PEAR bin_dir'
    "$command" config-set php_bin "$prefix/bin/php" system >/dev/null || php_darwin_macports_die 'could not configure PEAR php_bin'
    "$command" config-set ext_dir "$extension_dir" system >/dev/null || php_darwin_macports_die 'could not configure PEAR ext_dir'
    "$command" config-set php_ini "$ini_dir/php.ini" system >/dev/null || php_darwin_macports_die 'could not configure PEAR php_ini'
    "$command" config-set cache_dir /private/tmp/pear/cache system >/dev/null || php_darwin_macports_die 'could not configure PEAR cache_dir'
    "$command" config-set download_dir /private/tmp/pear/download system >/dev/null || php_darwin_macports_die 'could not configure PEAR download_dir'
    "$command" config-set temp_dir /private/tmp/pear/temp system >/dev/null || php_darwin_macports_die 'could not configure PEAR temp_dir'
  done
}

remove_runtime_junk() {
  local path=$1

  case "$path" in "$prefix/"*) ;; *) php_darwin_macports_die "unsafe cleanup path: $path" ;; esac
  [ ! -e "$path" ] || [ -d "$path" ] && [ ! -L "$path" ] || \
    php_darwin_macports_die "unsafe cleanup target: $path"
  [ ! -d "$path" ] || find "$path" -mindepth 1 -delete || \
    php_darwin_macports_die "could not clean $path"
  [ ! -d "$path" ] || rmdir "$path" || php_darwin_macports_die "could not remove $path"
}

clean_runtime() {
  local command
  local path

  [ -x "$prefix/bin/php" ] || php_darwin_macports_die 'PHP has not been configured'
  "$port" -N clean --all installed || php_darwin_macports_die 'could not clean installed ports'
  for path in \
    "$prefix/Applications" \
    "$prefix/etc/macports" \
    "$prefix/libexec/macports" \
    "$prefix/share/doc" \
    "$prefix/share/examples" \
    "$prefix/share/info" \
    "$prefix/share/man" \
    "$prefix/share/macports" \
    "$prefix/var/macports"; do
    remove_runtime_junk "$path"
  done
  for command in port portf portindex portmirror port-tclsh; do
    [ ! -e "$prefix/bin/$command" ] || rm -f "$prefix/bin/$command" || \
      php_darwin_macports_die "could not remove the build-only $command command"
  done
  [ ! -e "$prefix/sbin/port" ] || rm -f "$prefix/sbin/port" || \
    php_darwin_macports_die 'could not remove the build-only port command'
  "$prefix/bin/php" -v >/dev/null || php_darwin_macports_die 'PHP stopped working after runtime cleanup'
  "$prefix/bin/pecl" version >/dev/null || php_darwin_macports_die 'PECL stopped working after runtime cleanup'
}

package_php() {
  local actual_sha256
  local archive_bytes
  local macos_version
  local php_semver
  local prefix_relative=${prefix#/}
  local zstd_command

  [ -x "$prefix/bin/php" ] || php_darwin_macports_die 'PHP has not been configured'
  [ ! -e "$port" ] || php_darwin_macports_die 'the build-only MacPorts command was not pruned'
  mkdir -p "$builds_dir" || php_darwin_macports_die 'could not create the build output directory'
  zstd_command=$(command -v zstd) || php_darwin_macports_die 'zstd is required to package the cache'
  COPYFILE_DISABLE=1 tar -cf - -C / "$prefix_relative" | \
    "$zstd_command" -q -T0 -19 -o "$archive"
  pipeline_status=("${PIPESTATUS[@]}")
  [ "${pipeline_status[0]}" -eq 0 ] && [ "${pipeline_status[1]}" -eq 0 ] || \
    php_darwin_macports_die 'could not create the cache archive'
  actual_sha256=$(php_darwin_macports_sha256 "$archive") || php_darwin_macports_die 'could not hash the cache archive'
  archive_bytes=$(wc -c < "$archive" | tr -d '[:space:]')
  php_semver=$("$prefix/bin/php" -n -r 'echo PHP_MAJOR_VERSION, ".", PHP_MINOR_VERSION, ".", PHP_RELEASE_VERSION;') || \
    php_darwin_macports_die 'could not read the built PHP version'
  macos_version=$(sw_vers -productVersion) || php_darwin_macports_die 'could not read the macOS version'
  jq -n \
    --arg archive "$archive_name" \
    --arg build "$build" \
    --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg macos_version "$macos_version" \
    --arg macports_base_version "$base_version" \
    --arg macports_ports_commit "$ports_commit" \
    --arg php_semver "$php_semver" \
    --arg php_version "$version" \
    --arg prefix "$prefix" \
    --arg sha256 "$actual_sha256" \
    --arg thread_safety "$ts" \
    --argjson bytes "$archive_bytes" \
    --argjson minimum_macos "$minimum_macos" \
    '{archive:$archive,architecture:"x86_64",backend:"macports",build:$build,bytes:$bytes,
      created_at:$created_at,macos_version:$macos_version,macports_base_version:$macports_base_version,
      macports_ports_commit:$macports_ports_commit,minimum_macos:$minimum_macos,php_semver:$php_semver,
      php_version:$php_version,prefix:$prefix,schema:1,sha256:$sha256,thread_safety:$thread_safety}' \
    > "$metadata" || php_darwin_macports_die 'could not create cache metadata'
  printf '%s  %s\n' "$actual_sha256" "$archive_name" > "$archive.sha256" || \
    php_darwin_macports_die 'could not create the archive checksum'
  bash "$script_dir/generate-install.sh" "$metadata" "$installer" || \
    php_darwin_macports_die 'could not generate the standalone installer'
}

verify_package() {
  local listed_prefix

  [ -f "$archive" ] && [ -f "$metadata" ] && [ -x "$installer" ] || \
    php_darwin_macports_die 'the cache output is incomplete'
  zstd -q -t "$archive" || php_darwin_macports_die 'the cache archive is corrupt'
  listed_prefix=$(zstd -q -dc "$archive" | tar -tf - | awk 'NR == 1 { print; exit }') || \
    php_darwin_macports_die 'could not inspect the cache archive'
  case "$listed_prefix" in "${prefix#/}"|"${prefix#/}/") ;; *) php_darwin_macports_die 'the archive has an unexpected root' ;; esac
  jq -e --arg archive "$archive_name" --arg prefix "$prefix" --arg version "$version" \
    '.schema == 1 and .backend == "macports" and .architecture == "x86_64" and
     .archive == $archive and .prefix == $prefix and .php_version == $version and
     (.sha256 | test("^[0-9a-f]{64}$")) and (.bytes > 0)' "$metadata" >/dev/null || \
    php_darwin_macports_die 'cache metadata validation failed'
  bash -n "$installer" || php_darwin_macports_die 'the generated installer has invalid syntax'
}

case "$stage" in
  prepare) prepare_sources ;;
  bootstrap) bootstrap_macports ;;
  configure) configure_macports ;;
  install) install_php ;;
  php-config) configure_php ;;
  cleanup) clean_runtime ;;
  package) package_php ;;
  verify) verify_package ;;
  all)
    prepare_sources
    bootstrap_macports
    configure_macports
    install_php
    configure_php
    clean_runtime
    package_php
    verify_package
    ;;
  *) php_darwin_macports_die "unknown build stage: $stage" ;;
esac
