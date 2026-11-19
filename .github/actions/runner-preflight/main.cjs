async function main() {
  await require('../../../scripts/build/recover-runner.cjs').recover().catch(() => {
    console.warn('Runner preflight: recovery unavailable; continuing without automatic cleanup.');
  });
  require('../../../scripts/build/prepare-homebrew-prefix.cjs').prepare();
}

main().catch(error => {
  console.error(`Runner preflight: ${error.message}`);
  process.exitCode = 1;
});
