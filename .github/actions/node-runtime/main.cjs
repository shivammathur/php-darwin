const fs = require('node:fs');
const path = require('node:path');

// Homebrew cleanup removes its Node formula. JavaScript actions use the
// runner's own runtime, whose absolute path survives that cleanup.
fs.appendFileSync(process.env.GITHUB_ENV, `PHP_DARWIN_NODE=${process.execPath}\n`);

// Dependency cleanup can remove libraries used by a preinstalled Homebrew
// curl before its approved replacement is restored. Bootstrap every download,
// including Homebrew's own transfers, with the independent macOS curl.
if (process.platform === 'darwin') {
  const bin = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'php-darwin-tools-'));
  fs.symlinkSync('/usr/bin/curl', path.join(bin, 'curl'));
  fs.appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
  fs.appendFileSync(process.env.GITHUB_ENV, 'HOMEBREW_CURL_PATH=/usr/bin/curl\n');
}
