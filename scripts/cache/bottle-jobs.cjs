// Keep large bottle inventories in artifacts, outside Actions' job-output limit.
function jobMatrix(manifest) {
  if (!Array.isArray(manifest?.include)) throw new Error('Invalid bottle job manifest');
  const names = manifest.include.map(item => item.formula);
  if (names.some(name => typeof name !== 'string' || !/^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/)?[A-Za-z0-9@+_.-]+$/.test(name)) ||
      new Set(names).size !== names.length) throw new Error('Invalid or duplicate bottle job formula');
  const size = Math.max(1, Math.ceil(names.length / 256));
  return {include: Array.from({length: Math.ceil(names.length / size)}, (_, index) => ({
    formula: size === 1 ? names[index] : `batch-${String(index + 1).padStart(3, '0')}`,
  }))};
}

function recordsFor(manifest, formula) {
  const jobs = jobMatrix(manifest).include;
  const index = jobs.findIndex(item => item.formula === formula);
  const size = Math.max(1, Math.ceil(manifest.include.length / 256));
  const selected = manifest.include.slice(index * size, (index + 1) * size);
  if (index < 0 || !selected.length || selected.some(item => !Array.isArray(item.bottles) || !item.bottles.length)) {
    throw new Error(`Missing bottle job records: ${formula}`);
  }
  return selected.flatMap(item => item.bottles);
}

module.exports = {jobMatrix, recordsFor};
