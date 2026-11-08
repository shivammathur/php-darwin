const { spawnSync } = require('node:child_process');
const path = require('node:path');

function cleanupBuildDirectory(directory) {
  if (!path.isAbsolute(directory) || path.resolve(directory) === '/') throw new Error('Invalid build fixture directory');
  // A source build can contain both user-owned files and root-owned .libs.
  // Use rm's exit status rather than Node's platform-dependent rimraf error.
  const result = spawnSync('/bin/bash', ['-eu', '-c', `
    if [ -e "$1" ] || [ -L "$1" ]; then
      /bin/rm -rf -- "$1" 2>/dev/null || /usr/bin/sudo -n /bin/rm -rf -- "$1"
    fi
    [ ! -e "$1" ] && [ ! -L "$1" ]
  `, 'cleanup-build-fixture', directory], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Build fixture cleanup failed: ${result.error?.message || result.signal || result.status}`);
  }
}

module.exports = { cleanupBuildDirectory };
