# Compare Ruby source without evaluating tap code. Keep the literal spelling
# where Ripper's syntax tree alone loses Ruby semantics (e.g. '\n' vs "\n").
require 'digest'
require 'json'
require 'ripper'

module RecipeSyntax
  module_function

  PLATFORMS = JSON.parse(File.read(File.expand_path('../../conf/platforms.json', __dir__)))
  MACOS = %w[tiger leopard snow_leopard lion mountain_lion mavericks yosemite el_capitan sierra high_sierra mojave catalina
             big_sur monterey ventura sonoma sequoia tahoe golden_gate].zip(
    (4..15).map { |minor| 10 + minor / 100.0 } + [11, 12, 13, 14, 15, 26, 27]
  ).to_h.freeze

  def string_value(node)
    return unless node.is_a?(Array) && node[0] == :string_literal
    content = node[1]
    content[1][1] if content.length == 2 && content[1][0] == :@tstring_content
  end

  def symbol_label(key)
    if key[0] == :symbol_literal && key.dig(1, 0) == :symbol && key.dig(1, 1, 0) == :@ident
      [:@label, key[1][1][1] + ':', *key[1][1].drop(2)]
    else
      key
    end
  end

  def index_digest?(argument)
    string_value(argument).to_s.match?(/\A[0-9a-f]{64}\z/)
  end

  def bottle(node)
    _, call, block = node
    return node unless call == [:method_add_arg, [:fcall, [:@ident, 'bottle']], []]
    return node unless block[0] == :do_block && !block[1] && block[2][0] == :bodystmt && block[2].drop(2).all?(&:nil?)

    common = []
    bottles = {}
    block[2][1].each do |statement|
      next if statement == [:void_stmt]
      type, function, args = statement
      return node unless type == :method_add_arg && function[0] == :fcall && args && args[0] == :args_add_block &&
                         args[1].length == 1 && args[2] == false
      argument = args[1][0]
      case function.dig(1, 1)
      when 'root_url'
        return node unless string_value(argument)
        common << statement
      when 'rebuild'
        return node unless argument[0] == :@int
        common << statement
      when 'manifest_sha256'
        # The OCI index covers every platform. The selected bottle's own digest
        # below identifies the bytes that this cache actually consumes.
        return node unless index_digest?(argument)
      when 'sha256'
        return node unless argument[0] == :bare_assoc_hash
        pairs = argument[1].dup
        if pairs.length == 2 && pairs.first[1] == [:@label, 'cellar:']
          cellar = pairs.shift[2]
          return node unless string_value(cellar) || cellar.dig(0) == :symbol_literal
        end
        return node unless pairs.length == 1 && pairs[0][0] == :assoc_new && pairs[0][1][0] == :@label &&
                           string_value(pairs[0][2]).to_s.match?(/\A[0-9a-f]{64}\z/)
        tag = pairs[0][1][1].chomp(':').sub(/\Ax86_64_/, '')
        return node if bottles.key?(tag)
        bottles[tag] = statement
      else
        return node
      end
    end
    selected = PLATFORMS.map do |arch, platform|
      fallback = bottles.keys.find do |tag|
        (tag.start_with?('arm64_') == (arch == 'arm64')) &&
          MACOS.fetch(tag.sub(/\Aarm64_/, ''), 1000) <= platform.fetch('minimum_macos')
      end
      bottle = bottles[platform.fetch('platform_key')] || bottles['all'] || bottles[fallback]
      [arch, common, bottle] if bottle
    end.compact
    [:platform_bottles, selected]
  end

  def tree(node, platforms)
    return node unless node.is_a?(Array)
    tag, *args = node
    return [tag, args.first] if tag.is_a?(Symbol) && tag.to_s.start_with?('@')

    # Bottle selection applies to declarations in the formula body. A method
    # or conditional can call arbitrary Ruby with the same name.
    nested_platforms = platforms && (!tag.is_a?(Symbol) || %i[program class bodystmt].include?(tag))
    children = node.map { |child| tree(child, nested_platforms) }
    case tag
    when :paren
      # Ripper 2.x reports one expression directly, newer versions wrap it in
      # a statement list. The expression tree already captures its precedence.
      contents = children[1]
      return contents if contents.is_a?(Array) && contents[0].is_a?(Symbol)
      return contents[0] if contents.is_a?(Array) && contents.size == 1
      children
    when :assoc_new
      children[1] = symbol_label(children[1])
      children
    when :method_add_block
      platforms ? bottle(children) : children
    when :command
      [:method_add_arg, [:fcall, children[1]], children[2]]
    when :command_call
      [:method_add_arg, [:call, *children[1..3]], children[4]]
    when :method_add_arg
      arguments = children[2]
      [tag, children[1], arguments.first == :arg_paren ? arguments[1] : arguments]
    when :def, :defs
      # A guard returning the method's final alternative is equivalent to a
      # terminal ternary. Never fold a return inside a block or an ensure.
      body = children.last
      if body && body[0] == :bodystmt && body.drop(2).all?(&:nil?)
        statements = body[1]
        guard, fallback = statements.last(2)
        if fallback && guard.is_a?(Array) && guard[0] == :if_mod && guard.dig(2, 0) == :return
          values = guard.dig(2, 1)
          if values && values[0] == :args_add_block && values[1].length == 1 && values[2] == false
            body[1] = statements[0...-2] + [[:ifop, guard[1], values[1][0], fallback]]
          end
        end
      end
      children
    else
      children
    end
  end

  def digest(source, platforms: false)
    ast = Ripper.sexp(source) if source.valid_encoding?
    return Digest::SHA256.hexdigest("raw\0" + source) unless ast

    # Positions, formatting and ordinary comments are absent from the tree.
    # Preserve encodings, magic comments, line-sensitive code and inline patches.
    tokens = Ripper.lex(source)
    special = []
    delimiters = []
    heredocs = []
    saw_code = false
    tokens.each do |(line, _), event, text, _state|
      case event
      when :on_comment
        if text.match?(/(?:coding|encoding)\s*[:=]/i)
          special << [line, source.start_with?('#!'), text.strip]
        elsif text.match?(/(?:frozen_string_literal|shareable_constant_value|warn_indent)\s*[:=]/i)
          special << [saw_code, text.strip]
        end
      when :on_kw
        special << [text, line] if text == '__LINE__'
      when :on___end__
        special << source.lines.drop(line).join
      when :on_heredoc_beg
        heredocs << text
      when :on_heredoc_end
        heredocs.shift
      when :on_words_beg, :on_qwords_beg, :on_symbols_beg, :on_qsymbols_beg
        special << event
        delimiters << text
      when :on_tstring_beg, :on_regexp_beg, :on_backtick
        delimiters << text
      when :on_symbeg
        delimiters << text unless text == ':'
      when :on_tstring_end, :on_regexp_end, :on_label_end
        delimiters.pop
      when :on_tstring_content
        special << [delimiters.last, heredocs.first, text] if text.include?('\\')
      end
      saw_code = true unless %i[on_comment on_sp on_nl on_ignored_nl on_embdoc on_embdoc_beg on_embdoc_end].include?(event)
    end
    Digest::SHA256.hexdigest(JSON.generate([tree(ast, platforms), special], max_nesting: false))
  end
end

puts RecipeSyntax.digest(STDIN.read, platforms: ARGV.first == 'platforms') if $PROGRAM_NAME == __FILE__
