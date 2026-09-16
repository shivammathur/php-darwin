# Maintenance

Configuration lives in `conf/`; supported PHP versions and variants are shared by every component.

Runner preparation pins Homebrew sources, preserves the Actions Node runtime, and recovers only proven orphaned builds.

Build PHP archives with `scripts/build/build.sh`. Packages include runtime dependencies, coverage modules, development files, licenses and the pinned PHP tap.

Local tests use temporary fixtures. Native tests run on the configured macOS Actions runners.
