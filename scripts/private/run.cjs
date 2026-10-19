// The child never inherits the Actions console. Keep diagnostic output private,
// including failure messages and embedded GitHub workflow commands.
const fs = require('node:fs');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {storage, prefix, workdir} = require('./store.cjs');
async function uploadLog(label, log) {
  const fd = fs.openSync(path.join(workdir(), `${label}-transfer.log`), 'w', 0o600);
  try {
    return await new Promise(resolve => {
      const transfer = spawn(process.execPath, [__filename, '--upload', label, log], {stdio: ['ignore', fd, fd]});
      transfer.on('error', () => resolve(false)); transfer.on('close', code => resolve(code === 0));
    });
  } finally { fs.closeSync(fd); }
}
async function run(label, program, args) {
  if (!/^[a-z0-9_-]+$/.test(label || '') || !program) throw new Error('Invalid private step');
  const log = path.join(workdir(), `${label}.log`), fd = fs.openSync(log, 'w', 0o600);
  // GitHub file commands bypass captured stdout/stderr. Only the planner may
  // expose its validated matrix; all other child channels remain job-local.
  const env = {...process.env};
  for (const name of ['GITHUB_STEP_SUMMARY', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STATE', 'GITHUB_OUTPUT']) {
    if (name === 'GITHUB_OUTPUT' && label === 'plan') continue;
    if (env[name]) env[name] = path.join(workdir(), `${label}-${name.toLowerCase()}`);
  }
  console.log('Private operation started; detailed diagnostics are stored in R2.');
  let child;
  const forward = signal => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  process.on('SIGTERM', () => forward('SIGTERM')); process.on('SIGINT', () => forward('SIGINT'));
  let status = 1;
  try {
    status = await new Promise(resolve => {
      child = spawn(program, args, {env, detached: true, stdio: ['ignore', fd, fd]});
      child.on('error', error => { fs.writeSync(fd, String(error)); resolve(1); });
      child.on('close', code => resolve(code ?? 1));
    });
  } finally {
    if (/^(build|test)-/.test(label)) {
      const cleanup = await new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(__dirname, 'release.cjs'), 'clean-local'], {env, stdio: ['ignore', fd, fd]});
        child.on('error', () => resolve(false)); child.on('close', code => resolve(code === 0));
      });
      if (!cleanup) status = 1;
    }
    const summary = path.join(workdir(), `${label}-github_step_summary`);
    if (fs.existsSync(summary)) {
      fs.writeSync(fd, '\nPrivate step summary:\n');
      fs.writeSync(fd, fs.readFileSync(summary));
    }
    fs.closeSync(fd);
  }
  // Upload diagnostics in a separate captured child as store helpers themselves
  // can print keys and errors. Never print or tail either log on failure.
  const uploaded = await uploadLog(label, log);
  if (uploaded && status === 0) {
    try {
      if (process.env.GITHUB_ACTIONS === 'true') {
        // Homebrew leaves protected build scratch files on hosted runners.
        // Remove only our fixed job-local directory; rm does not follow symlinks.
        const removed = spawnSync('sudo', ['-n', 'rm', '-rf', '--', workdir()], {encoding: 'utf8'});
        if (removed.error || removed.status !== 0) throw removed.error || new Error(removed.stderr || 'Private workspace removal failed');
      } else fs.rmSync(workdir(), {recursive: true, force: true});
    } catch (error) {
      status = 1;
      const diagnostic = path.join(workdir(), `${label}-cleanup.log`);
      fs.writeFileSync(diagnostic, String(error), {mode: 0o600});
      await uploadLog(`${label}-cleanup`, diagnostic);
    }
  }
  console.log(status === 0 && uploaded ? 'Private operation completed.' : 'Private operation failed; inspect private R2 diagnostics.');
  process.exitCode = status === 0 && uploaded ? 0 : 1;
}
if (process.argv[2] === '--upload') {
  const [label, file] = process.argv.slice(3);
  storage().ensure(file, `${prefix()}/logs/${label}.log`, {replace: false, contentType: 'text/plain'})
    .catch(() => { process.exitCode = 1; });
} else run(...process.argv.slice(2, 4), process.argv.slice(4)).catch(() => {
  console.error('Private operation failed before completion.'); process.exitCode = 1;
});
