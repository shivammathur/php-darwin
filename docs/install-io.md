# Installer I/O and network measurements

Measured on 2026-09-14 UTC (2026-09-15 in India). Changes are limited to
php-darwin. Keep compression level **19** and native `tar`: controlled downloads
and extraction did not show a consistent advantage from level 22 or a piped
Zstandard decoder. Consistent sub-10-second installation is still not achieved
for every legacy PHP version on Intel runners.

## Changes

- Read the exact version from the literal `php-config` assignment. Default
  installation validation starts **zero PHP processes**. Authenticated archive
  hashes, metadata, dependency receipts, link checks and nonempty extension
  checks remain mandatory. Release QA still loads PHP and every cached extension;
  `PHP_DARWIN_VERIFY_RUNTIME=true` enables those probes during installation.
- Batch existing-keg planning and opt-link receipt updates using the selected
  portable Ruby. Validate all records before mutation and retain the rollback
  journal, rather than repeatedly scanning files and spawning commands per keg.
- Exclude backed-up PEAR/config paths from extraction, since these files would
  otherwise immediately be discarded and replaced by the preserved originals.
- Compare tap ancestry locally. Incomplete shallow history uses the incoming
  snapshot temporarily and preserves the installed tap without an API request.
- Stop downloads at HTTP error headers, allowing immediate R2 fallback without
  first reading a slow error body. Transport/HTTP classification and retired
  manifest handling remain covered by tests. Keep GitHub as the primary origin.

No payload rebuild or setup-php change is required.

## Published installer verification

[Publication passed for all 13 PHP releases](https://github.com/shivammathur/php-darwin/actions/runs/34888578478),
covering PHP 5.6 through 8.6. GitHub and R2 installer bytes were checked against
source commit `20cb965`; existing payload archives were reused.

[All 14 live installations passed](https://github.com/shivammathur/test-setup-php/actions/runs/34888637054)
(plus the publication gate). These use normal `setup-php@develop` downloads with
no installer substitution and no archive/manifest prefetch before installation.
Every job compares the executed installer with the source-generated release
installer and verifies cache provenance, native Homebrew trust, PHP and each
cached extension after the timed action. `tools: none` excludes Composer and tools.

| Runner | PHP 7.4 action | PHP 8.6 action |
|---|---:|---:|
| macos-14 | 4 s | 5 s |
| macos-15 | 9 s | 5 s |
| macos-26 | 6 s | 4 s |
| macos-latest | 6 s | 4 s |
| macos-15-intel | 12 s | 6 s |
| macos-26-intel | 10 s | 7 s |
| xcode-27 | 5 s | 3 s |

PHP 8.6 finished below 10 seconds on every runner in this live sample (3–7 seconds).
PHP 7.4 took 4–12 seconds. These are single live samples; the repeated comparison
below captures the larger Intel variance and does not support a universal sub-10s
guarantee. Main-branch [source CI also passed](https://github.com/shivammathur/php-darwin/actions/runs/34888572656).

## Complete action before and after

[All 84 jobs passed](https://github.com/shivammathur/test-setup-php/actions/runs/34886166287).
Three fresh jobs per runner/version/implementation, using actual
`setup-php@develop` at `9af3b52286fbc7a3f8e1fdcc34643ab10bcc7e0f`,
`tools: none`, and `update: true`. Composer is excluded. These times are not
directly comparable to the earlier report's action times that include Composer.

Before is `318ac4a`; after is `ccd1e65`. A test wrapper performs the real bootstrap
download and substitutes the generated candidate. Every job confirms the executed
installer byte-for-byte, then checks cache provenance, Homebrew trust, PHP and
every cached extension. PHP archives are neither pre-downloaded nor pre-extracted.
All jobs made exactly **one archive request** and used identical immutable archive
checksums on both sides, for each PHP version and architecture.

Median seconds, with the full range in parentheses; GitHub step timestamps have
one-second resolution. Normal action output suppresses installer phase records,
so these are complete action times, not per-phase measurements.

| Runner | PHP | Before | After |
|---|---|---:|---:|
| macos-14 | 7.4 | 5 (5–5) | 5 (5–6) |
| macos-14 | 8.6 | 5 (4–6) | 4 (4–4) |
| macos-15 | 7.4 | 7 (7–9) | 7 (7–7) |
| macos-15 | 8.6 | 6 (6–7) | 6 (5–7) |
| macos-26 | 7.4 | 12 (11–12) | 7 (6–8) |
| macos-26 | 8.6 | 6 (6–7) | 6 (5–9) |
| macos-latest | 7.4 | 8 (6–12) | 6 (5–9) |
| macos-latest | 8.6 | 6 (5–7) | 5 (5–6) |
| macos-15-intel | 7.4 | 21 (16–25) | 11 (8–12) |
| macos-15-intel | 8.6 | 7 (5–13) | 11 (8–11) |
| macos-26-intel | 7.4 | 10 (9–12) | 11 (8–18) |
| macos-26-intel | 8.6 | 10 (8–11) | 8 (5–10) |
| xcode-27 | 7.4 | 7 (6–7) | 6 (6–6) |
| xcode-27 | 8.6 | 5 (5–8) | 4 (3–4) |

After-change ARM jobs all finished in 3–9 seconds; Intel jobs ranged from 5–18
seconds. Results are mixed on Intel: PHP 7.4/macOS 15 improved from a 21-second
median to 11 seconds, while PHP 8.6 on that runner went from 7 to 11 seconds.
Independent fresh runners expose network and disk variance; this is not evidence
of a guaranteed per-job speedup. No after-change sample exceeded 20 seconds.

## Remaining Intel cost

[All 24 direct installer profiles passed](https://github.com/shivammathur/test-setup-php/actions/runs/34887131077):
macOS 15/26 Intel, PHP 5.6/7.4/8.6, GitHub/R2-first, two fresh samples each.
These use the final executable at `2662310`, with timing enabled and no shell
tracing. Manifest preparation, setup-php bootstrap and tools are outside timing.
Per-operation times overlap phase records and must not be added to them.

Static `runtime.verify` took a median 30 ms, with a maximum of 45 ms. Batched opt
receipts took 66–167 ms. Downloads and extraction dominate the remaining tails:
the slower PHP 5.6/GitHub sample on macOS 15 Intel took 15.281 seconds, including
3.877 seconds in fetch and 9.191 seconds extracting. PHP 8.6 on the same runner
and origin took 3.712 and 7.951 seconds, with extraction at 1.119 and 5.063 seconds.
R2-first did not provide a consistent improvement, so origin ordering is unchanged.

Removing dictionaries or other bundled runtime/development files would change
downstream functionality. This change preserves the payload and concentrates on
avoiding repeated processes, requests and writes.

## Level 19 versus 22, including network

[All 12 benchmark jobs passed](https://github.com/shivammathur/test-setup-php/actions/runs/34887236547)
(plus a release-readiness gate): **144 observations**, six samples per
runner/version/level. Each runner has two fresh jobs and three alternating repeats.
Both compression levels were explicitly encoded from the same verified raw tar;
older published archives are not assumed to be level 19 from today's build config.
Every downloaded compressed SHA and the prepared raw payload SHA were verified.

| PHP | Architecture | Level 19 bytes | Level 22 bytes | Reduction |
|---|---|---:|---:|---:|
| 7.4 | arm64 | 147,927,652 | 147,489,122 | 0.30% |
| 7.4 | x86_64 | 147,907,605 | 147,394,593 | 0.35% |
| 8.6 | arm64 | 57,639,746 | 57,120,134 | 0.90% |
| 8.6 | x86_64 | 56,633,585 | 56,114,463 | 0.92% |

Median seconds. Download includes redirects/TLS; total includes download, SHA-256
and full raw extraction. This extraction includes every keg and therefore differs
from the installer, which excludes already installed kegs and preserved files.
Component medians do not necessarily sum to the median total.

| Runner | PHP | Download 19 / 22 | Extract 19 / 22 | Total 19 / 22 |
|---|---|---:|---:|---:|
| macos-14 | 7.4 | 1.215 / 1.321 | 1.976 / 2.082 | 3.446 / 3.506 |
| macos-14 | 8.6 | 0.644 / 0.694 | 1.181 / 1.244 | 1.839 / 1.892 |
| macos-15 | 7.4 | 1.280 / 1.337 | 1.778 / 1.622 | 3.146 / 3.057 |
| macos-15 | 8.6 | 0.720 / 0.715 | 0.863 / 0.897 | 1.691 / 1.667 |
| macos-26 | 7.4 | 1.540 / 1.608 | 2.425 / 2.564 | 4.057 / 4.366 |
| macos-26 | 8.6 | 0.835 / 0.854 | 1.612 / 1.648 | 2.691 / 2.590 |
| macos-15-intel | 7.4 | 1.278 / 1.048 | 4.504 / 4.119 | 6.113 / 5.740 |
| macos-15-intel | 8.6 | 0.633 / 0.651 | 2.866 / 2.763 | 3.670 / 3.579 |
| macos-26-intel | 7.4 | 1.363 / 2.015 | 5.063 / 4.718 | 6.899 / 8.038 |
| macos-26-intel | 8.6 | 0.554 / 0.605 | 3.136 / 3.366 | 4.232 / 4.433 |
| xcode-27 | 7.4 | 1.192 / 2.227 | 1.669 / 1.710 | 2.942 / 4.017 |
| xcode-27 | 8.6 | 0.854 / 0.898 | 0.904 / 0.958 | 1.747 / 1.905 |

Level 22's 0.30–0.92% reduction did not consistently offset its extraction or
transfer variation. These observations do not establish a universal winner, but
provide no reason to reverse the level-19 setting and its lower build cost.
Keep upload-artifact compression at 0 for these already compressed files.

Verified benchmark archives and sample metadata are retained in the
[v3 benchmark release](https://github.com/shivammathur/test-setup-php/releases/tag/install-compression-20260915-v3).
Earlier harness runs are excluded: an immutable release was published before
upload, older archives were initially mislabelled by current configuration, and
a script named `compression.py` shadowed Python 3.14's standard library. The final
measurement uses explicit encodings and `bench_network.py`; all jobs passed.

## Native versus piped extraction

[All four runner jobs passed](https://github.com/shivammathur/test-setup-php/actions/runs/34887515134),
with **72 extractions**. Each PHP archive is downloaded and verified once, then
extracted three times with each method in alternating order. Full raw extraction
is measured; neither downloads nor installer state changes are included.

| Runner | PHP | Native median | Pipe median |
|---|---|---:|---:|
| macos-14 | 5.6 | 2.194 s | 2.443 s |
| macos-14 | 7.4 | 1.763 s | 2.269 s |
| macos-14 | 8.6 | 1.089 s | 1.618 s |
| macos-15 | 5.6 | 1.714 s | 1.627 s |
| macos-15 | 7.4 | 1.464 s | 1.497 s |
| macos-15 | 8.6 | 0.820 s | 0.955 s |
| macos-15-intel | 5.6 | 4.153 s | 4.457 s |
| macos-15-intel | 7.4 | 3.702 s | 4.062 s |
| macos-15-intel | 8.6 | 2.849 s | 3.084 s |
| macos-26-intel | 5.6 | 5.343 s | 5.250 s |
| macos-26-intel | 7.4 | 3.982 s | 5.381 s |
| macos-26-intel | 8.6 | 2.942 s | 3.390 s |

Native `tar` won 10 of 12 median comparisons. The two piped wins were less than
0.1 seconds. Keep native extraction; an external decoder adds no consistent gain.

## Recovery and compatibility

- [Four native tests](https://github.com/shivammathur/test-setup-php/actions/runs/34886166173)
  passed Homebrew alias parity and exact prefix symlink restoration after failure
  on ARM and Intel.
- [Six final-installer tests](https://github.com/shivammathur/test-setup-php/actions/runs/34886395775)
  passed preserved PEAR inode/permissions and config bytes through reinstall and
  rollback, bounded slow-HTTP-error recovery, real GitHub 404 to R2 fallback,
  optional runtime probes, and PHP 5.6/8.4 on macOS 14 ARM and macOS 15 Intel.
- [Source validation](https://github.com/shivammathur/php-darwin/actions/runs/34887297809)
  and `bash scripts/validate.sh` passed, including eight new state/static-check
  tests and generated-installer freshness. Invalid/missing/duplicate versions,
  unsafe records, symlinked/empty modules, no-default-PHP execution and failure
  propagation are explicitly exercised.

[Raw observations, phase records, archive hashes and individual job links](install-io-results.json)
retain every valid sample, including regressions and outliers.
