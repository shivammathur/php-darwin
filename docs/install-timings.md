# Installer timing measurements

The [follow-up I/O measurements](install-io.md) cover static `php-config`
validation, reduced filesystem/network work, repeated installs without Composer,
and controlled level-19/22 downloads. This page records the earlier comparison.

Measured on 2026-09-14 UTC using `shivammathur/setup-php@develop`. Every job
resolved develop to `9af3b52286fbc7a3f8e1fdcc34643ab10bcc7e0f`.

The [baseline](https://github.com/shivammathur/test-setup-php/actions/runs/34878530348)
adds timing only. The [optimized comparison](https://github.com/shivammathur/test-setup-php/actions/runs/34880160197)
uses the same published PHP archives with the updated installer. Both include
real bootstrap and archive downloads; a test wrapper replaces the downloaded
bootstrap with the generated candidate, and each job compares its bytes to prove
that setup-php executed that candidate. Nothing is pre-extracted. Default
Composer installation is included in action durations.

`verbose: vvv` enables monotonic phase and operation records. Phase time follows
the main process; background operation times overlap and must not be added to
phase times. The installer total includes cleanup but excludes setup-php's
bootstrap download and Composer. The normal jobs have timing disabled and report
complete action duration at GitHub's one-second resolution.

## Published installer verification

The [final live run](https://github.com/shivammathur/test-setup-php/actions/runs/34881287775)
used the published installer directly with `setup-php@develop`, without the
candidate replacement wrapper. All 18 jobs passed: seven normal installations,
seven `vvv` installations, and four GitHub-to-R2 recovery checks covering HTTP
404 and checksum mismatches on ARM and Intel.

| Runner | Published PHP 8.6 complete action |
|---|---:|
| macos-14 | 5 s |
| macos-15 | 9 s |
| macos-26 | 8 s |
| macos-latest | 7 s |
| macos-15-intel | 13 s |
| macos-26-intel | 8 s |
| xcode-27 | 6 s |

Six of seven normal installs finished below 10 seconds. The macOS 15 Intel
normal job spent 9.49 seconds in the PHP stage and 3.79 seconds in Composer.
Its verbose companion measured 3.78 seconds in tar extraction and 1.26 seconds
in runtime verification; Ruby runtime selection took 0.15 seconds. The former
system-Ruby startup delay is removed, but runner and download variation still
prevent a consistent sub-10-second full action on every run.

## Findings and changes

- The [cold interpreter comparison](https://github.com/shivammathur/test-setup-php/actions/runs/34879867818)
  tested both execution orders on four runner types. First standard-library loads
  took 1.54–6.21 seconds with system Ruby, versus 0.066–0.149 seconds with
  Homebrew's installed portable Ruby. Helpers now use the installed portable
  runtime after a capability check, with system Ruby as the fallback.
- Resolving a tap through the full Homebrew command took 1–5 seconds. The
  installer now obtains the repository root through Homebrew's early shell
  return and constructs the standard tap path. Custom layouts keep the native
  fallback.
- Unversioned OpenSSL aliases caused native `brew unlink` calls lasting 2–4
  seconds on newer ARM runners. Owned aliases now use the same journal and
  locks as other removed links. Unusual aliases and info-index maintenance
  still use Homebrew.
- Archive extraction and downloads remain the largest costs for older PHP
  versions. The comparison uses unchanged published archives; see
  [compression measurements](compression.md) for the separate level comparison.

## Complete action times with verbosity disabled

These are individual runs, not guaranteed latency bounds. Runner load and
network conditions vary; the full data also includes cases that became slower.

| Runner | PHP 7.4 | PHP 8.6 |
|---|---:|---:|
| macos-14 | 6 s | 7 s |
| macos-15 | 10 s | 8 s |
| macos-26 | 8 s | 6 s |
| macos-latest | 7 s | 8 s |
| macos-15-intel | 16 s | 8 s |
| macos-26-intel | 12 s | 8 s |
| xcode-27 | 8 s | 7 s |

PHP 8.6 was below 10 seconds on every runner in this comparison matrix. Additional normal checks
measured PHP 5.6 at 13 seconds on ARM and 17 seconds on Intel, and PHP 8.4 at
9 seconds on both. The target is not yet met for every PHP version.

## Installer-only times with `verbose: vvv`

| Runner | PHP | Before | After |
|---|---|---:|---:|
| macos-14 | 7.4 | 5.16 s | 4.51 s |
| macos-14 | 8.6 | 3.40 s | 4.19 s |
| macos-15 | 7.4 | 7.05 s | 6.10 s |
| macos-15 | 8.6 | 11.79 s | 6.02 s |
| macos-26 | 7.4 | 8.63 s | 7.05 s |
| macos-26 | 8.6 | 7.11 s | 4.40 s |
| macos-latest | 7.4 | 11.14 s | 8.13 s |
| macos-latest | 8.6 | 8.82 s | 7.34 s |
| macos-15-intel | 7.4 | 19.72 s | 9.45 s |
| macos-15-intel | 8.6 | 8.67 s | 10.71 s |
| macos-26-intel | 7.4 | 9.03 s | 10.13 s |
| macos-26-intel | 8.6 | 17.07 s | 7.00 s |
| xcode-27 | 7.4 | 7.64 s | 5.54 s |
| xcode-27 | 8.6 | 7.04 s | 4.24 s |

All 32 installation jobs passed cache provenance and runtime checks. Four
[native recovery jobs](https://github.com/shivammathur/test-setup-php/actions/runs/34880159996)
compared alias unlinking against Homebrew and verified exact symlink and PHP
version restoration after an injected installer failure, on ARM and Intel.
The helper tests also pass with both system and portable Ruby.

[Raw timing records and job links](install-timing-results.json) preserve every
baseline and optimized sample, including all cold interpreter repetitions.
