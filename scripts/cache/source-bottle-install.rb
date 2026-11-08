# The JS planner has already installed every required dependency. Skip further
# installation, but keep Homebrew's normal dependency-aware compiler environment:
# passing --ignore-dependencies into build.rb would strip PHP's header paths and
# omit keg-only library/tool paths. This override lives only in this brew process.
require "formula_installer"
require "cmd/install"

require "json"
platforms = JSON.parse(File.read(File.expand_path("../../conf/platforms.json", __dir__)))
arch = Hardware::CPU.arm? ? "arm64" : "x86_64"
policy = platforms.fetch(arch)
extension_tap = JSON.parse(File.read(File.expand_path("../../conf/package.json", __dir__))).fetch("extension_tap")
targets = ARGV.reject { |arg| arg.start_with?("-") }
extension_source = targets.length == 1 &&
                   targets.first.match?(%r{\A#{Regexp.escape(extension_tap)}/[A-Za-z0-9@+_.-]+\z}) &&
                   policy.fetch("extension_source_builds", []).include?(ENV["HOMEBREW_PHP_DARWIN_EXTENSION_VARIANT"])
raise "#{arch} is bottle-only; source compilation is disabled by conf/platforms.json" unless
  policy.fetch("source_builds") == true || extension_source

raise "Expected an explicitly planned source build" unless
  ARGV.include?("--ignore-dependencies") && ARGV.include?("--build-bottle")

# Set this inside brew: newer launchers only inherit HOMEBREW_* variables.
if (pkg_config_path = ENV["HOMEBREW_PHP_DARWIN_PKG_CONFIG_PATH"])
  ENV["PKG_CONFIG"] = ["pkg-config", *pkg_config_path.split(File::PATH_SEPARATOR).map { |directory| "--with-path=#{directory}" }].join(" ")
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
