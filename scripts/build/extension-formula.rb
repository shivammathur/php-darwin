# Patch the producer's extension tap to use the exact restored PHP formula.
# Homebrew's formula_opt_bin constructs a path without resolving aliases.
file, formula, config_id, version = ARGV
abort 'Invalid PHP extension build context' unless
  formula&.match?(/\Aphp(?:@\d+\.\d+)?(?:-debug)?(?:-zts)?\z/) &&
  config_id&.match?(/\A\d+\.\d+(?:-debug)?(?:-zts)?\z/) &&
  version&.match?(/\A\d+\.\d+\z/)

source = File.read(file)
{
  'php@#{php_version}"' => "#{formula}\"",
  'php@#{@php_version}"' => "#{formula}\"",
  'etc / "php" / php_version / "conf.d"' => "etc / \"php\" / \"#{config_id}\" / \"conf.d\"",
}.each do |before, after|
  abort "Missing extension formula template: #{before}" unless source.scan(before).length == 1
  source = source.sub(before, after)
end
if Gem::Version.new(version) >= Gem::Version.new('7.3')
  # Swoole includes SPL headers that expose PCRE2 types in PHP debug builds.
  # PHP is a build dependency, so its own dependencies are not automatically
  # added to Homebrew's compiler include paths for the extension.
  dependency = "depends_on \"shivammathur/php/#{formula}\" => [:build, :test]"
  abort 'Missing PHP extension dependency' unless source.scan(dependency).length == 1
  source = source.sub(dependency,
    "#{dependency}\n      depends_on \"pcre2\" => :build if @extension == \"swoole\"")
end
if version.start_with?('5.', '7.') && !source.include?('ENV["ac_cv_prog_cc_c23"] = "no"')
  abort 'Missing safe_phpize method' unless source.match?(/^\s*def safe_phpize$/)
  source = source.sub(/^(\s*)def safe_phpize$/, "\\1def safe_phpize\n\\1  ENV[\"ac_cv_prog_cc_c23\"] = \"no\"")
end
if version == '5.6' && config_id.end_with?('-zts')
  # RdKafka 4.x's PHP 5 callback typedef omits the thread context argument.
  # Match the callback signature instead of suppressing Clang's type check.
  abort 'Missing safe_phpize method' unless source.match?(/^\s*def safe_phpize$/)
  patch = <<~RUBY
    def safe_phpize
      if extension == "rdkafka"
        inreplace "php_rdkafka_priv.h",
                  "typedef void (*zend_object_free_obj_t)(zend_object *object);",
                  "typedef void (*zend_object_free_obj_t)(zend_object *object TSRMLS_DC);"
      end
  RUBY
  source = source.sub(/^\s*def safe_phpize\n/, "\n#{patch}")
end
if version == '8.7'
  # php-src moved this field from file globals to core globals during 8.7-dev
  # without changing PHP_VERSION_ID. Inspect the exact restored PHP headers,
  # not the version or the host's default PHP, to retain older nightly builds.
  abort 'Missing safe_phpize method' unless source.scan(/^\s*def safe_phpize$/).length == 1
  patch = <<~'RUBY'
    def safe_phpize
      if extension == "ssh2"
        php_include = formula_opt_bin(php_formula).parent / "include/php"
        member = /\bzend_long\s+default_socket_timeout\s*;/
        if (php_include / "main/php_globals.h").read.match?(member) &&
            !(php_include / "ext/standard/file.h").read.match?(member)
          ssh2 = File.read("ssh2.c")
          old_timeout = "FG(default_socket_timeout)"
          if ssh2.include?(old_timeout)
            header = '#include "php_ssh2.h"'
            abort 'Unexpected SSH2 socket timeout source' unless
              ssh2.scan(old_timeout).length == 1 && ssh2.scan(header).length == 1
            unless ssh2.include?('#include "main/php_globals.h"')
              ssh2 = ssh2.sub(header, "#{header}\n#include \"main/php_globals.h\"")
            end
            File.write("ssh2.c", ssh2.sub(old_timeout, "PG(default_socket_timeout)"))
          end
        end
      end
  RUBY
  source = source.sub(/^\s*def safe_phpize\n/, "\n#{patch}")
end
File.write(file, source)
