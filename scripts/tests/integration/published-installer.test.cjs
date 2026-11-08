const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const script = `set -euo pipefail
. scripts/lib/lib.sh
. scripts/tests/helpers/published-installer.sh
php_darwin_request_release() {
  printf '%s\\n' "$1" >> "$REQUESTS"
  case "$1" in https://github.com/*) provider=github;; *) provider=mirror;; esac
  if [ "$FAIL_PROVIDER" = "$provider" ] || [ "$FAIL_PROVIDER" = both ]; then
    printf '504\\n'; return 56
  fi
  if [ "$INVALID_PROVIDER" = "$provider" ]; then
    printf '<html>bad gateway</html>\\n' > "$2"
  else
    printf '#!/bin/sh\\n# verified fixture installer\\n' > "$2"
  fi
  printf '200\\n'
}
php_darwin_fetch_published_installer 8.5 "$DESTINATION"
`;
for (const scenario of [
  {name: 'GitHub outage', fail: 'github', expected: ['github', 'mirror']},
  {name: 'invalid successful response', invalid: 'github', expected: ['github', 'mirror']},
  {name: 'preferred mirror', prefer: true, fail: 'github', expected: ['mirror']},
  {name: 'mirror outage', prefer: true, fail: 'mirror', expected: ['mirror', 'github']},
  {name: 'both origins unavailable', fail: 'both', expected: ['github', 'mirror'], status: 1},
  {name: 'explicitly disabled mirror', fail: 'github', disabled: true, expected: ['github'], status: 1},
]) test(`published installer bootstrap handles ${scenario.name}`, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'published-installer-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const requests = path.join(directory, 'requests'), destination = path.join(directory, 'installer.sh');
  const env = {...process.env, REQUESTS: requests, DESTINATION: destination,
    FAIL_PROVIDER: scenario.fail || '', INVALID_PROVIDER: scenario.invalid || '',
    PHP_DARWIN_PREFER_MIRROR: String(Boolean(scenario.prefer))};
  delete env.PHP_DARWIN_MIRROR_URL;
  if (scenario.disabled) env.PHP_DARWIN_MIRROR_URL = '';
  const result = spawnSync('bash', ['-c', script], {encoding: 'utf8', env});
  assert.equal(result.status, scenario.status || 0, result.stderr);
  const urls = fs.readFileSync(requests, 'utf8').trim().split('\n');
  assert.deepEqual(urls, scenario.expected.map(origin => origin === 'github'
    ? 'https://github.com/shivammathur/php-darwin/releases/download/php-8.5/install.sh'
    : 'https://artifacts.php-darwin.setup-php.com/php-8.5/install.sh'));
  if (!scenario.status) assert.equal(fs.readFileSync(destination, 'utf8'), '#!/bin/sh\n# verified fixture installer\n');
});
