const fs = require('node:fs');
const path = require('node:path');

function runtimeStatePaths(paths, packages) {
  const included = new Set(packages.map(item => item.name));
  return paths.filter(relative => {
    const formula = relative.match(/^etc\/(openssl(?:@[0-9]+(?:\.[0-9]+)*)?)(?:\/|$)/)?.[1];
    return !formula || included.has(formula);
  });
}

function stage(prefix, packages, destination) {
  const openssl = packages.filter(item => /^openssl@[0-9]+(?:\.[0-9]+)*$/.test(item.name));
  if (!openssl.length) return {paths: [], links: []};
  const certificates = packages.find(item => item.name === 'ca-certificates');
  if (!certificates) throw new Error('OpenSSL cache is missing ca-certificates');
  const keg = item => {
    const parts = item.opt_target.split('/');
    if (parts.length !== 4 || parts[0] !== '..' || parts[1] !== 'Cellar' || parts[2] !== item.name ||
        !/^[A-Za-z0-9+_.-]+$/.test(parts[3]) || ['.', '..'].includes(parts[3])) throw new Error('Invalid default configuration keg');
    return path.join(prefix, ...parts.slice(1));
  };
  const paths = [], links = [];
  const copy = (source, relative) => {
    if (!fs.lstatSync(source).isFile()) throw new Error(`Missing regular default configuration: ${source}`);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(source, target);
    paths.push(relative);
  };
  // Use bottle defaults and Mozilla's CA bundle, never the build host's private
  // configuration or Keychain additions. Existing client files remain protected
  // by the installer's normal exclusion and rollback inventory.
  copy(path.join(keg(certificates), 'share/ca-certificates/cacert.pem'), 'etc/ca-certificates/cert.pem');
  for (const item of openssl) {
    copy(path.join(keg(item), `.bottle/etc/${item.name}/openssl.cnf`), `etc/${item.name}/openssl.cnf`);
    const relative = `etc/${item.name}/cert.pem`, target = '../ca-certificates/cert.pem';
    fs.symlinkSync(target, path.join(destination, relative));
    paths.push(relative);
    links.push({path: relative, target});
  }
  return {paths: paths.sort(), links};
}

module.exports = {stage, runtimeStatePaths};
if (require.main === module) {
  try {
    const [prefix, packagesFile, destination, statePathsFile] = process.argv.slice(2);
    if (prefix === 'validate-state') {
      const metadata = JSON.parse(fs.readFileSync(packagesFile, 'utf8'));
      if (runtimeStatePaths(metadata.state_paths, metadata.packages).length !== metadata.state_paths.length) {
        throw new Error('Archive contains configuration for an OpenSSL formula outside its runtime packages');
      }
      process.exit(0);
    }
    const packages = fs.readFileSync(packagesFile, 'utf8').trim().split('\n').map(line => {
      const [name, opt_target] = line.split('\t'); return {name, opt_target};
    });
    const defaults = stage(prefix, packages, destination);
    if (statePathsFile) {
      const paths = fs.readFileSync(statePathsFile, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(statePathsFile, runtimeStatePaths(paths, packages).join('\n') + '\n');
    }
    console.log(JSON.stringify(defaults));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
