const fs = require('node:fs');
const {execFileSync} = require('node:child_process');

function command(program, args) {
  return execFileSync(program, args, {encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']});
}

function prepare({env = process.env, platform = process.platform, arch = process.arch,
  uid = process.getuid?.(), gid = process.getgid?.(), files = fs, run = command, log = console.log} = {}) {
  // Intel runner images can predate Homebrew's mandatory post-install libexec
  // directory. /usr/local itself must stay root-owned; never repair user Macs
  // or persistent self-hosted machines as a side effect of a build.
  if (platform !== 'darwin' || arch !== 'x64' || env.GITHUB_ACTIONS !== 'true' ||
      env.RUNNER_ENVIRONMENT !== 'github-hosted') return false;
  if (run('brew', ['--prefix']).trim() !== '/usr/local') return false;
  const directory = '/usr/local/libexec';
  if (!files.lstatSync('/usr/local').isDirectory()) throw new Error('Homebrew prefix must be a real directory');
  let existing;
  try { existing = files.lstatSync(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isDirectory()) throw new Error(`${directory} must be a real directory`);
    files.accessSync(directory, fs.constants.W_OK);
    return false;
  }
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) {
    throw new Error('Cannot identify the Homebrew runner owner');
  }
  // No -p: if another process created the path, stop without changing it.
  // Ownership applies only to the directory just created, never the prefix or
  // existing contents. Do not follow a replacement symlink during chown.
  run('/usr/bin/sudo', ['-n', '/bin/mkdir', '-m', '0755', directory]);
  run('/usr/bin/sudo', ['-n', '/usr/sbin/chown', '-h', `${uid}:${gid}`, directory]);
  if (!files.lstatSync(directory).isDirectory()) throw new Error(`${directory} must be a real directory`);
  files.accessSync(directory, fs.constants.W_OK);
  log(`Runner preflight: created ${directory} for Homebrew post-install hooks.`);
  return true;
}

module.exports = {prepare};
