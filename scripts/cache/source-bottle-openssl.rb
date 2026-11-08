# Select declared OpenSSL/ICU majors ahead of recursive dependencies in both
# pkg-config and the compiler environment. Some configure scripts use -lssl
# directly, and PHP can require an older ICU than its libpq dependency.
require "global"
require "extend/ENV/super"
require "extend/ENV/std"
require "json"

module PhpDarwinOpenSslEnvironment
  def setup_build_environment(**options)
    super
    # Homebrew clears ordinary configure variables while preparing the build.
    # Restore explicit cache answers afterwards, including under superenv.
    JSON.parse(self["HOMEBREW_PHP_DARWIN_CONFIGURE_CACHE"] || "{}").each do |name, value|
      raise "Invalid configure cache entry" unless name.match?(/\Aac_cv_[a-z0-9_]+\z/) && value.is_a?(String)

      self[name] = value
    end
    pkg_config = self["HOMEBREW_PHP_DARWIN_PKG_CONFIG_PATH"]
    return unless pkg_config

    pkg_config.split(File::PATH_SEPARATOR).reverse_each do |directory|
      dependency = Pathname.new(directory).parent.parent
      prepend_path "PKG_CONFIG_PATH", directory
      prepend_path "CMAKE_PREFIX_PATH", dependency.to_s
      if self["HOMEBREW_ENV"] == "super"
        prepend_path "HOMEBREW_INCLUDE_PATHS", (dependency/"include").to_s
        prepend_path "HOMEBREW_LIBRARY_PATHS", (dependency/"lib").to_s
      else
        prepend "CPPFLAGS", "-I#{dependency}/include"
        prepend "LDFLAGS", "-L#{dependency}/lib"
      end
    end
  end
end

Superenv.prepend(PhpDarwinOpenSslEnvironment)
Stdenv.prepend(PhpDarwinOpenSslEnvironment)
