#!/usr/bin/env bash

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/lib/lib.sh
. "$script_dir/../lib/lib.sh"

php_darwin_ruby - "$@" <<'PHP_DARWIN_INSTALL_STATE_RUBY'
begin
  mode, prefix, packages_file, selected_file, output_file, linked_file, preserved_links_file, links_file = ARGV
  packages = File.readlines(packages_file, chomp: true).map do |line|
    name, target, keg_only, extra = line.split("\t", -1)
    raise 'invalid package record' unless extra.nil? && %w[true false].include?(keg_only) &&
      name && !%w[. ..].include?(name) && name.match?(/\A[a-zA-Z0-9@+_.-]+\z/) &&
      target && target.match?(%r{\A\.\./Cellar/#{Regexp.escape(name)}/[^/\s]+\z}) &&
      !%w[. ..].include?(target.split('/').last)
    [name, target, keg_only]
  end
  selected = File.readlines(selected_file, chomp: true).each_with_object({}) { |name, set| set[name] = true }
  # Reuse newer active dependencies without downgrading their opt or public
  # links. Still extract missing cached kegs and track them for rollback.
  preserved = packages.each_with_object({}) do |(name, target, _), set|
    next if mode == 'receipts' && !selected.key?(name)
    opt = File.join(prefix, 'opt', name)
    next unless File.symlink?(opt)
    # Most installs already have this exact link. Avoid resolving its entire
    # Cellar path (and loading version comparison) on that common path.
    next if File.readlink(opt) == target
    next unless File.directory?(opt)
    active = File.realpath(opt)
    next unless File.dirname(active) == File.join(prefix, 'Cellar', name)
    current, cached = File.basename(active), File.basename(target)
    next if current == cached
    require 'rubygems'
    versions = [current, cached].map { |version| version.match(/\A(.+?)(?:_(\d+))?\z/) }
    # Unknown version formats are not permission to replace a working library.
    if !versions.all? { |version| Gem::Version.correct?(version[1]) }
      set[name] = true
    else
      active_version, cached_version = versions.map { |version| [Gem::Version.new(version[1]), version[2].to_i] }
      set[name] = true if (active_version <=> cached_version) == 1
    end
  end
  case mode
  when 'plan'
    existing_names = selected.keys.each_with_object({}) { |keg, set| set[keg.split('/')[1]] = true }
    changed, linked = [], []
    packages.each do |name, target, keg_only|
      next if selected.key?(target.delete_prefix('../'))
      changed << name
      next if preserved.key?(name)
      next unless keg_only == 'false' && existing_names.key?(name)
      path = File.join(prefix, 'var/homebrew/linked', name)
      next unless File.symlink?(path)
      previous = File.readlink(path)
      raise "invalid linked dependency target for #{name}" unless previous.match?(%r{\A\.\./\.\./\.\./Cellar/#{Regexp.escape(name)}/[^/\s]+\z})
      linked << name
    end
    File.write(output_file, changed.map { |name| name + "\n" }.join)
    File.write(linked_file, linked.map { |name| name + "\n" }.join)
    if preserved_links_file && links_file
      paths = []
      unless preserved.empty?
        File.foreach(links_file, chomp: true) do |line|
          name, target = line.split("\t", 2)
          formula = target && target.match(%r{(?:\A|/)Cellar/([^/]+)/})
          paths << name if formula && preserved.key?(formula[1])
        end
      end
      File.write(preserved_links_file, paths.map { |name| name + "\n" }.join)
    end
  when 'receipts'
    replacements = []
    opt_records = packages.map { |name, target, _| [name, name, target] }
    if links_file
      File.foreach(links_file, chomp: true) do |line|
        relative, target = line.split("\t", 2)
        next unless relative.start_with?('opt/')
        name = relative.delete_prefix('opt/')
        next if packages.any? { |package| package[0] == name }
        owner = packages.find { |package| package[1] == target }
        raise 'invalid PHP opt alias' unless owner && owner[0].match?(/\Aphp(?:@|\z|-)/) &&
          name.match?(/\A[A-Za-z0-9@+_.-]+\z/) && !%w[. ..].include?(name)
        opt_records << [owner[0], name, target]
      end
    end
    opt_records.each do |owner, name, target|
      raise "cache did not install #{target}" unless File.directory?(File.join(prefix, target.delete_prefix('../')))
      next unless selected.key?(owner)
      next if preserved.key?(owner)
      path = File.join(prefix, 'opt', name)
      stat = begin
        File.lstat(path)
      rescue Errno::ENOENT
        nil
      end
      raise "Homebrew opt path is not a symlink: #{path}" if stat && !stat.symlink?
      previous = stat && File.readlink(path)
      next if previous == target
      raise "invalid previous Homebrew opt link for #{name}" if previous && previous.match?(/[\r\n\t]/)
      replacements << [name, path, target, previous]
    end
    # Finish validation before mutation and journal each old target before
    # replacing it. The installer's existing rollback consumes this same file.
    File.open(output_file, 'a') do |journal|
      replacements.each do |name, path, target, previous|
        if previous
          journal.puts([name, previous].join("\t"))
          journal.flush
        end
        File.unlink(path) if previous
        File.symlink(target, path)
      end
    end
  else
    raise 'invalid installation state operation'
  end
rescue SystemCallError, RuntimeError, ArgumentError => error
  warn "php-darwin: installation state: #{error.message}"
  exit 1
end
PHP_DARWIN_INSTALL_STATE_RUBY
