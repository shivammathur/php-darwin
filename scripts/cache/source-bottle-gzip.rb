require "zlib"
require "fileutils"
require "pathname"

# Ruby's streaming compressor can raise Zlib::BufError on an intact tar. Keep
# Homebrew's normal compression first, then use the system compressor for that
# specific failure. All other errors still abort packaging.
module PhpDarwinBottleGzip
  def compress_with_options(path, mtime: ENV["SOURCE_DATE_EPOCH"].to_i,
                            orig_name: File.basename(path), output: "#{path}.gz")
    super
  rescue Zlib::BufError
    warn "Ruby gzip buffer error; compressing the completed bottle with system gzip"
    begin
      File.open(output, "wb") do |target|
        IO.popen(["/usr/bin/gzip", "-n", "-c", path.to_s], "rb") do |source|
          header = source.read(10)
          raise "Invalid system gzip header" unless header&.byteslice(0, 4) == "\x1f\x8b\x08\x00".b
          # Preserve Homebrew's deterministic timestamp and original filename.
          header.setbyte(3, 8)
          header[4, 4] = [[mtime.to_i, 1].max].pack("V")
          target.write(header)
          target.write(orig_name.b.split("\0", 2).first + "\0")
          IO.copy_stream(source, target)
        end
        raise "System gzip failed" unless $?.success?
      end
      FileUtils.rm_f(path)
      Pathname.new(output)
    rescue Exception
      FileUtils.rm_f(output)
      raise
    end
  end
end
