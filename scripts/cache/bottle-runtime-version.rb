# Raw OCI receipts from older bottles have version/revision but no pkg_version.
# Normalize both formats before Homebrew compares the required runtime version.
module BottleRuntimeVersion
  def self.package_version(dependency)
    value = dependency["pkg_version"]
    unless value.nil?
      raise "Invalid bottle runtime package version" unless value.is_a?(String) && !value.empty?

      return value
    end

    version = dependency["version"]
    revision = dependency["revision"] || 0
    raise "Missing bottle runtime version" unless version.is_a?(String) && !version.empty?
    raise "Invalid bottle runtime revision" unless revision.to_s.match?(/\A[0-9]+\z/)

    revision = revision.to_i
    revision.positive? ? "#{version}_#{revision}" : version
  end
end
