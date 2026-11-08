const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

for (const core of [false, true]) for (const available of [[], ['jq'], ['jq', 'zstd']]) {
  test(`archive tools preserve existing tools and ${core ? 'pinned core' : 'API resolution'} (${available.join(',') || 'cold'})`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tools-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const bin = path.join(root, 'bin'), repository = path.join(root, 'Homebrew');
    fs.mkdirSync(bin); fs.mkdirSync(repository);
    if (core) fs.mkdirSync(path.join(repository, 'Library/Taps/homebrew/homebrew-core'), {recursive: true});
    const calls = path.join(root, 'calls');
    fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
    for (const tool of available) fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n', {mode: 0o755});
    const guard = `
[ "\${HOMEBREW_NO_INSTALL_FROM_API:-}" = "$EXPECTED_API_FLAG" ] || exit 91
[ "$HOMEBREW_NO_AUTO_UPDATE/$HOMEBREW_NO_INSTALL_CLEANUP/$HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK" = 1/1/1 ] || exit 92
`;
    fs.writeFileSync(path.join(bin, 'brew'), `#!/bin/bash
if [ "$1" = --repository ]; then printf '%s\\n' "$FIXTURE_REPOSITORY"; exit 0; fi
${guard}
printf 'brew %s\\n' "$*" >> "$FIXTURE_CALLS"
`, {mode: 0o755});
    // The preserved Actions runtime remains usable with no Node on PATH.
    const runtime = path.join(root, 'actions-node');
    fs.writeFileSync(runtime, `#!/bin/bash
${guard}
shift
printf 'prefetch %s\\n' "$*" >> "$FIXTURE_CALLS"
`, {mode: 0o755});
    const result = spawnSync('/bin/bash', ['-c', '/bin/bash "$1"; status=$?; [ "$HOMEBREW_NO_INSTALL_FROM_API" = 1 ] || exit 93; exit "$status"',
      'archive-test', path.resolve('scripts/build/archive-tools.sh')], {
      encoding: 'utf8', env: {...process.env, PATH: bin, PHP_DARWIN_NODE: runtime,
        HOMEBREW_NO_INSTALL_FROM_API: '1', EXPECTED_API_FLAG: core ? '1' : '',
        FIXTURE_REPOSITORY: repository, FIXTURE_CALLS: calls},
    });
    assert.equal(result.status, 0, result.stderr);
    const missing = ['jq', 'zstd'].filter(tool => !available.includes(tool));
    assert.equal(fs.existsSync(calls), missing.length > 0);
    if (missing.length) assert.equal(fs.readFileSync(calls, 'utf8'),
      `prefetch ${missing.join(' ')}\n`);
    assert.equal(fs.existsSync(path.join(repository, 'Library/Taps/homebrew/homebrew-core')), core);
  });
}
