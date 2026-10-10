const {test} = require('node:test');
const assert = require('node:assert/strict');
const {buildGuard} = require('../../cache/dependency-build-guard.cjs');

test('workers cannot compile a missing prerequisite and final approval cannot compile anything', () => {
  const calls = [], run = (...args) => calls.push(args);
  const worker = buildGuard('httpd', run), final = buildGuard(undefined, run);
  const build = name => ['php-darwin-source', 'install', '--formula', '--build-bottle', name];
  assert.throws(() => worker('brew', build('python@3.14')), /build its worker first/);
  assert.throws(() => final('brew', build('httpd')), /build its worker first/);
  assert.equal(calls.length, 0);
  worker('brew', build('httpd'));
  assert.deepEqual(calls[0][1], build('httpd'));
  final('brew', ['install', '--formula', '/cache/bottle.tar.gz']);
  assert.deepEqual(calls[1][1], ['install', '--force-bottle', '--formula', '/cache/bottle.tar.gz']);
});
