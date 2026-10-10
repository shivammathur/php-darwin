const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {install, packs, key, digest} = require('../../installer/install-extensions.cjs');
const platforms = require('../../../conf/platforms.json');
const configuration = require('../../../conf/extension-packs.json');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'pack-headers-install-')));
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const prefix = path.join(root,'prefix'), include = path.join(prefix,'include/php');
  const extensions = path.join(prefix,'lib/php/pecl/20250925'), directory = path.join(root,'downloads');
  const stage = path.join(root,'pack'), bin = path.join(root,'bin');
  for (const dir of [bin,directory,extensions,path.join(include,'ext'),path.join(include,'Zend'),path.join(stage,'modules')]) fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(include,'Zend/zend_modules.h'),'#define ZEND_MODULE_API_NO 20250925\n');
  const previousPrefix = platforms[arch].brew_prefix, previousPath = process.env.PATH;
  platforms[arch].brew_prefix = prefix;process.env.PATH = bin+path.delimiter+previousPath;
  t.after(() => {platforms[arch].brew_prefix=previousPrefix;process.env.PATH=previousPath;fs.rmSync(root,{recursive:true,force:true});});
  const metadata = {schema:1,name:'memcached',php_version:'8.5',build:'release',thread_safety:'nts',architecture:arch,
    php_api:'20250925',minimum_macos:platforms[arch].minimum_macos,inputs_sha256:'a'.repeat(64),modules:packs.memcached,
    headers:Object.keys(configuration.headers.memcached),relocations:[],environment:{}};
  for (const module of metadata.modules) fs.writeFileSync(path.join(stage,'modules',module+'.so'),JSON.stringify({version:'1.2.3',source:'pack'}));
  for (const [module,header] of Object.entries(configuration.headers.memcached)) {
    fs.mkdirSync(path.join(stage,'headers',module),{recursive:true});fs.writeFileSync(path.join(stage,'headers',module,header),'pack header');
  }
  fs.writeFileSync(path.join(stage,'metadata.json'),JSON.stringify(metadata));
  const temporary = path.join(root,'pack.tar.zst');
  execFileSync('tar',['--zstd','-cf',temporary,'-C',stage,'metadata.json','modules','headers']);
  const bytes=fs.readFileSync(temporary),sha256=digest(bytes),file=`${key(metadata)}-${sha256}.tar.zst`;
  fs.copyFileSync(temporary,path.join(directory,file));fs.writeFileSync(path.join(directory,'memcached.json'),JSON.stringify({...metadata,file,sha256,bytes:bytes.length}));
  const phpConfig=path.join(bin,'php-config'),php=path.join(bin,'php');
  const values={'--version':'8.5.11','--configure-options':'','--include-dir':include,'--extension-dir':extensions};
  fs.writeFileSync(phpConfig,`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(values)}[process.argv[2]]);\n`,{mode:0o755});
  fs.writeFileSync(path.join(bin,'sw_vers'),'#!/bin/sh\necho 99.0\n',{mode:0o755});
  fs.writeFileSync(php,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);
const code=args[args.indexOf('-r')+1];
if(code.includes('phpversion'))process.stdout.write(JSON.parse(fs.readFileSync(args.find(a=>a.startsWith('extension=')).slice(10))).version);
else if(fs.existsSync(${JSON.stringify(path.join(root,'fail'))})&&args.some(a=>a.startsWith('extension='+${JSON.stringify(extensions)})))process.exit(7);
`,{mode:0o755});
  const module=path.join(extensions,'igbinary.so'),header=path.join(include,'ext/igbinary');
  fs.copyFileSync(path.join(stage,'modules/igbinary.so'),module);
  return {root,module,header,extensions,run:()=>install(directory,'memcached',{phpConfig,php})};
}
for (const sameBytes of [true,false]) test(`preserved serializers get missing matching headers (${sameBytes?'identical binary':'same version'})`,t=>{
  const f=fixture(t);
  if(!sameBytes)fs.writeFileSync(f.module,JSON.stringify({version:'1.2.3',source:'user build'}));
  const before=fs.readFileSync(f.module);f.run();
  assert.deepEqual(fs.readFileSync(f.module),before);assert.equal(fs.lstatSync(f.module).isSymbolicLink(),false);
  assert.equal(fs.readFileSync(path.join(f.header,'igbinary.h'),'utf8'),'pack header');
  assert.ok(fs.lstatSync(f.header).isSymbolicLink());
});
test('different preserved module versions never receive mismatched headers',t=>{
  const f=fixture(t);fs.writeFileSync(f.module,JSON.stringify({version:'0.9.0',source:'older user build'}));f.run();
  assert.equal(fs.existsSync(f.header),false);assert.equal(JSON.parse(fs.readFileSync(f.module)).version,'0.9.0');
});
for(const link of [false,true])test(`preserved user headers remain unchanged (${link?'symlink':'directory'})`,t=>{
  const f=fixture(t),headers=link?path.join(f.root,'custom-headers'):f.header;
  fs.mkdirSync(headers);fs.writeFileSync(path.join(headers,'igbinary.h'),'user header');
  if(link)fs.symlinkSync(headers,f.header);
  f.run();assert.equal(fs.readFileSync(path.join(f.header,'igbinary.h'),'utf8'),'user header');
  assert.equal(fs.lstatSync(f.header).isSymbolicLink(),link);
});
test('failed module validation rolls back new headers and primary modules',t=>{
  const f=fixture(t),primary=path.join(f.extensions,'memcached.so');
  fs.writeFileSync(primary,'previous primary');fs.writeFileSync(path.join(f.root,'fail'),'');
  const before=fs.readFileSync(f.module);assert.throws(f.run,/failed/);
  assert.deepEqual(fs.readFileSync(f.module),before);assert.equal(fs.existsSync(f.header),false);
  assert.equal(fs.readFileSync(primary,'utf8'),'previous primary');
});
