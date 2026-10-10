const {command} = require('./source-bottle-cache.cjs');

// Individual workers may compile only their own formula. The final approval
// run consumes prepared bottles and must fail before starting any compiler.
function buildGuard(formula, run = command) {
  return (program, args, options) => {
    if (program === 'brew' && args[0] === 'php-darwin-source' && args[1] === 'install' &&
        (!formula || args.at(-1) !== formula)) {
      throw new Error(`Prepared dependency cache is missing: ${args.at(-1)}; build its worker first`);
    }
    if (program === 'brew' && ['install', 'reinstall'].includes(args[0]) && !args.includes('--force-bottle')) {
      args = [...args.slice(0, 1), '--force-bottle', ...args.slice(1)];
    }
    return run(program, args, options);
  };
}
module.exports = {buildGuard};
