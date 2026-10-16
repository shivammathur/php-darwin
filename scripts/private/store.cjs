const fs = require('node:fs');
const path = require('node:path');
const {r2, credentials} = require('../lib/r2.cjs');
const {command, retryPolicy} = require('../release/extension-transfers.cjs');
const bucket = 'php-darwin-private';
function storage() {
  const endpoint = process.env.CF_R2_AWS_S3_ENDPOINT;
  if (!/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\/?$/.test(endpoint || '')) throw new Error('Invalid private R2 endpoint');
  return r2({endpoint, bucket, privateObjects: true, env: process.env, run: command, retry: retryPolicy()});
}
function buildId(id) {
  if (!/^[1-9]\d*-[1-9]\d*$/.test(id || '')) throw new Error('Invalid private build ID (run-attempt)');
  return id;
}
function prefix(id = process.env.PRIVATE_BUILD_ID) { return `builds/${buildId(id)}`; }
function workdir() {
  const directory = path.join(process.env.RUNNER_TEMP || '/tmp', 'php-darwin-private');
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  return directory;
}
async function putJSON(store, key, value) {
  const file = path.join(workdir(), `record-${require('node:crypto').randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(value) + '\n', {mode: 0o600});
  try { return await store.ensure(file, key, {replace: false, contentType: 'application/json'}); }
  finally { fs.rmSync(file, {force: true}); }
}
async function getJSON(store, key) {
  const file = path.join(workdir(), `record-${require('node:crypto').randomUUID()}.json`);
  try {
    const metadata = await store.head(key);
    if (!metadata || metadata.ContentLength > 8 * 1024 ** 2) throw new Error('Missing or oversized private record');
    await store.download(key, file);
    return JSON.parse(fs.readFileSync(file));
  } finally { fs.rmSync(file, {force: true}); }
}
async function uploads() {
  const result = JSON.parse(await command('aws', ['--endpoint-url', process.env.CF_R2_AWS_S3_ENDPOINT,
    's3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'uploads/php-', '--output', 'json'], {env: credentials()}));
  return (result.Contents || []).map(item => item.Key);
}
module.exports = {storage, bucket, buildId, prefix, workdir, putJSON, getJSON, uploads};
