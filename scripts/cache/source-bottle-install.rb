# The JS planner has already installed every required dependency. Skip further
# installation, but keep Homebrew's normal dependency-aware compiler environment:
# passing --ignore-dependencies into build.rb would strip PHP's header paths and
# omit keg-only library/tool paths. This override lives only in this brew process.
require "formula_installer"
require "cmd/install"

raise "Expected an explicitly planned source build" unless
  ARGV.include?("--ignore-dependencies") && ARGV.include?("--build-bottle")

# Set this inside brew: newer launchers only inherit HOMEBREW_* variables.
if (pkg_config_path = ENV["HOMEBREW_PHP_DARWIN_PKG_CONFIG_PATH"])
  ENV["PKG_CONFIG"] = "pkg-config --with-path=#{pkg_config_path}"
end

module PhpDarwinSourceBuildEnvironment
  def build_args(formula_path)
    args = super
    if ENV["HOMEBREW_PHP_DARWIN_PKG_CONFIG_PATH"] || ENV["HOMEBREW_PHP_DARWIN_CONFIGURE_CACHE"]
      # Preload the environment hook in Homebrew's separate build process.
      args.insert(args.index("--"), "-r", File.expand_path("source-bottle-openssl", __dir__))
    end
    args
  end

  def sanitized_argv_options
    super.reject { |option| option == "--ignore-dependencies" }
  end
end
FormulaInstaller.prepend(PhpDarwinSourceBuildEnvironment)
installation = Homebrew::Cmd::InstallCmd.new(ARGV)
Context.current = installation.args.context
installation.run
