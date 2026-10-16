const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
test('private worker output and failed transfers never enter the Actions console', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'private-console-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin);
  const aws = path.join(bin, 'aws');
  fs.writeFileSync(aws, `#!${process.execPath}\n
const fs=require('node:fs'), crypto=require('node:crypto'), path=require('node:path');
const args=process.argv.slice(2), option=n=>args[args.indexOf(n)+1];
if(process.env.FAIL_TRANSFER==='true'){console.error('PRIVATE_TRANSFER_DIAGNOSTIC');process.exit(1);}
const file=path.join(process.env.FAKE_R2,encodeURIComponent(option('--key')));
if(args.includes('put-object'))fs.copyFileSync(option('--body'),file);
if(!fs.existsSync(file)){console.error('An error occurred (404) when calling the HeadObject operation: Not Found');process.exit(1);}
const bytes=fs.readFileSync(file);console.log(JSON.stringify({ContentLength:bytes.length,ETag:'"'+crypto.createHash('md5').update(bytes).digest('hex')+'"',Metadata:{sha256:crypto.createHash('sha256').update(bytes).digest('hex')}}));
`, {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'sudo'), `#!${process.execPath}\n
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const directory=path.join(process.env.RUNNER_TEMP,'php-darwin-private');
assert.deepEqual(process.argv.slice(2),['-n','rm','-rf','--',directory]);
if(process.env.FAIL_CLEANUP==='true'){console.error('PRIVATE_CLEANUP_DIAGNOSTIC');process.exit(1);}
function writable(p){const s=fs.lstatSync(p);if(s.isDirectory()){fs.chmodSync(p,0o700);for(const n of fs.readdirSync(p))writable(path.join(p,n));}}
writable(directory);fs.rmSync(directory,{recursive:true,force:true});
`, {mode:0o755});
  const worker = path.join(directory, 'worker.cjs');
  fs.writeFileSync(worker, "const fs=require('node:fs'),path=require('node:path');const d=path.join(process.env.RUNNER_TEMP,'php-darwin-private','protected');fs.mkdirSync(d,{recursive:true});fs.chmodSync(d,0o700);fs.writeFileSync(path.join(d,'scratch'),'private');fs.chmodSync(d,0o500);console.log('PRIVATE_SOURCE_DETAILS');console.error('::error::PRIVATE_COMPILER_OUTPUT');process.exitCode=Number(process.argv[2]);\n");
  for (const [label, status, transfer, cleanup] of [['build-x86_64-release-nts', 0, false], ['build-arm64-debug-zts', 1, false], ['test-macos-14', 0, false], ['cleanup-failure', 0, false, true], ['upload-failure', 0, true]]) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../private/run.cjs'), label, process.execPath, worker, String(status)], {
      encoding:'utf8', env:{...process.env, PATH:bin+path.delimiter+process.env.PATH, RUNNER_TEMP:directory, FAKE_R2:directory,
        GITHUB_ACTIONS:'true', PRIVATE_BUILD_ID:'123-1', CF_R2_AWS_S3_ENDPOINT:'https://'+'a'.repeat(32)+'.r2.cloudflarestorage.com', FAIL_TRANSFER:String(transfer), FAIL_CLEANUP:String(!!cleanup)},
    });
    assert.equal(result.status, status || Number(transfer) || Number(!!cleanup));
    assert.ok(!/PRIVATE_SOURCE_DETAILS|PRIVATE_COMPILER_OUTPUT|PRIVATE_TRANSFER_DIAGNOSTIC|PRIVATE_CLEANUP_DIAGNOSTIC|::error::/.test(result.stdout+result.stderr));
    if(!transfer){
      const saved=fs.readFileSync(path.join(directory,encodeURIComponent(`builds/123-1/logs/${label}.log`)),'utf8');
      assert.match(saved,/PRIVATE_SOURCE_DETAILS/);assert.match(saved,/PRIVATE_COMPILER_OUTPUT/);
    }
    if (cleanup) assert.match(fs.readFileSync(path.join(directory,encodeURIComponent(`builds/123-1/logs/${label}-cleanup.log`)),'utf8'),/PRIVATE_CLEANUP_DIAGNOSTIC/);
    if (!status && !transfer && !cleanup) assert.ok(!fs.existsSync(path.join(directory,'php-darwin-private')));
  }
  fs.chmodSync(path.join(directory,'php-darwin-private','protected'),0o700);
});

test('runner cleanup restores the previous tap and removes only the private download', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'private-cleanup-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const bin = path.join(directory, 'bin'), work = path.join(directory, 'php-darwin-private');
  const brew = path.join(directory, 'Homebrew'), cache = path.join(directory, 'cache');
  const tap = path.join(brew, 'Library/Taps/shivammathur/homebrew-php');
  const backup = path.join(work, 'tap-before'), builds = path.join(directory, 'builds');
  for (const d of [bin, tap, backup, cache, builds]) fs.mkdirSync(d, {recursive: true});
  fs.writeFileSync(path.join(tap, 'formula.rb'), 'private candidate');
  fs.writeFileSync(path.join(backup, 'formula.rb'), 'original formula');
  fs.writeFileSync(path.join(cache, 'candidate.tar.gz'), 'private source');
  fs.writeFileSync(path.join(cache, 'dependency.tar.gz'), 'public dependency');
  fs.writeFileSync(path.join(builds, 'archive'), 'private build');
  fs.writeFileSync(path.join(bin, 'brew'), `#!${process.execPath}\nconsole.log(process.argv[2]==='--repository'?process.env.FAKE_BREW:process.env.FAKE_CACHE);\n`, {mode:0o755});
  fs.writeFileSync(path.join(bin, 'sudo'), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]!=='-n')process.exit(1);if(args[1]==='rm'&&args[2]==='-rf')fs.rmSync(args[3],{recursive:true,force:true});else if(args[1]==='mv')fs.renameSync(args[2],args[3]);else process.exit(1);\n`, {mode:0o755});
  const stateFile = path.join(work, 'runner-state.json');
  const state = {tap, hadTap:true, cache:[path.join(cache, 'candidate.tar.gz')]};
  const env = {...process.env, PATH:bin+path.delimiter+process.env.PATH, GITHUB_ACTIONS:'true', RUNNER_TEMP:directory,
    FAKE_BREW:brew, FAKE_CACHE:cache, CF_R2_AWS_S3_ENDPOINT:'https://'+'a'.repeat(32)+'.r2.cloudflarestorage.com'};
  const invoke = () => spawnSync(process.execPath, [path.resolve(__dirname, '../../private/release.cjs'), 'clean-local'], {cwd:directory, env, encoding:'utf8'});
  // Reject an unexpected cleanup target before deleting any data.
  fs.writeFileSync(stateFile, JSON.stringify({...state, cache:[path.join(directory, 'outside-cache')]}));
  assert.notEqual(invoke().status, 0);
  assert.equal(fs.readFileSync(path.join(tap, 'formula.rb'), 'utf8'), 'private candidate');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const result = invoke(); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(tap, 'formula.rb'), 'utf8'), 'original formula');
  assert.ok(!fs.existsSync(path.join(cache, 'candidate.tar.gz')));
  assert.equal(fs.readFileSync(path.join(cache, 'dependency.tar.gz'), 'utf8'), 'public dependency');
  assert.ok(!fs.existsSync(builds)); assert.ok(!fs.existsSync(stateFile));
  // An interrupted retry must not delete the restored tap after its backup moved.
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.notEqual(invoke().status, 0);
  assert.equal(fs.readFileSync(path.join(tap, 'formula.rb'), 'utf8'), 'original formula');
});
