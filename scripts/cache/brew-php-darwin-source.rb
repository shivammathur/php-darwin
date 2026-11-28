# Run inside Homebrew's existing Ruby process. `brew ruby` starts a second
# process after global.rb has consumed the ARM/Linux default-prefix variables,
# which can make compatible bottles appear to require the invalid /Cellar.
case ARGV.shift
when "info"
  require_relative "source-bottle-info"
when "prune"
  require_relative "source-bottle-prune"
when "install"
  require_relative "source-bottle-install"
when "linkage"
  require_relative "source-bottle-linkage"
when "bottle"
  require "dev-cmd/bottle"
  require "utils/gzip"
  require_relative "source-bottle-gzip"
  Utils::Gzip.singleton_class.prepend(PhpDarwinBottleGzip)
  bottling = Homebrew::DevCmd::Bottle.new(ARGV)
  Context.current = bottling.args.context
  bottling.run
when "select"
  require "formulary"
  require "keg"
  formula = Formulary.factory(ARGV.fetch(0))
  raise "Current keg is not installed" unless formula.latest_version_installed?
  Keg.new(formula.latest_installed_prefix).optlink(verbose: true)
when "tool-dependencies"
  require "formulary"
  require "formula_installer"
  require "pkg_version"
  require "json"
  # Newer Homebrew restricts factory to names; bottle paths have an explicit
  # loader. Retain the old entry point only for Homebrew without that API.
  bottle = Pathname.new(ARGV.fetch(0))
  formula = if Formulary.respond_to?(:from_bottle)
    Formulary.from_bottle(bottle)
  else
    Formulary.factory(bottle)
  end
  raise "Archive-tool formula identity differs" unless
    formula.name == ARGV.fetch(1) && formula.pkg_version.to_s == ARGV.fetch(2)

  # Read the recipe authenticated by the bottle checksum. Do not resolve its
  # dependencies against today's core or pull build tools into the bootstrap.
  dependencies = formula.deps.reject do |dep|
    dep.build? || dep.test? || dep.optional? || (dep.uses_from_macos? && dep.use_macos_install?)
  end
  puts JSON.generate(dependencies.map(&:name))
else
  raise "Invalid source bottle command"
end
