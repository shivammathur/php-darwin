# Invoked through brew ruby so resolution and bottle selection use Homebrew.
require "formulary"
require "formula_installer"
require "json"

Formulary.enable_factory_cache!
mode = ARGV.fetch(0)
formulae = JSON.parse(ARGV.fetch(1))
raise "Invalid source bottle mode" unless %w[plan inputs].include?(mode)

records = formulae.map do |name|
  formula = Formulary.factory(name)
  record = {
    name: formula.name,
    full_name: formula.full_name,
    version: formula.pkg_version.to_s,
    prefix: formula.prefix.to_s,
    recipe: formula.path.to_s,
    installed: formula.any_version_installed?,
    bottled: FormulaInstaller.new(formula).pour_bottle?,
  }
  if mode == "inputs"
    record[:dependencies] = Dependency.expand(formula) do |_dependent, dep|
      next Dependable::PRUNE if dep.optional? || dep.test? || (dep.uses_from_macos? && dep.use_macos_install?)
    end.map do |dep|
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
