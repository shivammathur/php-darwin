#!/usr/bin/env bash
set -euo pipefail
bash "$(dirname "${BASH_SOURCE[0]}")/network-tools.sh"
# Use AWS's standalone distribution: Homebrew cleanup removes brew's awscli
# and Python, and the log upload must continue working after that cleanup.
if [ "$(uname -s)" = Darwin ]; then
  if [ ! -x /usr/local/aws-cli/aws ]; then
    /usr/bin/curl --fail --silent --show-error --location --retry 2 --retry-all-errors \
      https://awscli.amazonaws.com/AWSCLIV2.pkg -o "${RUNNER_TEMP:?}/AWSCLIV2.pkg"
    pkgutil --check-signature "$RUNNER_TEMP/AWSCLIV2.pkg" | \
      grep -F 'Developer ID Installer: AMZN Mobile LLC (94KV3E626L)'
    sudo installer -pkg "$RUNNER_TEMP/AWSCLIV2.pkg" -target / >/dev/null
  fi
  test -x /usr/local/aws-cli/aws
  echo /usr/local/aws-cli >> "${GITHUB_PATH:?}"
else
  command -v aws >/dev/null
fi
