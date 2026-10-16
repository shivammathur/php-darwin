// The child never inherits the Actions console. Keep diagnostic output private,
// including failure messages and embedded GitHub workflow commands.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {storage, prefix, workdir} = require('./store.cjs');
async function run(label, program, args) {
  if (!/^[a-z0-9_-]+$/.test(label || '') || !program) throw new Error('Invalid private step');
  const log = path.join(workdir(), `${label}.log`), fd = fs.openSync(log, 'w', 0o600);
  console.log('Private operation started; detailed diagnostics are stored in R2.');
  let child;
  const forward = signal => { if (child) child.kill(signal); };
  process.on('SIGTERM', () => forward('SIGTERM')); process.on('SIGINT', () => forward('SIGINT'));
  let status = 1;
  try {
    status = await new Promise(resolve => {
      child = spawn(program, args, {stdio: ['ignore', fd, fd]});
      child.on('error', error => { fs.writeSync(fd, String(error)); resolve(1); });
      child.on('close', code => resolve(code ?? 1));
    });
  } finally {
    if (/^(build|test)-/.test(label)) {
      const cleanup = await new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(__dirname, 'release.cjs'), 'clean-local'], {stdio: ['ignore', fd, fd]});
        child.on('error', () => resolve(false)); child.on('close', code => resolve(code === 0));
      });
      if (!cleanup) status = 1;
    }
    fs.closeSync(fd);
  }
  // Upload diagnostics in a separate captured child as store helpers themselves
  // can print keys and errors. Never print or tail either log on failure.
  const transferLog = fs.openSync(path.join(workdir(), `${label}-transfer.log`), 'w', 0o600);
  const uploaded = await new Promise(resolve => {
    const transfer = spawn(process.execPath, [__filename, '--upload', label, log], {stdio: ['ignore', transferLog, transferLog]});
    transfer.on('error', () => resolve(false)); transfer.on('close', code => resolve(code === 0));
  });
  fs.closeSync(transferLog);
  if (uploaded && status === 0) fs.rmSync(workdir(), {recursive: true, force: true});
  console.log(status === 0 && uploaded ? 'Private operation completed.' : 'Private operation failed; inspect private R2 diagnostics.');
  process.exitCode = status === 0 && uploaded ? 0 : 1;
}
if (process.argv[2] === '--upload') {
  const [label, file] = process.argv.slice(3);
  storage().ensure(file, `${prefix()}/logs/${label}.log`, {replace: false, contentType: 'text/plain'})
    .catch(() => { process.exitCode = 1; });
} else run(...process.argv.slice(2, 4), process.argv.slice(4)).catch(() => {
  console.error('Private operation could not start.'); process.exitCode = 1;
});
