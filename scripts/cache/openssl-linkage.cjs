const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const mach = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);

function libraryLinks(prefix, inspect = file => execFileSync('otool', ['-L', file], {encoding: 'utf8'})) {
  const links = [];
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    } else if (stat.isFile() && stat.size >= 4) {
      const header = Buffer.alloc(4), fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (!mach.has(header.toString('hex'))) return;
      // Java classes use the same magic as a universal Mach-O header.
      if (['cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex')) &&
          !execFileSync('file', ['-b', file], {encoding: 'utf8'}).includes('Mach-O')) return;
      for (const match of inspect(file).matchAll(/^\s+(\S+) \(compatibility version /gm)) {
        links.push({file, library: match[1]});
      }
    }
  }
  for (const directory of ['bin', 'sbin', 'lib', 'libexec', 'Frameworks']) {
    const file = path.join(prefix, directory);
    if (fs.existsSync(file)) visit(file);
  }
  return links;
}

function verifyOpenSslLinkage(prefix, major, inspect) {
  if (!/^[0-9]+$/.test(String(major))) throw new Error('Invalid expected OpenSSL major');
  let checked = 0;
  for (const {file, library} of libraryLinks(prefix, inspect)) {
    const match = library.match(/\/lib(?:ssl|crypto)\.([0-9]+)\.dylib$/);
    if (!match) continue;
    if (match[1] !== String(major)) throw new Error(`${file} links OpenSSL ${match[1]}, expected ${major}`);
    checked++;
  }
  return checked;
}

function verifyRuntimeLinkage(prefix, brewPrefix, dependencies, inspect) {
  const allowed = new Set(dependencies);
  for (const {file, library} of libraryLinks(prefix, inspect)) {
    if (!library.startsWith(brewPrefix + '/')) continue;
    const match = library.slice(brewPrefix.length).match(/^\/(?:opt|Cellar)\/([^/]+)\//);
    if (match && !allowed.has(match[1])) throw new Error(`${file} links undeclared runtime dependency ${match[1]}: ${library}`);
  }
}

module.exports = {verifyOpenSslLinkage, verifyRuntimeLinkage};
