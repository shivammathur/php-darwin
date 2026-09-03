#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib.sh
. "$script_dir/lib.sh"

root=$(cd "$script_dir/.." && pwd)
installer="$root/scripts/install.sh"
files="$root/conf/install-files"
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-install-validation.XXXXXX") || \
  php_darwin_die 'could not create the standalone installer validation directory'
trap 'rm -rf "$work_dir"' EXIT
expected="$work_dir/install.sh"

bash "$script_dir/generate-install.sh" "$expected" >/dev/null || \
  php_darwin_die 'could not independently generate the standalone installer'
cmp -s "$installer" "$expected" || php_darwin_die 'standalone installer is stale'
bash -n "$installer" || php_darwin_die 'standalone installer has invalid shell syntax'
if grep -Eq 'base64|PHP_DARWIN_PAYLOAD|PHP_DARWIN_CLIENT|gzip -d' "$installer"; then
  php_darwin_die 'standalone installer contains an encoded payload'
fi
if grep -Eq 'PHP_DARWIN_TIMING_LOG|php_darwin_(log_metric|show_metrics)|installer\.total_seconds' "$installer"; then
  php_darwin_die 'standalone installer contains profiling logic'
fi
if grep -Fq 'GITHUB_PATH' "$installer"; then
  php_darwin_die 'standalone installer must use Homebrew links instead of changing GITHUB_PATH'
fi
grep -Fq 'retrying with the current release manifest' "$installer" || \
  php_darwin_die 'standalone installer cannot recover from a retired embedded release archive'
grep -Fq "sudo -n mv \"\$tap_snapshot_path\" \"\$tap_path\"" "$installer" || \
  php_darwin_die 'standalone installer cannot advance a protected Homebrew tap path'
grep -Fq "php_darwin_reap_job \"\$homebrew_prepare_pid\" 20" "$installer" || \
  php_darwin_die 'standalone installer does not bound failed Homebrew preparation cleanup'
grep -Fq "php_darwin_remove_tap_path \"\$brew_prefix\" \"\$tap_path\"" "$installer" || \
  php_darwin_die 'standalone installer cannot restore a temporary user tap transaction'
if ! awk '
  /if \[ "\$tap_restore_after_install" = true \]/ { temporary=1; next }
  temporary && /php_darwin_restore_formula_trust/ { found=1 }
  temporary && /^elif / { temporary=0 }
  END { exit !found }
' "$installer"; then
  php_darwin_die 'standalone installer does not restore formula trust after a temporary tap install'
fi
if grep -Fq "wait \"\$background_pid\"" "$installer"; then
  php_darwin_die 'standalone installer still waits indefinitely for failed background jobs'
fi
if ! awk '
  /^php_darwin_resolve_tap_and_dependencies\(\)/ { resolver=1; next }
  resolver && /php_darwin_collect_dependencies/ && !collected { collected=NR }
  resolver && /php_darwin_wait_for_tap/ && !tap { tap=NR }
  resolver && /php_darwin_wait_for_dependencies/ && !dependencies { dependencies=NR }
  resolver && /^}/ { resolver=0 }
  END { exit !(collected > 0 && tap > collected && dependencies > tap) }
' "$installer"; then
  php_darwin_die 'standalone installer can fail dependencies before resolving a pending tap'
fi
if ! awk '
  /^php_darwin_install_cleanup\(\)/ { cleanup=1; next }
  cleanup && /brew link --overwrite .*linked_dependency_references/ { relinked=NR }
  cleanup && /php_darwin_restore_formula_trust >>/ { untrusted=NR }
  cleanup && /^}/ { cleanup=0 }
  END { exit !(relinked > 0 && untrusted > relinked) }
' "$installer"; then
  php_darwin_die 'standalone installer revokes formula trust before rollback relinking finishes'
fi
for signal_trap in "trap 'exit 129' HUP" "trap 'exit 130' INT" "trap 'exit 143' TERM"; do
  awk -v signal_trap="$signal_trap" '
    $0 == "# Source: scripts/install-package.sh" { install=1; next }
    install && $0 == signal_trap { found=1 }
    END { exit !found }
  ' "$installer" || \
    php_darwin_die "standalone installer omitted signal handling: $signal_trap"
done
awk -v protected_trap="trap '' HUP INT TERM" '
  $0 == "# Source: scripts/install-package.sh" { install=1; next }
  install && index($0, protected_trap) { found=1 }
  END { exit !found }
' "$installer" || \
  php_darwin_die 'standalone installer does not protect rollback from repeated cancellation signals'
grep -Fq "php_darwin_signal_job_pids TERM \"\$job_pid\" \"\${tracked_pids[@]}\"" "$installer" || \
  php_darwin_die 'standalone installer does not terminate the background job root'
grep -Fq "linked_php_reference=\$(php_darwin_keg_formula_reference \"\$brew_prefix\" \"\$linked_php_formula\"" \
  "$installer" || php_darwin_die 'standalone installer does not validate linked PHP receipts'
grep -Fq "\"\${linked_php_target#../../../}\" \"\$tap\")" "$installer" || \
  php_darwin_die 'standalone installer does not qualify custom-tap PHP formulae'
grep -Fq "linked_dependency_references+=(\"\$package_name\")" "$installer" || \
  php_darwin_die 'standalone installer does not use bare dependency formula names'
if grep -Fq "dependency_reference=\$(php_darwin_keg_formula_reference" "$installer"; then
  php_darwin_die 'standalone installer resolves core dependency taps from receipts'
fi
grep -Fq '.tap_formulae // []' "$installer" || \
  php_darwin_die 'standalone installer does not read authenticated custom-tap formula metadata'
grep -Fq "brew trust --formula \"\${formula_trust_references[@]}\"" "$installer" || \
  php_darwin_die 'standalone installer does not batch custom-tap formula trust'
grep -Fq "brew untrust --formula \"\${formulae_to_untrust[@]}\"" "$installer" || \
  php_darwin_die 'standalone installer does not restore all formula trust added by a failed install'
grep -Fq "\$php_bin -n -r" "$installer" || \
  php_darwin_die 'standalone installer allows user configuration warnings to corrupt its version probe'
if ! awk '
  /if ! php_darwin_download_release_archive/ { failed=1 }
  failed && /\$release_archive_error" = not-found/ { not_found=NR }
  failed && /php_darwin_refresh_release_manifest/ { fallback=NR; exit }
  END { exit !(not_found > 0 && fallback > not_found) }
' "$installer"; then
  php_darwin_die 'standalone installer falls back after errors other than a retired archive'
fi
if awk '
  /runtime_verified=true/ { verified=1; next }
  verified && /php_darwin_die/ { found=1 }
  END { exit !found }
' "$installer"; then
  php_darwin_die 'standalone installer can roll back after runtime verification'
fi
if ! awk '
  $0 == "# Source: scripts/install-package.sh" { install=1; next }
  install && index($0, "checksum mismatch for $asset") { verified=NR }
  install && index($0, "could not read metadata from the verified release archive") { parsed=NR }
  END { exit !(verified > 0 && parsed > verified) }
' "$installer"; then
  php_darwin_die 'standalone installer parses a release archive before checksum verification'
fi

input_count=0
while IFS= read -r relative extra; do
  [ -n "$relative" ] || continue
  case "$relative" in \#*) continue ;; esac
  [ -z "$extra" ] || php_darwin_die "invalid standalone installer input: $relative $extra"
  input_count=$((input_count + 1))
  case "$relative" in
    scripts/*)
      grep -Fxq "# Source: $relative" "$installer" || \
        php_darwin_die "standalone installer omitted readable source $relative"
      ;;
    conf/*)
      config_name=${relative#conf/}
      grep -Fq "    $config_name)" "$installer" || \
        php_darwin_die "standalone installer omitted readable configuration $relative"
      ;;
  esac
done < "$files"
printf 'Standalone installer is readable and current (%s inputs)\n' "$input_count"
