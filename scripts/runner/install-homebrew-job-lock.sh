#!/bin/bash
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo 'This hook is for macOS Homebrew runners.' >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo 'Run as the runner user, not root.' >&2; exit 1; }
script_dir=$(cd "$(dirname "$0")" && pwd)
destination=/Library/Scripts/ci-autoscaler
hook="$destination/homebrew-job-started.sh"
repositories=()
for repository in "$HOME"/*; do
  [ -f "$repository/.runner" ] && [ -x "$repository/bin/Runner.Listener" ] || continue
  repositories+=("$repository")
done
[ "${#repositories[@]}" -gt 0 ] || { echo 'No registered runners found.' >&2; exit 1; }

# Validate every existing setting before changing any runner. Preserve unrelated
# environment settings and refuse to replace an operator's different hook.
/usr/bin/ruby - "$hook" "${repositories[@]}" <<'RUBY'
hook = ARGV.shift
ARGV.each do |repository|
  path = File.join(repository, '.env')
  next unless File.exist?(path)
  File.readlines(path).each do |line|
    next unless line.start_with?('ACTIONS_RUNNER_HOOK_JOB_STARTED=')
    abort "Existing start hook in #{repository}; integrate it before installing." unless line.strip.split('=', 2).last == hook
  end
end
RUBY
sudo -n install -d -m 755 "$destination"
sudo -n install -m 644 "$script_dir/homebrew-job-lock.rb" "$destination/homebrew-job-lock.rb"
sudo -n install -m 755 "$script_dir/homebrew-job-started.sh" "$hook"
/usr/bin/ruby - "$hook" "${repositories[@]}" <<'RUBY'
hook = ARGV.shift
ARGV.each do |repository|
  path = File.join(repository, '.env')
  contents = File.exist?(path) ? File.read(path) : ''
  unless contents.lines.any? { |line| line.start_with?('ACTIONS_RUNNER_HOOK_JOB_STARTED=') }
    contents += "\n" unless contents.empty? || contents.end_with?("\n")
    contents += "ACTIONS_RUNNER_HOOK_JOB_STARTED=#{hook}\n"
    temporary = "#{path}.#{Process.pid}"
    File.open(temporary, 'w', 0600) { |file| file.write(contents) }
    File.rename(temporary, path)
  end
  puts "Configured #{File.basename(repository)}; restart its listener only when idle."
end
RUBY
