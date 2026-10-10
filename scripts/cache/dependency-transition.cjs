const fs = require('node:fs');
const path = require('node:path');
const {readLock} = require('./approved-dependencies.cjs');
const {changed} = require('./dependency-inputs.cjs');
const recipes = require('./dependency-recipes.cjs');
const {roots} = require('./update-dependencies.cjs');
const {brewSource,environment,recipeHash,command} = require('./source-bottle-cache.cjs');
const formulaPattern=/^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/)?[A-Za-z0-9@+_.-]+$/;

// Select only the changed dependency tree. Compilers and other build tools
// remain pinned unless their own runtime dependencies need the transition.
function selectRecipes(lock, discoveries, change, upstream) {
  if (!/^[a-f0-9]{40}$/.test(upstream)) throw new Error('Invalid upstream recipe snapshot');
  const selected=new Set(), latest=new Map(), old=new Map(), runtime=new Set();
  for(const {before,after} of discoveries) {
    const previous=new Map(before.map(item=>[item.full_name,item]));
    for(const item of after) {
      if(item.requested && item.full_name.includes('/')) for(const name of item.runtime_formulae) runtime.add(name);
      if(item.full_name.includes('/')) continue;
      const group=latest.get(item.full_name)||[]; group.push(item);latest.set(item.full_name,group);
      const prior=old.get(item.full_name)||[];prior.push(previous.get(item.full_name));old.set(item.full_name,prior);
    }
  }
  if(change.allRuntime) for(const name of runtime) selected.add(name);
  else for(const name of change.formulae || []) if(latest.has(name)) selected.add(name);
  // Follow runtime dependencies forward and declaration changes backward. A
  // patch update to Python must not advance an unrelated LLVM/compiler recipe. Build
  // dependencies enter only when a selected consumer needs a new formula.
  let grew=true;
  while(grew) {
    grew=false;
    const add=name=>{if(latest.has(name)&&!selected.has(name)){selected.add(name);grew=true;}};
    for(const name of [...selected]) for(const item of latest.get(name)||[]) {
      for(const dep of item.runtime_dependencies) add(dep.name);
      for(const dep of item.required_formulae) if(!Object.values(lock.platforms).some(p=>p.packages[dep])) add(dep);
    }
    for(const [name,items] of latest) {
      if(selected.has(name))continue;
      if(items.some((item,i)=>{
        const prior=old.get(name)[i];
        return prior && [...prior.runtime_dependencies,...item.runtime_dependencies]
          .some(dep=>selected.has(dep.name)||(change.formulae||[]).includes(dep.name)) &&
          JSON.stringify(prior.runtime_dependencies.map(dep => dep.name))!==JSON.stringify(item.runtime_dependencies.map(dep => dep.name));
      })) add(name);
    }
  }
  // Unchanged recipes do not need workers or new pins. The two architectures
  // share one recipe map, with native planning enforcing their individual DAGs.
  const updates=[...selected].filter(name=>(latest.get(name)||[]).some((item,i)=>
    !old.get(name)[i] || item.recipe_sha256!==old.get(name)[i].recipe_sha256)).sort();
  return {...recipes.updatePlan(lock,upstream,updates.join(' ')), updates};
}

function resolvePlan(graph, previous, explicit=[]) {
  const excluded=new Set(graph.filter(item=>item.requested&&item.full_name.includes('/')).map(item=>item.full_name));
  const packages=graph.filter(item=>!excluded.has(item.full_name));
  const byName=new Map(packages.map(item=>[item.full_name,item]));
  const updates=new Set(explicit);
  const runtime = new Set(graph.filter(item => excluded.has(item.full_name)).flatMap(item => item.runtime_formulae || []));
  for(const item of packages) {
    const entry=previous[item.full_name];
    if(!entry || entry.version!==item.version ||
      (entry.bottle && item.bottle && entry.bottle.sha256!==item.bottle.sha256) ||
      (entry.source && entry.source.inputs.recipe!==item.recipe_sha256) ||
      (entry.source && item.runtime_dependencies.some(dep=>!entry.source.inputs.dependencies.some(old=>old.name===dep.name&&(!runtime.has(item.full_name)||old.version===dep.version))))) updates.add(item.full_name);
  }
  const workers=packages.filter(item=>updates.has(item.full_name)).map(item=>({
    formula:item.full_name,version:item.version,bottled:item.bottled,kind:runtime.has(item.full_name) ? 'runtime' : 'tool',
    needs:item.required_formulae.filter(name=>updates.has(name)&&byName.has(name)),
  }));
  const pending=new Set(workers.map(item=>item.formula));
  while(pending.size) {
    const ready=workers.filter(item=>pending.has(item.formula)&&item.needs.every(name=>!pending.has(name)));
    if(!ready.length)throw new Error('Dependency cycle in worker plan');
    for(const item of ready)pending.delete(item.formula);
  }
  return {updates:[...updates].filter(name=>byName.has(name)).sort(),workers};
}
const recipeHashes = new Map();
function graph(requested, approved={}) {
  return JSON.parse(brewSource('info',['graph',JSON.stringify(requested),String(requested.some(name=>name.includes('/'))),JSON.stringify(approved)]))
    .map(item => {
      const content = fs.readFileSync(item.recipe, 'utf8');
      if (recipeHashes.get(item.recipe)?.content !== content) recipeHashes.set(item.recipe, {content, hash: recipeHash(item.recipe)});
      return {...item, recipe_sha256: recipeHashes.get(item.recipe).hash};
    });
}
function native() {
  if(process.platform!=='darwin'||process.env.GITHUB_ACTIONS!=='true')throw new Error('Native dependency resolution requires a macOS CI runner');
}
function output(values) {
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,Object.entries(values).map(([k,v])=>`${k}=${typeof v==='string'?v:JSON.stringify(v)}\n`).join(''));
}
module.exports={selectRecipes,resolvePlan,graph};
if(require.main===module) {
  try {
    const [mode,directory]=process.argv.slice(2),lock=readLock();
    if(mode==='discover') {
      native();const platform=environment();
      const before=graph(Object.keys(lock.platforms[platform.arch].packages),Object.fromEntries(Object.entries(lock.platforms[platform.arch].packages).map(([name,value])=>[name,value.version])));
      const repository=command('brew',['--repository','homebrew/core']).trim();
      command('git',['-C',repository,'fetch','--no-tags','origin',process.env.UPSTREAM_CORE_COMMIT]);
      command('git',['-C',repository,'reset','--hard',process.env.UPSTREAM_CORE_COMMIT]);
      const after=graph(roots());
      fs.writeFileSync(`dependency-discovery-${platform.arch}.json`,JSON.stringify({before,after},null,2)+'\n');
    } else if(mode==='select') {
      const inputs=JSON.parse(fs.readFileSync('dependency-inputs.json'));
      const diff=changed(lock.tap_inputs,inputs);
      const discoveries=['arm64','x86_64'].map(arch=>JSON.parse(fs.readFileSync(path.join(directory,`dependency-discovery-${arch}.json`))));
      const plan=selectRecipes(lock,discoveries,diff,process.env.UPSTREAM_CORE_COMMIT);
      // Empty selective updates retain the current baseline and overrides.
      if(!plan.updates.length)Object.assign(plan,{core_commit:lock.core_commit,recipe_commits:recipes.validate(lock.recipe_commits)});
      fs.writeFileSync('dependency-recipe-plan.json',JSON.stringify(plan,null,2)+'\n');
      output({core:plan.core_commit,'recipe-commits':plan.recipe_commits,updates:plan.updates});
    } else if(mode==='resolve') {
      native();const platform=environment();
      const bottleOnly=JSON.parse(process.env.PHP_DARWIN_BOTTLE_UPDATES||'[]');
      const explicit=[...new Set([...JSON.parse(process.env.PHP_DARWIN_DEPENDENCY_UPDATES||'[]'), ...bottleOnly])];
      const previous=lock.platforms[platform.arch].packages;
      let plan={updates:explicit}; let resolved;
      // Invalidating a source bottle exposes its build dependencies. Resolve to
      // a fixed point before scheduling, rather than discovering new work on a runner.
      for(let i=0;i<=Object.keys(previous).length+100;i++) {
        const approved=Object.fromEntries(Object.entries(previous).filter(([name])=>!plan.updates.includes(name)).map(([name,e])=>[name,e.version]));
        resolved=graph([...new Set([...roots(), ...explicit])],approved);
        for (const name of bottleOnly) if (!resolved.find(item => item.full_name === name)?.bottled) throw new Error(`No compatible upstream bottle for ${name}`);
        const next=resolvePlan(resolved,previous,plan.updates);
        if(JSON.stringify(next.updates)===JSON.stringify([...plan.updates].sort())){plan=next;break;}
        plan=next;
        if(i===Object.keys(previous).length+100)throw new Error('Dependency plan did not converge');
      }
      const result={...plan,arch:platform.arch,core:process.env.HOMEBREW_CORE_COMMIT,
        recipes:recipes.configured(process.env.HOMEBREW_CORE_COMMIT),php:process.env.HOMEBREW_PHP_COMMIT,
        extensions:process.env.HOMEBREW_EXTENSIONS_COMMIT,revision:process.env.GITHUB_SHA};
      if(result.workers.some(item=>!formulaPattern.test(item.formula)))throw new Error('Invalid dependency worker formula');
      fs.writeFileSync(`dependency-plan-${platform.arch}.json`,JSON.stringify(result,null,2)+'\n');
      console.log(`${platform.arch}: ${result.workers.length} changed dependencies; unrelated approved bottles retained`);
    } else throw new Error('Expected discover, select or resolve');
  }catch(error){console.error(error);process.exitCode=1;}
}
