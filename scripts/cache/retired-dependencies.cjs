const namePattern = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/)?[A-Za-z0-9@+_.-]+$/;

function retireDependencies(packages, names, plan) {
  if (!Array.isArray(names) || names.some(name => !namePattern.test(name))) {
    throw new Error('Invalid retired dependencies');
  }
  const retired = new Set(names);
  for (const item of plan) {
    if (retired.has(item.full_name)) throw new Error(`Retired dependency remains in the resolved graph: ${item.full_name}`);
  }
  const result = Object.fromEntries(Object.entries(packages).filter(([name]) => !retired.has(name)));
  for (const [name, entry] of Object.entries(result)) {
    for (const dependency of entry.source?.inputs?.dependencies || []) {
      for (const used of [dependency.name, ...(dependency.runtime_dependencies || []).map(item => item.full_name)]) {
        if (retired.has(used)) throw new Error(`${name} still records retired dependency ${used}; rebuild its cached bottle`);
      }
    }
  }
  return result;
}

// Keep the resolved graph and everything referenced by retained source-bottle
// provenance. This includes the runtime of build tools which Homebrew pruned
// because their consumers are restored from approved bottles.
function pruneUnusedDependencies(packages, plan) {
  const required = new Set(plan.map(item => item.full_name).filter(name => packages[name]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...required]) for (const dependency of packages[name]?.source?.inputs?.dependencies || []) {
      for (const used of [dependency.name, ...(dependency.runtime_dependencies || []).map(item => item.full_name)]) {
        if (packages[used] && !required.has(used)) { required.add(used); changed = true; }
      }
    }
  }
  return retireDependencies(packages, Object.keys(packages).filter(name => !required.has(name)), plan);
}
module.exports = {retireDependencies, pruneUnusedDependencies};
