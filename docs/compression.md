# Compression measurements

Measured on 2026-09-14 with Zstandard 1.5.7 on an Apple M3 Max running macOS 27.
Two repetitions per level, two compression threads, `--long=27`, using identical
uncompressed tar payloads from actual PHP 8.6 and 7.4 ARM64 debug/ZTS artifacts.
Every output was decompressed and its payload SHA-256 matched the input. Archive
size includes Zstd framing. MB below are decimal; time is the mean of both runs.

| PHP | Level | Compression | Archive size |
|---|---:|---:|---:|
| 8.6 | 15 | 10.9 s | 71.21 MB |
| 8.6 | 17 | 25.6 s | 66.92 MB |
| 8.6 | 19 | 45.5 s | 60.91 MB |
| 8.6 | 22 | 113.7 s | 59.90 MB |
| 7.4 | 15 | 30.4 s | 167.80 MB |
| 7.4 | 17 | 52.6 s | 155.35 MB |
| 7.4 | 19 | 113.0 s | 147.78 MB |
| 7.4 | 22 | 357.4 s | 147.30 MB |

Level **19** retains the useful size savings without the cost of level 22:

- PHP 8.6: 60.0% less compression time, 1.69% larger archive.
- PHP 7.4: 68.4% less compression time, 0.33% larger archive.

All samples remained below the 180 MB archive limit. These are local compression
measurements, not complete workflow speedups. CI uses `-T0` and includes staging,
metadata, transfers, and compatibility tests. Artifact upload uses compression
level **0**, since these files are already compressed.

Raw repetitions and payload sizes are in [compression-results.json](compression-results.json).
The input artifacts came from [PHP 8.6 run 34800543624](https://github.com/shivammathur/php-darwin/actions/runs/34800543624)
and [PHP 7.4 run 34797927757](https://github.com/shivammathur/php-darwin/actions/runs/34797927757).

To repeat with downloaded architecture artifact ZIPs (Python 3.11+, Zstd):

```sh
python3 scripts/benchmark-compression.py \
  --sample /path/to/php-8.6-arm64.zip php_8.6-zts-debug+darwin_arm64.tar.zst \
  --sample /path/to/php-7.4-arm64.zip php_7.4-zts-debug+darwin_arm64.tar.zst \
  --levels 15 17 19 22 --threads 2 --repeats 2 \
  --output /tmp/php-darwin-compression.json
```

The benchmark verifies the downloaded archive checksums before measuring and
uses temporary files; it does not install packages or modify Homebrew.

## Extraction on GitHub runners

The [native extraction comparison](https://github.com/shivammathur/test-setup-php/actions/runs/34869425325)
recompressed identical PHP 8.6 release/NTS tar contents at levels 4, 19, and 22,
then extracted each output three times on macOS 15 ARM64 and Intel. Every input
archive and decompressed payload was checked with SHA-256. Times below are the
median raw `bsdtar` extraction time; they exclude downloads, Homebrew state
changes, validation, and Composer.

| Runner | Level 4 | Level 19 | Level 22 |
|---|---:|---:|---:|
| macOS 15 ARM64 | 0.98 s | 1.27 s | 1.38 s |
| macOS 15 Intel | 4.40 s | 3.80 s | 4.30 s |

Level 19 did not slow extraction relative to level 22 in these measurements.
Level 4 grew the archives from 57.64 to 78.00 MB on ARM64 and from 56.63 to
78.02 MB on Intel, without a consistent extraction improvement across both
architectures. Keep production compression at level 19 and artifact upload at
level 0. The external `zstd | tar` path also showed no consistent advantage.

Raw repetitions, input checksums, and job links are preserved in
[extraction-results.json](extraction-results.json). Reproduce with:

```sh
python3 scripts/benchmark-extraction.py /path/to/php.tar.zst SHA256 \
  --levels 4 19 22 --repeats 3 --output /tmp/extraction.json
```

Only the compression jobs and direct recovery tests from that workflow are
relevant here. Its action timing jobs accidentally used the published installer
for both labels and must not be treated as a before/after speed comparison.
