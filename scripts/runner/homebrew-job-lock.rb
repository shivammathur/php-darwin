require "json"
require "fileutils"
require "open3"

# Homebrew's formula locks do not protect tap checkout/cleanup across jobs.
# The worker owns this lease until it exits, after post-actions and cleanup.
class HomebrewJobLock
  IDENTITY = %w[pid started executable].freeze

  def self.processes
    output, status = Open3.capture2({ "LC_ALL" => "C", "TZ" => "UTC" },
                                  "/bin/ps", "-ww", "-axo", "pid=,ppid=,lstart=,comm=")
    raise "Cannot inspect runner workers" unless status.success?

    output.lines.map do |line|
      match = line.strip.match(/\A(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)\z/)
      next unless match

      { "pid" => match[1].to_i, "ppid" => match[2].to_i,
        "started" => match[3], "executable" => match[4] }
    end.compact
  end

  def self.current_worker(rows, pid)
    seen = []
    while pid > 1 && !seen.include?(pid)
      seen << pid
      row = rows.find { |entry| entry["pid"] == pid }
      break unless row
      return row if File.basename(row["executable"]) == "Runner.Worker"

      pid = row["ppid"]
    end
    raise "Cannot identify the current Runner.Worker"
  end

  def initialize(directory, worker, snapshot: nil)
    @directory, @worker = directory, worker
    @snapshot = snapshot || -> { self.class.processes.select { |row| File.basename(row["executable"]) == "Runner.Worker" } }
    FileUtils.mkdir_p(directory)
  end

  def same?(a, b)
    !!(a && b && IDENTITY.all? { |key| a[key] == b[key] })
  end

  def acquire
    File.open(File.join(@directory, "guard"), File::RDWR | File::CREAT, 0600) do |guard|
      guard.flock(File::LOCK_EX)
      rows = @snapshot.call
      raise "Current runner worker exited" unless rows.any? { |row| same?(row, @worker) }

      path = File.join(@directory, "state.json")
      state = File.exist?(path) ? JSON.parse(File.read(path)) : { "waiting" => [] }
      state["owner"] = nil unless rows.any? { |row| same?(row, state["owner"]) }
      state.fetch("waiting").select! { |entry| rows.any? { |row| same?(row, entry) } }
      state["waiting"] << @worker unless state["waiting"].any? { |entry| same?(entry, @worker) }

      # During rollout, old jobs have no hook. Let them finish before granting
      # a lease; registered waiters are blocked before any workflow steps.
      unregistered = rows.reject { |row| state["waiting"].any? { |entry| same?(row, entry) } }
      if !state["owner"] && unregistered.empty?
        state["owner"] = state["waiting"].first
      end
      temporary = "#{path}.#{Process.pid}"
      File.open(temporary, "w", 0600) { |file| file.write(JSON.generate(state)); file.flush; file.fsync }
      File.rename(temporary, path)
      [same?(state["owner"], @worker), unregistered.length]
    end
  end

  def wait(timeout: 21_600, interval: 2, output: $stdout)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    next_report = 0
    loop do
      acquired, legacy = acquire
      if acquired
        output.puts "Acquired exclusive Homebrew access for this runner job."
        return
      end
      now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      raise "Timed out waiting for exclusive Homebrew access" if now >= deadline
      if now >= next_report
        output.puts "Waiting for another runner job to release Homebrew (#{legacy} jobs without a hook)."
        output.flush
        next_report = now + 60
      end
      sleep interval
    end
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    worker = HomebrewJobLock.current_worker(HomebrewJobLock.processes, Process.pid)
    HomebrewJobLock.new("/Users/Shared/homebrew-ci-job-lock", worker).wait
  rescue StandardError => e
    warn "Homebrew job lock: #{e.message}"
    exit 1
  end
end
