# Fingerprint dependency declarations without invalidating on bottle rebuilds or
# software-only releases. Shared Ruby helpers are fingerprinted by the caller.
require 'json'
require 'ripper'

def clean(node)
  return node unless node.is_a?(Array)
  return [node[0], node[1]] if node[0].is_a?(Symbol) && node[0].to_s.start_with?('@')

  node.map { |child| clean(child) }
end

def declarations(node, guards = [], result = [])
  return result unless node.is_a?(Array)

  if node[0] == :method_add_arg && %w[depends_on uses_from_macos].include?(node.dig(1, 1, 1))
    result << [clean(guards), clean(node)]
    return result
  end
  case node[0]
  when :if, :unless, :if_mod, :unless_mod, :elsif, :case, :when, :while, :until, :for
    node.drop(2).each_with_index { |child, i| declarations(child, guards + [[node[0], clean(node[1]), i]], result) }
  when :method_add_block
    declarations(node[2], guards + [clean(node[1])], result)
  else
    node.each { |child| declarations(child, guards, result) if child.is_a?(Array) }
  end
  result
end

puts JSON.generate(JSON.parse(STDIN.read).map do |file|
  ast = Ripper.sexp(File.read(file))
  abort "Cannot parse dependency declarations: #{file}" unless ast
  # Command form is the usual Homebrew DSL; normalize to method_add_arg above.
  normalize = lambda do |node|
    next node unless node.is_a?(Array)
    node = [:method_add_arg, [:fcall, node[1]], node[2]] if node[0] == :command
    node.map { |child| child.is_a?(Array) ? normalize.call(child) : child }
  end
  result = declarations(normalize.call(ast))
  # Dynamic dependency arguments may depend on constants or methods elsewhere
  # in the formula. Fail closed instead of missing such a dependency update.
  dynamic = result.any? { |entry| entry.last.flatten.any? { |token| %i[string_embexpr var_ref const_ref vcall call].include?(token) } }
  result << ["dynamic_dependency_context", clean(ast)] if dynamic
  [file, result]
end.to_h)
