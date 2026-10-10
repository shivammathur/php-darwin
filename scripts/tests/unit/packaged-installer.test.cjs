const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
const {generate} = require('../../installer/generate-install.cjs');
const {digest, validateContext} = require('../../installer/install-extensions.cjs');
const {staleArchives} = require('../../release/extension-retention.cjs');
const configuration = require('../../../conf/extension-packs.json');
const platforms = require('../../../conf/platforms.json');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-install-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}
test('the release bootstrap embeds download identities without build-time provenance', t => {
  const directory=fixture(t), manifest=path.join(directory,'manifest.json');
  const asset={name:'php_8.5-nts-release+darwin_arm64.tar.zst', download:`php_8.5-nts-release+darwin_arm64.${'a'.repeat(64)}.tar.zst`,
    architecture:'arm64',build:'release',thread_safety:'nts',minimum_macos:14,sha256:'a'.repeat(64),bytes:123};
  fs.writeFileSync(manifest,JSON.stringify({schema:1,php_version:'8.5',source_hash:'producer-only',assets:[{...asset,build_inputs:{source_records:['producer-only']}}]}));
  const source=generate({output:path.join(directory,'install.sh'),manifest});
  assert.ok(!source.includes('producer-only'));
  const embedded=source.match(/release-manifest\.json\) cat <<'PHP_DARWIN_MANIFEST'\n([\s\S]*?)\nPHP_DARWIN_MANIFEST/)[1];
  assert.deepEqual(JSON.parse(embedded),{schema:1,php_version:'8.5',assets:[asset]});
});
test('configured versions and platforms are authoritative, including retention of Swoole', () => {
  configuration.versions.push('8.8');
  try {
    assert.doesNotThrow(() => validateContext({php_version:'8.8', architecture:'arm64', build:'debug', thread_safety:'zts'}));
  } finally {configuration.versions.pop();}
  const names = Object.keys(configuration.packs).map(pack => `${pack}-8.5-release-nts-arm64-${'a'.repeat(64)}.tar.zst`);
  assert.deepEqual(staleArchives(names.map(name => ({name})), [], [], [names[0]]), names.slice(1).sort());
});
for (const architecture of Object.keys(platforms)) test(`package plan resolves ${architecture} build paths and carries its own installer`, t => {
  const directory = fixture(t), platform = platforms[architecture];
  const metadata = {php_version:'8.5', build:'debug', thread_safety:'zts', architecture, brew_prefix:platform.brew_prefix,
    minimum_macos:platform.minimum_macos, platform_key:platform.platform_key, formula:'php-debug-zts', requested_formula:'php@8.5-debug-zts',
    archive:`php_8.5-zts-debug+darwin_${architecture}.tar.zst`, pear_path:'share/pear-debug-zts', tap_snapshot:'var/php-darwin/homebrew-php',
    homebrew_php_commit:'b'.repeat(40), source_hash:'c'.repeat(64), pecl_extension:'20250925-zts', php_semver:'8.5.12',
    packages:[{name:'php-debug-zts',opt_target:'../Cellar/php-debug-zts/8.5.12',keg_only:true}], links:[{path:'bin/php',target:'../Cellar/php-debug-zts/8.5.12/bin/php'}],
    extensions:[], state_paths:['etc/php/8.5-debug-zts/pear.conf'], tap_formulae:['php-debug-zts']};
  const receipt = path.join(directory,'Cellar/php-debug-zts/8.5.12/INSTALL_RECEIPT.json');
  fs.mkdirSync(path.dirname(receipt),{recursive:true});fs.writeFileSync(receipt,JSON.stringify({runtime_dependencies:[{full_name:'homebrew/core/openssl@4'}]}));
  const file = path.join(directory, 'metadata.json');fs.writeFileSync(file,JSON.stringify(metadata));
  const output = path.join(directory,'install.sh');
  const source = generate({output,metadata:file,prefix:directory});
  assert.match(source,/openssl@4/);
  assert.ok(!source.includes('php_darwin_download_release_archive'));
  assert.ok(!source.includes('php_darwin_validate_cache_metadata'));
  assert.ok(!source.includes('$script_dir/'));
  const context = source.slice(source.indexOf('php_darwin_package_context()'),source.indexOf('php_darwin_package_metadata()'));
  const result = execFileSync('bash',['-c',`version=8.5; build=debug; ts=zts; ${context}\nphp_darwin_package_context; printf '%s\\n' "$arch/$config_id/$expected_prefix"`],{encoding:'utf8'});
  assert.equal(result.trim(),`${architecture}/8.5-debug-zts/${platform.brew_prefix}`);
  // Exercise the generated controller itself: wrong identity must fail before
  // it can inspect or mutate the machine's Homebrew prefix.
  const rejected = spawnSync('bash',[output,'8.5','release','nts','/does/not/exist'],{encoding:'utf8'});
  assert.notEqual(rejected.status,0);
  assert.match(rejected.stderr,/packaged installer does not match the request/);
});
test('bootstrap authenticates before executing a packaged controller and preserves argument handling', t => {
  const directory = fixture(t), bin=path.join(directory,'bin'), tree=path.join(directory,'tree');
  fs.mkdirSync(bin);fs.mkdirSync(path.join(tree,'var/php-darwin/installer'),{recursive:true});
  const log=path.join(directory,'executed');
  fs.writeFileSync(path.join(tree,'var/php-darwin/installer/install.sh'),`#!/bin/bash\nprintf '%s\\n' "$@" > '${log}'\n`);
  for (const [name,body] of Object.entries({uname:'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac',sw_vers:'echo 14.0',brew:'exit 0'})) fs.writeFileSync(path.join(bin,name),'#!/bin/bash\n'+body+'\n',{mode:0o755});
  const archive=path.join(directory,'php_8.5-nts-release+darwin_arm64.tar.zst');
  execFileSync('tar',['--zstd','-cf',archive,'-C',tree,'var/php-darwin/installer/install.sh']);
  fs.writeFileSync(archive+'.sha256',`${digest(fs.readFileSync(archive))}  ${path.basename(archive)}\n`);
  const bootstrap=path.join(directory,'bootstrap.sh');generate({output:bootstrap});
  const options={encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,INPUT_EXTENSIONS:'',PHP_DARWIN_EXTENSIONS:''}};
  let result=spawnSync('bash',[bootstrap,'8.5','release','nts',archive,''],options);
  assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(log,'utf8'),`8.5\nrelease\nnts\n${archive}\n\n`);
  fs.unlinkSync(log);fs.appendFileSync(archive,'corruption');
  result=spawnSync('bash',[bootstrap,'8.5','release','nts',archive,''],options);
  assert.notEqual(result.status,0);assert.equal(fs.existsSync(log),false);
});
test('PHP and optional-pack downloads overlap, and the prefetch worker preserves multiple requests', async t => {
  const http = require('node:http');
  const {spawn} = require('node:child_process');
  const directory = fixture(t), bin = path.join(directory,'bin'), tree = path.join(directory,'tree');
  fs.mkdirSync(bin);fs.mkdirSync(path.join(tree,'var/php-darwin/installer'),{recursive:true});
  for (const [name,body] of Object.entries({uname:'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac',sw_vers:'echo 14.0',brew:'exit 0'})) fs.writeFileSync(path.join(bin,name),'#!/bin/bash\n'+body+'\n',{mode:0o755});
  fs.writeFileSync(path.join(tree,'var/php-darwin/installer/install.sh'),`#!/bin/bash
while [ ! -f "$PHP_DARWIN_PREFETCH_DIR/complete" ]; do sleep 0.01; done
cmp "$PHP_DARWIN_PREFETCH_DIR/requested.txt" '${directory}/expected'
`);
  fs.writeFileSync(path.join(directory,'expected'),'imagick\nmongodb');
  const archive = path.join(directory,'fixture.tar.zst');
  execFileSync('tar',['--zstd','-cf',archive,'-C',tree,'var/php-darwin/installer/install.sh']);
  const bytes = fs.readFileSync(archive), hash = digest(bytes), requests = new Set();
  let phpResponse;
  const packs = ['imagick','mongodb'].map(name => ({schema:1,name,php_version:'8.5',build:'release',thread_safety:'nts',architecture:'arm64',
    sha256:digest(name),inputs_sha256:'a'.repeat(64),bytes:Buffer.byteLength(name),php_api:'20250925',minimum_macos:14,
    file:`${name}-8.5-release-nts-arm64-${digest(name)}.tar.zst`}));
  const server = http.createServer((request,response) => {
    if (request.url === '/php-manifest') return response.end(JSON.stringify({schema:1,php_version:'8.5',assets:[{architecture:'arm64',build:'release',thread_safety:'nts',
      name:'php_8.5-nts-release+darwin_arm64.tar.zst',download:`php_8.5-nts-release+darwin_arm64.${hash}.tar.zst`,sha256:hash,bytes:bytes.length,minimum_macos:14}]}));
    if (request.url.endsWith('-manifest.json')) return response.end(JSON.stringify({schema:1,assets:packs}));
    if (request.url === '/php-archive') phpResponse = response;
    else {
      const entry = packs.find(item => request.url.endsWith('/'+item.file));
      if (!entry) {response.statusCode=404;return response.end();}
      requests.add(entry.name); response.end(entry.name);
    }
    if (phpResponse && requests.size === 2) phpResponse.end(bytes);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => {server.closeAllConnections();server.close();});
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = path.join(directory,'bootstrap.sh');
  const source = generate({output:bootstrap}).replace(/^const origins = .*;$/m, `const origins = [${JSON.stringify(base+'/extensions')}];`);
  fs.writeFileSync(bootstrap,source);
  const child = spawn('bash',[bootstrap,'8.5','release','nts','','imagick,mongodb'],{env:{...process.env,PATH:bin+':'+process.env.PATH,
    PHP_DARWIN_MANIFEST_URL:base+'/php-manifest',PHP_DARWIN_RELEASE_URL:base+'/php-archive',PHP_DARWIN_MIRROR_URL:''},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',data=>log+=data);child.stderr.on('data',data=>log+=data);
  const timeout=setTimeout(()=>child.kill('SIGTERM'),15000);t.after(()=>clearTimeout(timeout));
  const code = await new Promise(resolve=>child.on('exit',resolve));
  assert.equal(code,0,log);assert.deepEqual([...requests].sort(),['imagick','mongodb']);
});
