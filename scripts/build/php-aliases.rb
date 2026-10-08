require 'json'

# Homebrew Keg#optlink uses the installed receipt, not today's tap aliases.
prefix, formula = ARGV
raise 'invalid PHP formula' unless formula&.match?(/\Aphp(?:@[0-9]+\.[0-9]+)?(?:-debug)?(?:-zts)?\z/)
canonical = File.join(prefix, 'opt', formula)
target = File.readlink(canonical)
raise 'invalid PHP opt target' unless target.match?(%r{\A\.\./Cellar/#{Regexp.escape(formula)}/[^/\s]+\z})
receipt = JSON.parse(File.read(File.join(prefix, 'opt', formula, 'INSTALL_RECEIPT.json')))
aliases = receipt.fetch('aliases', []) || []
raise 'invalid PHP aliases' unless aliases.is_a?(Array) && aliases.uniq == aliases
aliases.sort.each do |name|
  raise 'invalid PHP alias' unless name.is_a?(String) && name.match?(/\Aphp@[0-9]+\.[0-9]+(?:-debug)?(?:-zts)?\z/) && name != formula
  link = File.join(prefix, 'opt', name)
  raise "Homebrew PHP alias does not match its canonical keg: #{name}" unless File.symlink?(link) && File.readlink(link) == target
  puts ["opt/#{name}", target].join("\t")
end
