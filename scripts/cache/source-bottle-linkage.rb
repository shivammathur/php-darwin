require "dev-cmd/linkage"
require "tab"
require_relative "source-bottle-runtime"

# Verification runs after checksum-verified restoration. Use the installed
# bottle's macOS boundary, not the newer host's, for declared dependencies.
# Apply this at every level of Homebrew's native recursive runtime traversal.
# Only this linkage process sees the override; receipts and recipes stay intact.
module PhpDarwinBottleLinkage
  RUNTIME = SourceBottleRuntime.new({}, installed: true)

  def deps(name = nil)
    dependencies = declared_deps.reject { |dep| RUNTIME.from_macos?(self, dep) }
    if name
      pattern = name.is_a?(Regexp) ? name : Version.formula_optionally_versioned_regex(name)
      dependencies.select! do |dep|
        dep.name.match?(pattern) || Utils.name_from_full_name(dep.name).match?(pattern)
      end
    end
    Dependencies.new(*dependencies)
  end
end
Formula.prepend(PhpDarwinBottleLinkage)

# Keep Homebrew's scanner, optional/build dependency filtering and error status.
# In particular, a receipt does not make an undeclared library acceptable.
linkage = Homebrew::DevCmd::Linkage.new(ARGV)
Context.current = linkage.args.context
linkage.run
