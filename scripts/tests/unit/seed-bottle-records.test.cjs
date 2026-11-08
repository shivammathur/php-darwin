const test = require('node:test');
const assert = require('node:assert/strict');
const {seedRecords} = require('../../cache/seed-bottle-records.cjs');
const bottle = (hash, tag) => ({formula: 'jq', version: '1.8.2', tag, sha256: hash.repeat(64),
  url: `https://ghcr.io/v2/homebrew/core/jq/blobs/sha256:${hash.repeat(64)}`, cached_download: '/runner/cache'});

test('seeding retains exact approved bottles alongside current platform bottles', () => {
  const current = bottle('a', 'arm64_sequoia'), approved = bottle('b', 'arm64_sonoma'), intel = bottle('c', 'sequoia');
  const records = seedRecords([{bottle: current}, {bottle: intel}, {bottle: null}], {platforms: {
    arm64: {packages: {jq: {bottle: approved}, source: {source: {key: 'source-key'}}}},
    x86_64: {packages: {jq: {bottle: intel}}},
  }});
  assert.deepEqual(records.map(record => record.sha256).sort(), ['a', 'b', 'c'].map(hash => hash.repeat(64)));
  assert.ok(records.every(record => !Object.hasOwn(record, 'cached_download')));
});

test('approved seed records cannot redirect authenticated bottle downloads', () => {
  const unsafe = {...bottle('a', 'sequoia'), url: 'https://example.com/bottle'};
  assert.throws(() => seedRecords([], {platforms: {arm64: {packages: {jq: {bottle: unsafe}}}}}), /Unsupported/);
});
