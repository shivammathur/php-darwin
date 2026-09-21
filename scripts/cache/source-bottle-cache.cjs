const { spawnSync } = require('node:child_process');

function command(program, args, { inherit = false, cwd, env } = {}) {
  const result = spawnSync(program, args, {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed (${result.status})`);
  return result.stdout || '';
}

module.exports = { command };
