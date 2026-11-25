#!/bin/bash
set -euo pipefail
# Install beside homebrew-job-lock.rb outside Homebrew and runner directories.
exec /usr/bin/ruby "$(cd "$(dirname "$0")" && pwd)/homebrew-job-lock.rb"
