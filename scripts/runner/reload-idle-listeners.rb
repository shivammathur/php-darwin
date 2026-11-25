require_relative "homebrew-job-lock"

# Reload only listeners that were running when this maintenance began. Workers,
# offline runners and VM/autoscaler state are never changed by this script.
controller = "/Library/Scripts/ci-autoscaler/ci-runner-terminals"
abort "Runner launcher is unavailable" unless File.executable?(controller)
listeners = HomebrewJobLock.processes.select do |row|
  File.basename(row["executable"]) == "Runner.Listener" &&
    File.dirname(File.dirname(row["executable"])).start_with?("#{Dir.home}/")
end
deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 3600
until listeners.empty?
  abort "Timed out waiting for idle runner listeners" if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
  listeners.delete_if do |listener|
    rows = HomebrewJobLock.processes
    current = rows.find { |row| HomebrewJobLock::IDENTITY.all? { |key| row[key] == listener[key] } }
    next true unless current
    worker_path = File.join(File.dirname(listener["executable"]), "Runner.Worker")
    next false if rows.any? { |row| row["executable"] == worker_path }

    repository = File.basename(File.dirname(File.dirname(listener["executable"])))
    puts "Reloading idle #{repository} listener."
    $stdout.flush
    Process.kill("INT", listener["pid"])
    100.times do
      break unless HomebrewJobLock.processes.any? { |row| row["pid"] == listener["pid"] }
      sleep 0.2
    end
    abort "Listener did not exit: #{repository}" if HomebrewJobLock.processes.any? { |row| row["pid"] == listener["pid"] }
    # Let the service release the launcher's own lock before reopening it.
    sleep 1
    abort "Could not reopen #{repository}" unless system(controller, "open", repository)
    true
  end
  sleep 5 unless listeners.empty?
end
puts "Finished reloading idle runner listeners."
