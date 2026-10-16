const fs = require('node:fs');
const path = require('node:path');
function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:(alpha|beta|RC)(\d+))?$/.exec(version || '');
  if (!m) throw new Error('Invalid stable PHP version');
  return [...m.slice(1, 4).map(BigInt), BigInt({alpha: 0, beta: 1, RC: 2}[m[4]] ?? 3), BigInt(m[5] || 0)];
}
function older(candidate, published) {
  const a = parse(candidate), b = parse(published);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
function tapBehind(manifest, directory) {
  if (!directory) return false;
  const formulae = path.join(directory, 'Formula');
  return fs.readdirSync(formulae).filter(name => /^php(?:@\d+\.\d+)?(?:-debug)?(?:-zts)?\.rb$/.test(name)).some(name => {
    const text = fs.readFileSync(path.join(formulae, name), 'utf8');
    const version = text.match(/^  version "([^"]+)"$/m)?.[1] ||
      text.match(/^  url "[^"\n]*\/php-(\d+\.\d+\.\d+(?:(?:alpha|beta|RC)\d+)?)\.tar\./m)?.[1];
    return version?.startsWith(manifest.php_version + '.') && older(version, manifest.php_semver);
  });
}
module.exports = {older, tapBehind};
if (require.main === module) {
  try {
    const [mode, a, b] = process.argv.slice(2);
    if (mode === 'older') console.log(older(a, b));
    else if (mode === 'tap-behind') console.log(tapBehind(JSON.parse(fs.readFileSync(a)), process.env.HOMEBREW_PHP_PATH));
    else throw new Error('Unknown stable version operation');
  } catch (error) { console.error(error); process.exitCode = 1; }
}
