const fs = require('node:fs');
const { install, command } = require('../../../scripts/source-bottle-cache.cjs');

async function main() {
  const cache = await import('@actions/cache');
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Source bottle installation requires a macOS Actions runner');
  }
  const override = process.env.INPUT_FORMULA;
  const formula = override || command('bash', ['-c',
    '. scripts/lib.sh; requested=$(php_darwin_requested_formula "$PHP_VERSION" "$BUILD" "$TS") || exit 1; printf "%s/%s" "$(php_darwin_package_config tap)" "$requested"'
  ]).trim();
  const result = await install({ formula, cache });
  if (!override) command('bash', ['scripts/build.sh', 'install'], { inherit: true });
  for (const [name, value] of Object.entries(result)) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
