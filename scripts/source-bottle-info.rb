# Invoked as a Homebrew external command so resolution and bottle selection
# retain Homebrew's initialized platform defaults.
require "formulary"
require "formula_installer"
require "json"

Formulary.enable_factory_cache!
mode = ARGV.fetch(0)
formulae = JSON.parse(ARGV.fetch(1))
force_source = ARGV[2] == "true"
raise "Invalid source bottle mode" unless %w[plan inputs].include?(mode)

def source_dependencies(formula, planning:, force_source: false)
  Dependency.expand(formula) do |dependent, dep|
    next Dependable::PRUNE if dep.optional? || (dep.test? && !dep.build?) ||
                             (dep.uses_from_macos? && dep.use_macos_install?)

    if dep.build?
      building = if planning
        !dependent.any_version_installed? &&
          ((dependent == formula && force_source) || !FormulaInstaller.new(dependent).pour_bottle?)
      else
        # Inputs describe a source build of this formula. Its dependencies are
        # already installed: their runtime requirements matter, their original
        # build tools do not. Keep dependencies tagged both :build and :test.
        dependent == formula
      end
      next Dependable::PRUNE unless building
    end
  end
end

resolved = formulae.map { |name| Formulary.factory(name) }
if mode == "plan"
  resolved = resolved.flat_map do |formula|
    source_dependencies(formula, planning: true, force_source:).map(&:to_formula) + [formula]
  end.uniq(&:full_name)
end

records = resolved.map do |formula|
  record = {
    name: formula.name,
    full_name: formula.full_name,
    version: formula.pkg_version.to_s,
    prefix: formula.prefix.to_s,
    recipe: formula.path.to_s,
    installed: formula.any_version_installed?,
    bottled: FormulaInstaller.new(formula).pour_bottle?,
    post_install: formula.post_install_defined? || formula.post_install_steps_defined?,
  }
  if mode == "inputs"
    record[:dependencies] = source_dependencies(formula, planning: false).map do |dep|
      dependency = dep.to_formula
      keg = dependency.any_installed_keg
      raise "Missing build dependency #{dependency.full_name}" unless keg

      tab = Tab.for_keg(keg)
      recipe = keg/".brew/#{dependency.name}.rb"
      raise "Missing installed dependency recipe #{recipe}" unless recipe.file?

      {
        name: dependency.full_name,
        version: keg.version.to_s,
        recipe: recipe.to_s,
        options: tab.used_options.as_flags.sort,
        compiler: tab.compiler.to_s,
        runtime_dependencies: tab.runtime_dependencies,
      }
    end.sort_by { |dep| dep[:name] }
  end
  record
end
puts JSON.generate(records)
