const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {gunzipSync} = require('node:zlib');

test('a Ruby buffer failure produces a complete reproducible gzip with Homebrew metadata', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bottle-gzip-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'bottle.tar'), output = `${file}.gz`;
  const payload = Buffer.concat([Buffer.alloc(150000, 97), Buffer.from('complete tar bytes')]);
  let previous;
  for (let attempt = 0; attempt < 2; attempt++) {
    fs.writeFileSync(file, payload);
    const result = spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby', ['-r',
      path.resolve(__dirname, '../../cache/source-bottle-gzip.rb'), '-e', `
      module Compressor
        def self.compress_with_options(path, **options)
          File.write(options.fetch(:output), 'partial gzip')
          raise Zlib::BufError, 'buffer error'
        end
      end
      Compressor.singleton_class.prepend(PhpDarwinBottleGzip)
      Compressor.compress_with_options(ARGV[0], mtime: 1234567890, orig_name: 'imagick-bottle.tar', output: ARGV[1])
    `, file, output], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /system gzip/);
    const compressed = fs.readFileSync(output);
    assert.deepEqual(gunzipSync(compressed), payload);
    assert.equal(compressed.readUInt32LE(4), 1234567890);
    assert.equal(compressed.subarray(10, compressed.indexOf(0, 10)).toString(), 'imagick-bottle.tar');
    assert.equal(fs.existsSync(file), false);
    if (previous) assert.deepEqual(compressed, previous);
    previous = compressed;
  }
});

test('bottle compression does not mask non-buffer errors or discard an unreadable tar', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bottle-gzip-failure-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'bottle.tar');
  for (const error of ['IOError', 'Zlib::BufError']) {
    const result = spawnSync(process.env.PHP_DARWIN_RUBY || 'ruby', ['-r',
      path.resolve(__dirname, '../../cache/source-bottle-gzip.rb'), '-e', `
      module Compressor
        def self.compress_with_options(*)
          raise ${error}, 'original error'
        end
      end
      Compressor.singleton_class.prepend(PhpDarwinBottleGzip)
      Compressor.compress_with_options(ARGV[0])
    `, file], {encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(`${file}.gz`), false);
    if (error === 'IOError') assert.doesNotMatch(result.stderr, /system gzip/);
  }
});
