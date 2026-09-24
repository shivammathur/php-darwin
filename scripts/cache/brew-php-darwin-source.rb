# Run inside Homebrew's existing Ruby process. `brew ruby` starts a second
# process after global.rb has consumed the ARM/Linux default-prefix variables,
# which can make compatible bottles appear to require the invalid /Cellar.
case ARGV.shift
when "info"
  require_relative "source-bottle-info"
when "prune"
  require_relative "source-bottle-prune"
else
  raise "Invalid source bottle command"
end
