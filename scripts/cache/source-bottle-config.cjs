const fs = require('node:fs');
const path = require('node:path');

function configurationFiles(formula, recorded = []) {
  // Uninstalling a keg leaves etc behind but removes its .bottle inventory.
  // OpenLDAP audits these two generated defaults even on a clean source build.
  // Stage them explicitly so old configuration survives dependency cleanup.
  const defaults = formula === 'openldap' ? ['etc/openldap/slapd.conf', 'etc/openldap/slapd.ldif'] : [];
  return [...new Set([...recorded, ...defaults])];
}

// Homebrew bottles only newly generated etc files. Existing configuration can
// also make formula install-time audits fail (for example OpenLDAP's inreplace).
// Temporarily stage only known defaults owned by this formula,
// then restore the user's files after build/bottle, including on failure.
function withFreshConfiguration(prefix, files = [], build) {
  if (!files.length) return build();
  const paths = [...new Set(files)].map(relative => {
    if (typeof relative !== 'string' || !relative.startsWith('etc/') ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Invalid bottle configuration path: ${relative}`);
    }
    const target = path.join(prefix, relative);
    for (let parent = path.dirname(target); parent !== prefix; parent = path.dirname(parent)) {
      let stat;
      try { stat = fs.lstatSync(parent); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat && !stat.isDirectory()) throw new Error(`Unsafe bottle configuration directory: ${parent}`);
    }
    return target;
  });
  const backup = fs.mkdtempSync(path.join(prefix, 'etc/.php-darwin-source-'));
  const staged = [];
  try {
    for (const target of paths) {
      let stat;
      try { stat = fs.lstatSync(target); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Invalid configuration file: ${target}`);
      const saved = path.join(backup, String(staged.length));
      // Leave recovery information beside the original bytes if the runner is
      // forcibly terminated and cannot execute the finally block.
      fs.appendFileSync(path.join(backup, 'paths.jsonl'), JSON.stringify({ target, saved }) + '\n');
      fs.renameSync(target, saved);
      staged.push({ target, saved });
    }
    return build();
  } finally {
    const errors = [];
    for (const { target, saved } of staged.reverse()) {
      try {
        try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.renameSync(saved, target);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `Original configuration retained for recovery in ${backup}`);
    fs.rmSync(backup, { recursive: true });
  }
}

module.exports = { configurationFiles, withFreshConfiguration };
