#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../../lib/lib.sh"
work_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/php-darwin-test-mirror.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
mkdir "$work_dir/bin" "$work_dir/staging" "$work_dir/objects"
export PHP_DARWIN_TEST_READS="$work_dir/reads"
export PHP_DARWIN_TEST_R2="$work_dir/objects" PHP_DARWIN_TEST_UPLOADS="$work_dir/uploads"
export CF_R2_AWS_ACCESS_KEY_ID=fixture CF_R2_AWS_SECRET_ACCESS_KEY=fixture CF_R2_AWS_S3_ENDPOINT=https://fixture.invalid
export PHP_DARWIN_MIRROR_URL=https://mirror.invalid PHP_VERSION=8.3
export PHP_DARWIN_R2_FIXTURE="$script_dir/../helpers/r2-fixture.cjs"
cat > "$work_dir/bin/aws" <<'MOCK'
#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { info } = require(process.env.PHP_DARWIN_R2_FIXTURE);
const args = process.argv.slice(2), operation = args[3], key = args[args.indexOf('--key') + 1];
const file = path.join(process.env.PHP_DARWIN_TEST_R2, key);
if (operation === 'head-object') {
  if (!fs.existsSync(file)) { console.error('An error occurred (404) when calling the HeadObject operation: Not Found'); process.exit(1); }
  console.log(JSON.stringify(info(fs.readFileSync(file))));
} else if (operation === 'get-object') {
  fs.copyFileSync(file, args.at(-1));
  console.log(JSON.stringify(info(fs.readFileSync(file))));
} else if (operation === 'put-object') {
  if (process.env.PHP_DARWIN_TEST_FAIL_UPLOAD === key) { console.error('AccessDenied'); process.exit(1); }
  const body = fs.readFileSync(args[args.indexOf('--body') + 1]);
  require('node:assert/strict').equal(args[args.indexOf('--content-md5') + 1], crypto.createHash('md5').update(body).digest('base64'));
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
  fs.appendFileSync(process.env.PHP_DARWIN_TEST_UPLOADS, key + '\n');
  console.log(JSON.stringify({ ETag: info(body).ETag }));
} else throw new Error('Unexpected S3 operation ' + operation);
MOCK
cat > "$work_dir/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in https://mirror.invalid/*) url=$1; name=${1#https://mirror.invalid/}; name=${name%%\?*} ;; --retry) shift; [ "$1" = 0 ] ;; -o|--output) shift; output=$1 ;; esac
  shift
done
printf '%s\n' "$url" >> "$PHP_DARWIN_TEST_READS"
if [ "${PHP_DARWIN_TEST_FAIL_READ:-}" = "$name" ]; then printf '200'; exit 28; fi
if [ "${PHP_DARWIN_TEST_TRANSIENT_READ:-}" = "$name" ] && \
  [ "$(grep -c "$name" "$PHP_DARWIN_TEST_READS")" -lt 3 ]; then printf '524'; exit 22; fi
if [ "${PHP_DARWIN_TEST_FORBIDDEN_READ:-}" = "$name" ]; then printf '403'; exit 22; fi
if [ "${PHP_DARWIN_TEST_STALE_READ:-}" = "$name" ] && [[ "$url" != *'?verify='* ]]; then
  printf '404'; exit 22
fi
[ -f "$PHP_DARWIN_TEST_R2/$name" ] || { printf '404'; exit 22; }
printf '200'
cp "$PHP_DARWIN_TEST_R2/$name" "$output"
MOCK
printf '#!/usr/bin/env bash\nexit 0\n' > "$work_dir/bin/sleep"
chmod +x "$work_dir/bin/"*
export PATH="$work_dir/bin:$PATH"
count_reads() {
  awk -v name="$1" '{ sub(/\?.*/, ""); sub(/.*\//, ""); if ($0 == name) n++ } END { print n+0 }' "$work_dir/reads"
}
printf '#!/usr/bin/env bash\nexit 0\n' > "$work_dir/staging/install.sh"
printf 'fixture' > "$work_dir/fixture"
hash=$(php_darwin_sha256 "$work_dir/fixture")
while read -r build ts; do
  for arch in arm64 x86_64; do
    asset=$(php_darwin_asset 8.3 "$build" "$ts" "$arch")
    name=$(php_darwin_download_asset "$asset" "$hash")
    cp "$work_dir/fixture" "$work_dir/staging/$name"
    printf '%s  %s\n' "$hash" "$name" > "$work_dir/staging/$name.sha256"
    jq -cn --arg name "$asset" --arg download "$name" --arg sha256 "$hash" --arg build "$build" \
      --arg thread_safety "$ts" --arg architecture "$arch" \
      --argjson minimum_macos "$(php_darwin_platform_value "$arch" minimum_macos)" \
      '{name:$name,download:$download,sha256:$sha256,build:$build,thread_safety:$thread_safety,
        architecture:$architecture,minimum_macos:$minimum_macos,bytes:7}' >> "$work_dir/assets"
  done
done < <(php_darwin_configured_variants)
jq -n --slurpfile assets "$work_dir/assets" --arg hash "$hash" \
  '{schema:1,assets:$assets,php_version:"8.3",php_semver:"8.3.1",php_src_commit:"",source_hash:$hash,
    extensions_source_hash:$hash,homebrew_php_commit:("a"*40),homebrew_extensions_commit:("a"*40)}' \
  > "$work_dir/staging/php-8.3-manifest.json"
bash "$script_dir/../../release/mirror-release.sh" "$work_dir/staging" > "$work_dir/log" 2>&1
[ "$(tail -1 "$work_dir/uploads")" = php-8.3/php-8.3-manifest.json ] || php_darwin_die 'manifest was not committed last'
[ "$(wc -l < "$work_dir/uploads" | tr -d ' ')" = 18 ] || php_darwin_die 'mirror omitted release files'
: > "$work_dir/uploads"
bash "$script_dir/../../release/mirror-release.sh" "$work_dir/staging" > "$work_dir/log" 2>&1
! grep -Eq '\.tar\.zst$' "$work_dir/uploads" || php_darwin_die 'verified archives were uploaded again'
: > "$work_dir/uploads"
mv "$work_dir/staging/$name" "$work_dir/saved-archive"
printf "#!/usr/bin/env bash\n# refreshed installer\nexit 0\n" > "$work_dir/staging/install.sh"
bash "$script_dir/../../release/mirror-release.sh" "$work_dir/staging" installer-only > "$work_dir/log" 2>&1
[ "$(cat "$work_dir/uploads")" = php-8.3/install.sh ] || php_darwin_die 'installer refresh transferred other assets'
mv "$work_dir/saved-archive" "$work_dir/staging/$name"
cp "$work_dir/staging/php-8.3-manifest.json" "$work_dir/saved-manifest"
jq '.php_semver="8.3.2"' "$work_dir/saved-manifest" > "$work_dir/staging/php-8.3-manifest.json"
: > "$work_dir/uploads"
if bash "$script_dir/../../release/mirror-release.sh" "$work_dir/staging" installer-only > "$work_dir/log" 2>&1; then
  php_darwin_die 'installer refresh accepted an unverified artifact generation'
fi
[ ! -s "$work_dir/uploads" ] || php_darwin_die 'unverified generation mutated the mirror'
mv "$work_dir/saved-manifest" "$work_dir/staging/php-8.3-manifest.json"
# A transport failure has bounded read retries and must never trigger an upload.
: > "$work_dir/uploads"
: > "$work_dir/reads"
export PHP_DARWIN_TEST_FAIL_READ=php-8.3/$name
if bash "$script_dir/../../release/mirror-release.sh" "$work_dir/staging" > "$work_dir/log" 2>&1; then
  php_darwin_die 'mirror accepted a transport failure'
fi
[ "$(count_reads "$name")" = 3 ] || php_darwin_die 'mirror exceeded its bounded read attempts'
! grep -Eq '(install.sh|manifest.json|\.tar\.zst)$' "$work_dir/uploads" || php_darwin_die 'read failure mutated release data'
unset PHP_DARWIN_TEST_FAIL_READ
# Transient 524s recover without reuploading archives; authorization errors stop after three attempts.
: > "$work_dir/reads"
: > "$work_dir/uploads"
export PHP_DARWIN_TEST_TRANSIENT_READ=php-8.3/$name
bash "$script_dir/../../release/mirror-release.sh" "$work_dir/staging" > "$work_dir/log" 2>&1
[ "$(count_reads "$name")" = 3 ] || php_darwin_die 'mirror did not recover a transient 524'
! grep -Eq '\.tar\.zst$' "$work_dir/uploads" || php_darwin_die 'transient read failure reuploaded an archive'
unset PHP_DARWIN_TEST_TRANSIENT_READ
: > "$work_dir/reads"
export PHP_DARWIN_TEST_FORBIDDEN_READ=php-8.3/$name
if bash "$script_dir/../../release/mirror-release.sh" "$work_dir/staging" > "$work_dir/log" 2>&1; then
  php_darwin_die 'mirror accepted an authorization failure'
fi
[ "$(count_reads "$name")" = 3 ] || php_darwin_die 'mirror authorization retries were not bounded'
unset PHP_DARWIN_TEST_FORBIDDEN_READ
# A cached negative response after upload must not block public byte verification.
export PHP_DARWIN_TEST_STALE_READ=php-8.3/$name
bash "$script_dir/../../release/mirror-release.sh" "$work_dir/staging" > "$work_dir/log" 2>&1
unset PHP_DARWIN_TEST_STALE_READ
# Invalid local input must not replace the public installer or manifest.
printf 'corrupt' > "$work_dir/staging/$name"
: > "$work_dir/uploads"
if bash "$script_dir/../../release/mirror-release.sh" "$work_dir/staging" > "$work_dir/log" 2>&1; then
  php_darwin_die 'mirror accepted corrupt local data'
fi
[ ! -s "$work_dir/uploads" ] || php_darwin_die 'invalid input mutated the mirror'
cp "$work_dir/fixture" "$work_dir/staging/$name"
rm "$work_dir/objects/php-8.3/$name"
export PHP_DARWIN_TEST_FAIL_UPLOAD=php-8.3/$name
if bash "$script_dir/../../release/mirror-release.sh" "$work_dir/staging" > "$work_dir/log" 2>&1; then
  php_darwin_die 'mirror accepted failed archive upload'
fi
! grep -Eq '(install.sh|manifest.json)$' "$work_dir/uploads" || php_darwin_die 'failed upload advanced a commit point'
printf 'R2 validation passed: verified reuse, corrupt input rejection, and commit ordering\n'
