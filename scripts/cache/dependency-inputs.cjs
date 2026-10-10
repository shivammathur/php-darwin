const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function capture(repositories) {
  const records = {};
  for (const [name, directory] of Object.entries(repositories)) {
    const files = execFileSync('git', ['-C', directory, 'ls-files', '*.rb'], {encoding:'utf8'}).trim().split('\n').filter(Boolean);
    if (!files.length) throw new Error(`Missing tap formulae: ${name}`);
    const formulae = files.filter(file => file.startsWith('Formula/')).map(file => path.join(directory, file));
    const parsed = JSON.parse(execFileSync(process.env.PHP_DARWIN_RUBY || 'ruby', [path.join(__dirname, 'dependency-inputs.rb')],
      {input:JSON.stringify(formulae), encoding:'utf8', maxBuffer:16*1024*1024}));
    for (const file of files) {
      const value = file.startsWith('Formula/') ? parsed[path.join(directory,file)] : fs.readFileSync(path.join(directory,file),'utf8');
      const formulae = [...new Set([...JSON.stringify(value).matchAll(/"@tstring_content","([a-z0-9][a-z0-9@+_.-]*)"/g)].map(match=>match[1]))].sort();
      const declarations = Array.isArray(value) ? Object.fromEntries(value.map(item => [hash(item),
        [...new Set([...JSON.stringify(item).matchAll(/"@tstring_content","([a-z0-9][a-z0-9@+_.-]*)"/g)].map(match => match[1]))].sort()])) : undefined;
      records[`${name}/${file}`] = {sha256:hash(value), formulae, ...(declarations ? {declarations} : {})};
    }
  }
  // Most extension variants share declarations. Store each projection once
  // so the approved snapshot remains small enough for the GitHub contents API.
  const definitions = {}, references = {};
  for (const [file, record] of Object.entries(records)) {
    definitions[record.sha256] = record; references[file] = record.sha256;
  }
  return {schema:1, sha256:hash(references), records:references, definitions};
}
function changed(previous, next) {
  if (!previous?.records) return {changed:true, formulae:[], bootstrap:true};
  const formulae = new Set(); let different=false, shared=false;
  for (const key of new Set([...Object.keys(previous.records),...Object.keys(next.records)])) {
    const lookup = (inputs, key) => typeof inputs.records[key] === 'string' ? inputs.definitions?.[inputs.records[key]] : inputs.records[key];
    const before=lookup(previous, key), after=lookup(next, key);
    if ((previous.records[key] && !before) || (next.records[key] && !after)) throw new Error('Missing dependency input definition');
    if (before?.sha256===after?.sha256) continue;
    different=true;
    if (!key.includes('/Formula/')) shared=true;
    if (before?.declarations && after?.declarations) {
      for (const hash of new Set([...Object.keys(before.declarations), ...Object.keys(after.declarations)])) {
        if (before.declarations[hash] && after.declarations[hash]) continue;
        for (const name of before.declarations[hash] || after.declarations[hash]) formulae.add(name);
      }
    } else for (const entry of [before, after]) for (const name of entry?.formulae || []) formulae.add(name);
  }
  return {changed:different,formulae:[...formulae].sort(),allRuntime:shared};
}
module.exports={capture,changed};
if(require.main===module) {
  const result=capture({'homebrew-php':path.resolve('homebrew-php'),'homebrew-extensions':path.resolve('homebrew-extensions')});
  fs.writeFileSync(process.argv[2] || 'dependency-inputs.json',JSON.stringify(result,null,2)+'\n');
}
