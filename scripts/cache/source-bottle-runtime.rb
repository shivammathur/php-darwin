# A retained bottle keeps the macOS library boundary it was built against.
# Do not turn a declared Homebrew dependency into a system library merely
# because the restore runner is newer (for example Python's expat on Sonoma).
class SourceBottleRuntime
  def initialize(approved = {}, installed: false)
    @approved = approved
    @installed = installed
    @platforms = {}
  end

  def approved?(formula)
    entry = @approved[formula.full_name]
    (entry.is_a?(Hash) ? entry.fetch("version") : entry) == formula.pkg_version.to_s
  end

  # Formula#deps already removes uses_from_macos dependencies for the host.
  # Dependency.expand also calls it recursively, so supplying declared_deps
  # only at the root still loses older bottles' transitive runtime libraries.
  # Traverse declarations at every level, retaining Homebrew's dependency
  # ordering, canonical names and merged tags without modifying its formulae.
  def expand(formula, ancestors = [], &filter)
    return [] if ancestors.include?(formula.full_name)

    ancestors = ancestors + [formula.full_name]
    dependencies = formula.declared_deps.flat_map do |dependency|
      next [] if dependency.name == formula.name

      action = filter.call(formula, dependency)
      next [] if action == Dependable::PRUNE
      next [dependency] if action == Dependable::KEEP_BUT_PRUNE_RECURSIVE_DEPS

      child = dependency.to_formula
      next [] if ancestors.include?(child.full_name)

      expand(child, ancestors, &filter) + [dependency.dup_with_formula_name(child)]
    end
    Dependency.merge_repeats(dependencies)
  end

  def from_macos?(formula, dependency)
    return false unless dependency.uses_from_macos?

    os = @platforms.fetch(formula.full_name) do
      entry = @approved[formula.full_name]
      @platforms[formula.full_name] = if approved?(formula) && entry.is_a?(Hash)
        "macOS #{entry.fetch('macos')}"
      elsif @installed && formula.latest_version_installed?
        Tab.for_keg(formula.latest_installed_prefix).built_on&.fetch("os_version", nil)
      end
    end
    dependency.use_macos_install?(bottle_os_version: os)
  end
end
