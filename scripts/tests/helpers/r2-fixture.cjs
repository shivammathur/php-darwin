const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
function info(bytes) {
  return { ContentLength: bytes.length, ETag: `"${crypto.createHash('md5').update(bytes).digest('hex')}"`,
    Metadata: { sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
}
function fixture(objects = new Map()) {
  const calls = [];
  const run = async (program, args, options) => {
    assert.equal(program, 'aws');
    assert.equal(args[2], 's3api');
    assert.equal(options.env.AWS_MAX_ATTEMPTS, '1');
    const operation = args[3], key = args[args.indexOf('--key') + 1];
    calls.push({ operation, key, args });
    if (operation === 'head-object') {
      if (!objects.has(key)) throw new Error('An error occurred (404) when calling the HeadObject operation: Not Found');
      return JSON.stringify(info(objects.get(key)));
    }
    if (operation === 'get-object') {
      assert.equal(args[args.indexOf('--if-match') + 1], info(objects.get(key)).ETag);
      fs.writeFileSync(args.at(-1), objects.get(key));
      return JSON.stringify(info(objects.get(key)));
    }
    assert.equal(operation, 'put-object');
    const body = fs.readFileSync(args[args.indexOf('--body') + 1]), metadata = info(body);
    assert.equal(args[args.indexOf('--content-length') + 1], String(body.length));
    assert.equal(args[args.indexOf('--content-md5') + 1], crypto.createHash('md5').update(body).digest('base64'));
    assert.deepEqual(JSON.parse(args[args.indexOf('--metadata') + 1]), metadata.Metadata);
    objects.set(key, body);
    return JSON.stringify({ ETag: metadata.ETag });
  };
  return { objects, calls, run };
}
module.exports = { fixture, info };
