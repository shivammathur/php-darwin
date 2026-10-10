# Homebrew's OpenSSL formulae can both be linked into the global prefix. Some
# configure scripts use -lssl directly instead of pkg-config, so select the
# declared major in the compiler environment as well as the .pc search path.
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

    openssl = Pathname.new(pkg_config).parent.parent
    prepend_path "PKG_CONFIG_PATH", pkg_config
    prepend_path "CMAKE_PREFIX_PATH", openssl.to_s
    if self["HOMEBREW_ENV"] == "super"
      prepend_path "HOMEBREW_INCLUDE_PATHS", (openssl/"include").to_s
      prepend_path "HOMEBREW_LIBRARY_PATHS", (openssl/"lib").to_s
    else
      prepend "CPPFLAGS", "-I#{openssl}/include"
      prepend "LDFLAGS", "-L#{openssl}/lib"
    end
  end
end

Superenv.prepend(PhpDarwinOpenSslEnvironment)
Stdenv.prepend(PhpDarwinOpenSslEnvironment)
