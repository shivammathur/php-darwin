const fs = require('node:fs');
const {portable} = require('./upstream-bottle-cache.cjs');

function seedRecords(plan, lock) {
  // The installed dependency snapshot may intentionally retain an older
  // compatible bottle than the current formula's native-platform bottle.
  const records = [...plan.flatMap(item => item.bottle ? [item.bottle] : []),
    ...Object.values(lock.platforms).flatMap(platform => Object.values(platform.packages)
      .flatMap(entry => entry.bottle ? [entry.bottle] : []))].map(portable);
  return [...new Map(records.map(record => [`${record.formula}/${record.sha256}`, record])).values()];
}

module.exports = {seedRecords};
if (require.main === module) {
  const {readLock} = require('./approved-dependencies.cjs');
  for (const record of seedRecords(JSON.parse(fs.readFileSync(process.argv[2])), readLock())) {
    console.log(JSON.stringify(record));
  }
}
