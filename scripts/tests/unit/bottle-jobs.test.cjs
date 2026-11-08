const test = require('node:test');
const assert = require('node:assert/strict');
const {jobMatrix, recordsFor} = require('../../cache/bottle-jobs.cjs');

test('large source inventories fit Actions job outputs while all records survive artifact selection', () => {
  const manifest = {include: Array.from({length: 201}, (_, index) => ({formula: `dependency-${index}`,
    bottles: Array.from({length: 11}, (_, bottle) => ({sha256: `${index}-${bottle}`, url: 'x'.repeat(600)}))}))};
  assert.ok(Buffer.byteLength(JSON.stringify(manifest), 'utf16le') > 1048576);
  const jobs = jobMatrix(manifest);
  assert.equal(jobs.include.length, 201);
  assert.ok(Buffer.byteLength(JSON.stringify(jobs), 'utf16le') < 32768);
  for (const job of jobs.include) assert.deepEqual(recordsFor(manifest, job.formula), manifest.include.find(item => item.formula === job.formula).bottles);
});

test('missing, duplicate and invalid matrix selections fail before publication', () => {
  const value = {include: [{formula: 'shivammathur/php/php@8.5', bottles: [{}]}]};
  assert.throws(() => recordsFor(value, 'absent'), /Missing bottle job/);
  assert.throws(() => jobMatrix({include: [...value.include, ...value.include]}), /duplicate/);
  assert.throws(() => recordsFor({include: [{formula: '../outside', bottles: [{}]}]}, '../outside'), /Invalid/);
  assert.throws(() => recordsFor({include: [{formula: 'jq', bottles: []}]}, 'jq'), /Missing/);
});

test('inventories beyond 256 dependencies fit the job limit without losing or duplicating bottles', () => {
  for (const count of [256, 257, 259, 512, 513, 1000]) {
    const manifest = {include: Array.from({length: count}, (_, index) => ({formula: `dependency-${index}`,
      bottles: [{sha256: `${index}-arm64`}, {sha256: `${index}-x86_64`}]}))};
    const jobs = jobMatrix(manifest);
    assert.ok(jobs.include.length <= 256);
    const selected = jobs.include.flatMap(job => recordsFor(manifest, job.formula));
    assert.deepEqual(selected, manifest.include.flatMap(group => group.bottles));
    assert.throws(() => recordsFor(manifest, 'absent'), /Missing bottle job/);
  }
});
