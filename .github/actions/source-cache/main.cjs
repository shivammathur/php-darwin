const fs = require('node:fs');
const path = require('node:path');
const { install, command, extensionInputs } = require('../../../scripts/source-bottle-cache.cjs');
const { ReleaseCache } = require('../../../scripts/source-bottle-releases.cjs');

async function main() {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Source bottle installation requires a macOS Actions runner');
  }
  const cache = new ReleaseCache({ tag: process.env.INPUT_RELEASE || 'cache' });
  if (process.argv[2] === 'install-extensions') {
    const [abstract, phpPrefix, ...formulae] = process.argv.slice(3);
    const context = extensionInputs(abstract, phpPrefix, process.env.BUILD, process.env.TS);
    const result = { built: 0, restored: 0 };
    for (const formula of formulae) {
      const installed = await install({ formula, cache, context, skipLink: true,
        forceSource: process.env.BUILD !== 'release' || process.env.TS !== 'nts' || process.env['INPUT_FORCE-SOURCE'] === 'true' });
      result.built += installed.built;
      result.restored += installed.restored;
    }
    writeOutputs(result);
    return;
  }
  if (process.env.INPUT_STAGE === 'extensions') {
    command('bash', ['scripts/build-extensions.sh'], { inherit: true,
      env: { PHP_DARWIN_SOURCE_CACHE_NODE: process.execPath,
        PHP_DARWIN_SOURCE_CACHE_ACTION: path.join(__dirname, 'main.cjs') } });
    return;
  }
  if (process.env.INPUT_STAGE && process.env.INPUT_STAGE !== 'php') throw new Error('Invalid source cache stage');
  const override = process.env.INPUT_FORMULA;
  const formula = override || command('bash', ['-c',
    '. scripts/lib.sh; requested=$(php_darwin_requested_formula "$PHP_VERSION" "$BUILD" "$TS") || exit 1; printf "%s/%s" "$(php_darwin_package_config tap)" "$requested"'
  ]).trim();
  const result = await install({ formula, cache, forceSource: process.env['INPUT_FORCE-SOURCE'] === 'true' });
  if (!override) command('bash', ['scripts/build.sh', 'install'], { inherit: true });
  writeOutputs(result);
}

function writeOutputs(result) {
  for (const [name, value] of Object.entries(result)) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
