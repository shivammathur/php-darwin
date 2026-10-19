#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/preinstalled/bin" "$fixture/temp with spaces"
cat > "$fixture/preinstalled/bin/uname" <<'EOF'
#!/bin/sh
printf 'Darwin\n'
EOF
cat > "$fixture/preinstalled/bin/curl" <<'EOF'
#!/bin/sh
printf 'preinstalled curl is missing its OpenSSL dependency\n' >&2
exit 97
EOF
chmod +x "$fixture/preinstalled/bin/"*
export RUNNER_TEMP="$fixture/temp with spaces"
export GITHUB_PATH="$fixture/github-path" GITHUB_ENV="$fixture/github-env"
export PATH="$fixture/preinstalled/bin:$PATH"
export HOMEBREW_FORCE_BREWED_CURL=1
if curl --version >/dev/null 2>&1; then
  echo 'The preinstalled dependency failure was not reproduced' >&2; exit 1
fi
bash "$root/scripts/private/network-tools.sh"
export PATH="$(cat "$GITHUB_PATH"):$PATH"
set -a
. "$GITHUB_ENV"
set +a
curl --version >/dev/null
"$HOMEBREW_CURL_PATH" --version >/dev/null
test -z "$HOMEBREW_FORCE_BREWED_CURL"
# A new child must keep downloading after the preinstalled tool is removed.
rm -rf "$fixture/preinstalled"
bash -c 'curl --version >/dev/null; "$HOMEBREW_CURL_PATH" --version >/dev/null'
printf 'Private downloads survive broken and removed Homebrew curl dependencies\n'
