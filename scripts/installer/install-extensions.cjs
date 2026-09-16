const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const packs = { imagick: ['imagick'], mongodb: ['mongodb'], memcached: ['igbinary', 'msgpack', 'memcached'] };
const origins = ['https://github.com/shivammathur/php-darwin/releases/download/extensions',
  'https://artifacts.php-darwin.setup-php.com/extensions'];
const hex = /^[a-f0-9]{64}$/;
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw result.error || new Error(`${program} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function digest(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
module.exports = { command, digest, origins };
