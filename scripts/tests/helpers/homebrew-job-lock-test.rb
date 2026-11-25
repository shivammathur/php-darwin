require "minitest/autorun"
require "tmpdir"
require "stringio"
require_relative "../../runner/homebrew-job-lock"

class HomebrewJobLockTest < Minitest::Test
  def setup
    @directory = Dir.mktmpdir("homebrew-job-lock-")
    @first = { "pid" => 101, "ppid" => 1, "started" => "first", "executable" => "/runner/bin/Runner.Worker" }
    @second = @first.merge("pid" => 102, "started" => "second")
    @rows = [@first]
  end

  def teardown
    FileUtils.remove_entry(@directory)
  end

  def lock(worker)
    HomebrewJobLock.new(@directory, worker, snapshot: -> { @rows })
  end

  def test_owner_excludes_other_workers_until_it_exits
    assert_equal [true, 0], lock(@first).acquire
    @rows << @second
    assert_equal [false, 0], lock(@second).acquire
    assert_equal [true, 0], lock(@first).acquire
    @rows.delete(@first)
    assert_equal [true, 0], lock(@second).acquire
  end

  def test_jobs_without_hooks_drain_before_registered_waiters
    @rows << @second
    assert_equal [false, 1], lock(@first).acquire
    # Registering the second waiter must not deadlock both jobs.
    assert_equal [false, 0], lock(@second).acquire
    assert_equal [true, 0], lock(@first).acquire
  end

  def test_dead_owner_pid_reuse_does_not_keep_its_lease
    assert lock(@first).acquire.first
    replacement = @first.merge("started" => "reused PID")
    @rows = [replacement]
    assert lock(replacement).acquire.first
  end

  def test_corrupt_state_stops_before_any_workflow_steps
    File.write(File.join(@directory, "state.json"), "broken")
    assert_raises(JSON::ParserError) { lock(@first).acquire }
  end

  def test_wait_has_a_bound
    @rows << @second
    assert_raises(RuntimeError) { lock(@first).wait(timeout: 0, output: StringIO.new) }
  end

  def test_finds_only_the_current_worker_ancestor
    child = { "pid" => 999, "ppid" => 101, "started" => "child", "executable" => "/usr/bin/ruby" }
    assert_equal @first, HomebrewJobLock.current_worker([child, @first, @second], 999)
    assert_raises(RuntimeError) { HomebrewJobLock.current_worker([child, @second], 999) }
    assert HomebrewJobLock.processes.any? { |row| row["pid"] == Process.pid }
  end

  def test_separate_processes_cannot_claim_the_same_lease
    # Each process opens its own guard descriptor, exercising the kernel lock.
    workers = (1..12).map { |index| @first.merge("pid" => 1000 + index, "started" => index.to_s) }
    children = workers.map do |worker|
      fork do
        begin
          instance = HomebrewJobLock.new(@directory, worker, snapshot: -> { workers })
          instance.acquire
          200.times do
            break if JSON.parse(File.read(File.join(@directory, "state.json")))["waiting"].length == workers.length
            sleep 0.01
          end
          acquired = instance.acquire.first
          File.write(File.join(@directory, "result-#{worker['pid']}"), acquired.to_s)
          exit! 0
        rescue StandardError
          exit! 1
        end
      end
    end
    children.each { |pid| Process.wait(pid); assert $?.success? }
    winners = Dir.glob(File.join(@directory, "result-*")).count { |file| File.read(file) == "true" }
    assert_equal 1, winners
    state = JSON.parse(File.read(File.join(@directory, "state.json")))
    assert_equal 12, state["waiting"].length
  end
end
